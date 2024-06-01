"use strict";

const { workspace, Uri } = require("vscode");

class PrettyPrinter {
  #pattern = "";

  constructor(pattern) {
    this.#pattern = pattern;
  }

  get regexp() {
    return `(?<${this.name}>${this.#pattern})`;
  }

  get name() {
    return this.constructor.name;
  }

  prettify(_session, variable) {
    return variable;
  }

  children(_lib, variables) {
    return variables;
  }

  get literal() {
    return this instanceof LiteralPrinter;
  }

  get structured() {
    return this instanceof StructuredPrinter;
  }
}

class LiteralPrinter extends PrettyPrinter {
  constructor(pattern) {
    super(pattern);
    Object.defineProperty(this, 'children', {
      configurable: false,
      writable: false,
    });
  }
}

class StructuredPrinter extends PrettyPrinter {
  constructor(pattern) {
    super(pattern);
  }
}

class Reference {
  #reference;
  constructor(reference) {
    this.#reference = reference;
  }
}

class Variable {
  #variable;
  #session;
  constructor(session, variable) {
    this.#session = session;
    this.#variable = variable;
  }

  get value() {
    return this.#variable.value;
  }

  set value(value) {
    this.#variable.value = value;
  }

  get name() {
    return this.#variable.name;
  }

  get type() {
    return this.#variable.type;
  }

  hasChildren() {
    return this.#variable.variablesReference > 0;
  }

  async children() {
    if (!this.hasChildren()) {
      return [];
    }
    const args = { variablesReference: this.#variable.variablesReference };
    const request = {
      seq: 0xffffffff,
      command: "variables",
      type: "request",
      arguments: args,
    }

    const response = await this.#session.session.dbg.waitableSendRequest(request, args);
    return response.body.variables.map(v => new Variable(this.#session, v));
  }
}

class Printer {
  #regexp = / /;
  #printers = {};
  #interceptions = new Map();
  #session;
  #lib;

  static #createLib(session) {
    return { session }
  }
  constructor(session, regexp, printers) {
    console.log(regexp);
    this.#session = session;
    this.#regexp = new RegExp(`^${regexp}$`, "i");
    this.#printers = printers;
    this.#lib = Printer.#createLib(this.#session);
  }

  match(input) {
    const matches = this.#regexp.exec(input);
    if (!matches) {
      return null;
    }

    for (const [key, value] of Object.entries(matches.groups)) {
      if (value) {
        return this.#printers[key];
      }
    }

    return null;
  }

  async prettify(variable) {
    const prettyprinter = this.match(variable.type);
    if (!prettyprinter) {
      return;
    }

    if (prettyprinter.structured && variable.variablesReference > 0) {
      this.#interceptions.set(variable.variablesReference, prettyprinter);
    }

    await prettyprinter.prettify(new Variable(this.#lib, variable));

    // If we're printing a literal value, we cannot have children.
    if (prettyprinter.literal) {
      variable.variablesReference = 0;
    }
  }

  print(request, args) {
    const printer = this.#interceptions.get(request.arguments.variablesReference);
    const promise = this.#session.dbg.waitableSendRequest(request, args);
    if (!printer) {
      return promise;
    }

    return promise.then(response => {
      response.body.variables = printer.children(this.#lib, response.body.variables);
      return response;
    });
  }

  intercept(response, args, request) {
    const printer = this.#interceptions.get(request.arguments.variablesReference);
    if (!printer) {
      return false;
    }
    // We're intentionally not removing the interception here.
    // We let a new scopesRequest perform that operation for us.

    return true;
  }

  reset() {
    // We drop the old map on the floor, letting the garbage collector
    // get rid of the memory.
    this.#interceptions = new Map();
  }
}

async function getFiles(path) {
  try {
    const files = await workspace.fs.readDirectory(path);
    return files;
  } catch (_) {
    return [];
  }
}

class PrinterFactory {
  #printers = {};
  #session;

  async loadPrettyPrinters(directory) {
    const printerlib = {
      LiteralPrinter,
      StructuredPrinter,
    };
    let files = [];
    try {
      files = await getFiles(directory);
    } catch(_) {}

    for (const [file, type] of files) {
      if (type != 1) {
        continue;
      }
      try {
        const uri = Uri.joinPath(directory, file);
        const { create } = require(uri.path);
        this.add(create(printerlib));
      } catch (e) {
        console.log(e.message);
      }
    }
    return this.printer();
  }

  constructor(session) {
    this.#session = session;
  }

  add(printer) {
    this.#printers[printer.name] = printer;
  }

  printer() {
    if (!Object.keys(this.#printers).length) {
      return null;
    }

    const re = Object.values(this.#printers)
      .map((p) => p.regexp)
      .join("|");
    return new Printer(this.#session, re, this.#printers);
  }
}

module.exports = { PrettyPrinter, PrinterFactory };
