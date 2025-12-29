"use strict";

const { workspace, Uri } = require("vscode");
const { consoleLog, consoleErr } = require("./utils/log");

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

  // eslint-disable-next-line no-unused-vars
  valueHint(variable) {}

  // eslint-disable-next-line no-unused-vars
  valueExpanded(children) {}
}

class CachedValue extends PrettyPrinter {
  variable;
  constructor(variable) {
    super("");
    this.variable = variable;
  }

  valueHint(varible) {
    varible.value = this.variable.value;
  }

  valueExpanded(variables) {
    variables.clear();
    variables.push(this.variable);
  }
}

class Variable {
  #variable;
  #printer;
  constructor(printer, variable) {
    this.#printer = printer;
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
      seq: this.#printer.seq_number,
      command: "variables",
      type: "request",
      arguments: args,
    };

    const response = await this.#printer.session.dbg.waitableSendRequest(request, args);
    return response.body.variables.map((v) => new Variable(this.#printer, v));
  }

  cache(value) {
    this.#printer.cache(this.#variable.variablesReference, value);
  }

  getRaw(session) {
    if (session == this.#printer.session) {
      return this.#variable;
    }
  }

  toLiteral() {
    this.#variable.variablesReference = 0;
  }
}

class Variables {
  #printer;
  #variables;
  constructor(printer, variables) {
    this.#printer = printer;
    this.#variables = variables;
  }

  value(index) {
    if (index < this.#variables.length) {
      return new Variable(this.#printer, this.#variables[index]);
    }
  }

  remove(index) {
    if (index < this.#variables.length) {
      this.#variables.splice(index, 1);
    }
  }

  clear() {
    this.#variables.length = 0;
  }

  push(value) {
    const raw = value.getRaw(this.#printer.session);
    this.#variables.push(raw);
  }

  update(index, value) {
    if (index < this.#variables.length) {
      const raw = value.getRaw(this.#printer.session);
      this.#variables[index] = raw;
    }
  }
}

class Printer {
  #regexp = / /;
  #printers = {};
  #interceptions = new Map();
  #session;
  #seq_number = 0xffffffff;

  get seq_number() {
    return this.#seq_number--;
  }

  constructor(session, regexp, printers) {
    consoleLog(regexp);
    this.#session = session;
    this.#regexp = new RegExp(`^${regexp}$`, "i");
    this.#printers = printers;
  }

  get session() {
    return this.#session;
  }

  match(input) {
    const matches = this.#regexp.exec(input);
    if (!matches) {
      return null;
    }

    for (const [key, value] of Object.entries(matches.groups)) {
      if (value && value.length == input.length) {
        return this.#printers[key];
      }
    }

    return null;
  }

  async prettify(variable) {
    // We explicitly forbid prettyprinters for literal types.
    if (variable.variablesReference === 0) {
      return;
    }

    const prettyprinter = this.match(variable.type);
    if (!prettyprinter) {
      return;
    }

    await prettyprinter.valueHint(new Variable(this, variable));

    if (variable.variablesReference && !this.#interceptions.has(variable.variablesReference)) {
      this.#interceptions.set(variable.variablesReference, prettyprinter);
    }
  }

  print(request, args) {
    const printer = this.#interceptions.get(request.arguments.variablesReference);
    const promise = this.#session.dbg.waitableSendRequest(request, args);
    if (!printer) {
      return promise;
    }

    return promise.then(async (response) => {
      await printer.valueExpanded(new Variables(this, response.body.variables));
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

  cache(variablesReference, value) {
    if (value instanceof Variable) {
      this.#interceptions.set(variablesReference, new CachedValue(value));
    }
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
      PrettyPrinter,
    };
    let files = [];
    try {
      files = await getFiles(directory);
    } catch (_) {}

    for (const [file, type] of files) {
      if (type != 1) {
        continue;
      }
      try {
        const uri = Uri.joinPath(directory, file);
        const { create } = require(uri.path);
        this.add(create(printerlib));
      } catch (e) {
        consoleErr(e.message);
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
