"use strict";

const DebugAdapter = require("@vscode/debugadapter");
const vscode = require("vscode");

const { spawn, spawnSync } = require("child_process");
const EventEmitter = require("events");

// eslint-disable-next-line no-unused-vars
const { GDB } = require("../gdb");
const { Subject } = require("await-notify");
const fs = require("fs");
const net = require("node:net");
const { isNothing, toHexString, getAPI } = require("../utils/utils");
const { TerminatedEvent, OutputEvent, InitializedEvent, StoppedEvent } = require("@vscode/debugadapter");
const { getExtensionPathOf } = require("../utils/sysutils");
let server;

/**
 * Serialize request, preparing it to be sent over the wire to GDB
 * @param {number} seq
 * @param {string} request
 * @param {*} args
 * @returns {string}
 */
function serialize_request(seq, request, args = {}) {
  const json = {
    seq,
    type: "request",
    command: request,
    arguments: args,
  };
  const data = JSON.stringify(json);
  const length = data.length;
  const res = `Content-Length: ${length}\r\n\r\n${data}`;
  return res;
}

class GdbOptions {
  constructor(opts_dictionary) {
    this.options = new Map();
    for (const prop in opts_dictionary) {
      this.options.set(prop, opts_dictionary[prop]);
    }
  }

  finalize() {
    const arr = [];
    for (const [k, v] of this.options.entries()) {
      arr.push(k, v);
    }
    return arr;
  }

  log_options(logger) {
    if (logger == null) {
      logger = (k, v) => {
        console.log(`${k} == ${v}`);
      };
    }
    for (const [k, v] of this.options.entries()) {
      logger(k, v);
    }
  }
}

const MessageHeader = /Content-Length: (\d+)\s{4}/gm;

/** @typedef {{ start: number, end: number, all_received: boolean }} PacketBufferMetaData */

/**
 * @param {string} contents
 * @returns { PacketBufferMetaData[] }
 */
function process_buffer(contents) {
  let m;
  const result = [];
  while ((m = MessageHeader.exec(contents)) !== null) {
    // This is necessary to avoid infinite loops with zero-width matches
    if (m.index === MessageHeader.lastIndex) {
      MessageHeader.lastIndex++;
    }
    // The result can be accessed through the `m`-variable.
    let contents_start = 0;
    m.forEach((match, groupIndex) => {
      if (groupIndex == 0) {
        contents_start = m.index + match.length;
      }

      if (groupIndex == 1) {
        const len = Number.parseInt(match);
        const all_received = contents_start + len <= contents.length;
        result.push({ start: contents_start, end: contents_start + len, all_received });
      }
    });
  }
  return result;
}

/**
 * @typedef {} Request
 */

/**
 * Parses the contents in `buffer` using the packet metadata in `metadata`.
 * Returns what's remaining in the buffer that's not parsed. Not every packet is required
 * to have been handled
 * @param {string} buffer
 * @param {PacketBufferMetaData[]} metadata
 * @returns { { buffer: string, protocol_messages: object[] } }
 */
function parse_buffer(buffer, metadata) {
  let parsed_end = 0;
  const res = [];
  for (const { start, end } of metadata.filter((i) => i.all_received)) {
    const data = buffer.slice(start, end);
    const json = JSON.parse(data);
    res.push(json);
    parsed_end = end;
  }
  buffer = buffer.slice(parsed_end);
  return { buffer, protocol_messages: res };
}

class Gdb {
  /** @type {EventEmitter} */
  events;
  /** @type {EventEmitter} */
  responses;

  last_req;

  /**
   * @param { string } path
   */
  constructor(path, options, eventshandler) {
    this.readBuffer = "";
    this.path = path;
    this.options = options;

    const args = [
      ...options,
      "-ex",
      `source ${getExtensionPathOf("/modules/python/dap-wrapper/variables_reference.py")}`,
      "-ex",
      `source ${getExtensionPathOf("/modules/python/dap-wrapper/dap.py")}`,
    ];
    try {
      const gdb_process = spawn("/usr/bin/gdb", args);

      gdb_process.on("spawn", () => {
        this.commands_socket = net.connect({ path: "/tmp/midas-commands" }, () => {
          console.log("Connected to commands socket");
        });

        this.events_socket = net.connect({ path: "/tmp/midas-events" }, () => {
          console.log("Connected to commands socket");
        });

        this.commands_socket.on("error", (err) => {
          if (err) {
            console.log(`Error connecting to DAP server: ${err}`);
            throw new Error("Failed to connect to DAP server");
          }
        });

        this.send_wait_res = new EventEmitter();
        this.events = new EventEmitter();
        this.events.on("event", eventshandler);
        this.responses = new EventEmitter();

        this.responses.on("response", (res) => {
          this.send_wait_res.emit(res.command, res);
        });

        let responseReadBuffer = "";
        this.commands_socket.on("data", (data) => {
          const str = data.toString();
          responseReadBuffer = responseReadBuffer.concat(str);
          const packets = process_buffer(responseReadBuffer).filter((i) => i.all_received);
          const { buffer: remaining_buffer, protocol_messages } = parse_buffer(responseReadBuffer, packets);
          responseReadBuffer = remaining_buffer;
          for (const msg of protocol_messages) {
            this.responses.emit("response", msg);
          }
          if (responseReadBuffer.length > 0) {
            console.log(`Remainder buffer: ${responseReadBuffer}`);
          }
        });

        let eventsReadBuffer = "";
        this.events_socket.on("data", (data) => {
          const str = data.toString();
          console.log(`Event data: ${str}`);
          eventsReadBuffer = eventsReadBuffer.concat(str);
          const packets = process_buffer(eventsReadBuffer).filter((i) => i.all_received);
          const { buffer: remaining_buffer, protocol_messages } = parse_buffer(eventsReadBuffer, packets);
          eventsReadBuffer = remaining_buffer;
          for (const msg of protocol_messages) {
            this.events.emit("event", msg);
          }
          if (eventsReadBuffer.length > 0) {
            console.log(`Remainder buffer: ${eventsReadBuffer}`);
          }
        });
      });
      gdb_process.stdout.on("data", (data) => {
        console.log(data.toString());
      });
      gdb_process.stderr.on("data", (data) => {
        console.log(data.toString());
      });
      gdb_process.on("close", (data) => {
        throw new Error("Gdb exited!?");
      });
      this.gdb = gdb_process;
    } catch (ex) {
      throw new Error(`Could not launch GDB with path ${path}`);
    }
  }

  sendRequest(req, args) {
    return new Promise((res) => {
      const serialized = serialize_request(req.seq, req.command, args ?? req.arguments);
      this.commands_socket.write(serialized);
      this.send_wait_res.once(req.command, (body) => {
        res(body);
      });
    });
  }

  disconnect() {
    const se_disconnect = serialize_request(this.last_req + 1, "disconnect");
    this.gdb.stdin.write(se_disconnect);
  }
}

async function spawn_gdb(path, options) {}

class MidasDAPSession extends DebugAdapter.DebugSession {
  /** @type { Set<number> } */
  formattedVariablesMap = new Set();
  /** @type { Gdb } */
  gdb;
  /** @type { Subject } */
  configIsDone;
  _reportProgress;
  useInvalidetedEvent;
  /** @type {import("../terminalInterface").TerminalInterface} */
  #terminal;
  fnBkptChain = Promise.resolve();

  #defaultLogger = (output) => {
    console.log(output);
  };

  /**
   * @type {import("../spawn").SpawnConfig}
   */
  #spawnConfig;
  addressBreakpoints = [];
  // eslint-disable-next-line no-unused-vars
  constructor(debuggerLinesStartAt1, isServer = false, fileSystem = fs, spawnConfig, terminal, checkpointsUI) {
    super();
    // NB! i have no idea what thread id this is supposed to refer to
    this.#spawnConfig = spawnConfig;
    this.configIsDone = new Subject();
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
    this.gdb = new Gdb(spawnConfig.path, spawnConfig.options ?? [], (evt) => {
      const { event, body } = evt;
      switch (event) {
        case "exited":
          this.gdb.disconnect();
          this.sendEvent(new TerminatedEvent(false));
          break;
        case "output":
          this.sendEvent(new OutputEvent(body.output, "console"));
          break;
        case "initialized":
          break;
        case "stopped":
          this.sendEvent(new StoppedEvent(body.reason, body.threadId));
          break;
        case "thread":
          this.sendEvent(evt);
          break;
        case "breakpoint":
          if (body.reason != "removed") this.sendEvent(evt);
          break;
        default:
          this.sendEvent(evt);
          this.sendEvent(new OutputEvent(`Sent event: ${JSON.stringify(evt)}`, "console"));
          break;
      }
    });

    this.on("error", (event) => {
      this.sendEvent(new DebugAdapter.OutputEvent(event.body, "console", event));
    });
    this.#terminal = terminal;
  }

  /**
   * @returns { import("../buildMode").MidasRunMode }
   */
  get buildSettings() {
    return this.#spawnConfig.traceSettings;
  }

  log(where, output) {
    const logger = getAPI().getLogger(where);
    if (logger == undefined) {
      this.#defaultLogger(output);
    } else {
      logger.appendLine(output);
    }
  }

  /**
   * As per Mock debug adapter:
   * The 'initialize' request is the first request called by the frontend
   * to interrogate the features the debug adapter provides.
   * @param {import("@vscode/debugprotocol").DebugProtocol.InitializeResponse} response
   * @param {import("@vscode/debugprotocol").DebugProtocol.InitializeRequestArguments} args
   */
  async initializeRequest(response, args) {
    const res = await this.gdb.sendRequest({ seq: response.request_seq, command: response.command }, args);
    response.body = res.body;
    this.sendResponse(response);
    // this.sendEvent(new InitializedEvent());
  }

  /**
   * Called at the end of the configuration sequence.
   * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
   * @param {import("@vscode/debugprotocol").DebugProtocol.ConfigurationDoneResponse} response
   * @param {import("@vscode/debugprotocol").DebugProtocol.ConfigurationDoneArguments} args
   */
  async configurationDoneRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  // eslint-disable-next-line no-unused-vars
  async launchRequest(response, args, request) {
    DebugAdapter.logger.setup(
      args.trace ? DebugAdapter.Logger.LogLevel.Verbose : DebugAdapter.Logger.LogLevel.Stop,
      false
    );
    const res = await this.gdb.sendRequest(request, {program: args.program, stopOnEntry: args.stopOnEntry, allStopMode: args.allStopMode});
    response.body = res.body;
    response.success = res.success;
    this.sendResponse(res);
    this.sendEvent(new InitializedEvent());
  }

  // eslint-disable-next-line no-unused-vars
  async attachRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  // eslint-disable-next-line no-unused-vars
  async setBreakPointsRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  // eslint-disable-next-line no-unused-vars
  async setBreakPointsRequestPython(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  // eslint-disable-next-line no-unused-vars
  async dataBreakpointInfoRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }
  // eslint-disable-next-line no-unused-vars
  async setDataBreakpointsRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  // eslint-disable-next-line no-unused-vars
  async continueRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  async setFunctionBreakPointsRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  // eslint-disable-next-line no-unused-vars
  async pauseRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  async threadsRequest(response, request) {
    const res = await this.gdb.sendRequest(request, {});
    response.body = res.body;
    this.sendResponse(response);
  }

  stackTraceRequest(response, args, request) {
    this.gdb.sendRequest(request, args).then(res => {
      this.sendResponse(res);
    })
  }

  async variablesRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  checkForHexFormatting(variablesReference, variables) {
    if (this.formattedVariablesMap.has(variablesReference)) {
      for (let v of variables) {
        if (v.variablesReference > 0) {
          this.formattedVariablesMap.add(v.variablesReference);
        }
        if (!isNaN(v.value)) {
          v.value = toHexString(v.value);
        }
      }
    }
  }

  async scopesRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request);
    response.body = res.body;
    this.sendResponse(response);
  }

  // "VIRTUAL FUNCTIONS" av DebugSession som behövs implementeras (några av dom i alla fall)
  static run(port) {
    if (!port) {
      DebugAdapter.DebugSession.run(MidasDAPSession);
      return;
    }
    if (server) {
      server.close();
      server = null;
    }

    // start a server that creates a new session for every connection request
    server = net
      .createServer((socket) => {
        socket.on("end", () => {});
        const session = new MidasDAPSession();
        session.setRunAsServer(true);
        session.start(socket, socket);
      })
      .listen(port);
  }

  static shutdown() {
    server.close();
  }

  virtualDispatch(...args) {
    let name;
    try {
      throw new Error();
    } catch (e) {
      // Get the name of the calling function.
      name = e.stack.split("\n")[2].match(/^.+?[\.]([^ ]+)/)[1];
    }

    console.error(`Not Implemented: ${name}`);
    // Call the calling function on super.
    super[name](...args);
  }

  // eslint-disable-next-line no-unused-vars
  async setVariableRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  runInTerminalRequest(...args) {
    return this.virtualDispatch(...args);
  }

  // eslint-disable-next-line no-unused-vars
  async disconnectRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  async terminateRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  async restartRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  async setExceptionBreakPointsRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  async nextRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  async stepInRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  async stepOutRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  async stepBackRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  async reverseContinueRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  async restartFrameRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  async gotoRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  async sourceRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  async terminateThreadsRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  async setExpressionRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  parse_subscript(expr) {
    const lbracket = expr.indexOf("[");
    const rbracket = expr.indexOf("]");
    if (lbracket == -1 || rbracket == -1) {
      // no subscript operation
      return { name: expr, subscript: { begin: -1, end: -1 } };
    }
    const [begin_, end_] = expr.substring(lbracket + 1, rbracket).split(":");
    if (!end_) {
      let begin = parseInt(begin_);
      if (begin.toString() != begin_) throw new Error("");
      return { name: expr.substring(0, lbracket), subscript: { begin, end: begin } };
    } else {
      let begin = parseInt(begin_);
      let end = parseInt(end_);
      if (isNaN(begin) || isNaN(end)) return null;
      return { name: expr.substring(0, lbracket), subscript: { begin, end } };
    }
  }

  parse_evaluate_request_parameters(expression) {
    const result = this.parse_subscript(expression);
    if (result == null) throw new Error("");
    let { name, subscript } = result;
    let scope = "current";
    if (expression.charAt(0) == "*") {
      scope = "first";
      name = name.substring(1);
    }
    return {
      name: name.endsWith(",x") ? name.substring(0, name.length - 2) : name,
      formatting: expression.endsWith(",x") ? "hex" : "none",
      subscript: subscript,
      scope: scope,
    };
  }
  // eslint-disable-next-line no-unused-vars
  async evaluateRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  async stepInTargetsRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  async gotoTargetsRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  async completionsRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  async exceptionInfoRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  async loadedSourcesRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  async readMemoryRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  async writeMemoryRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  // eslint-disable-next-line no-unused-vars
  async cancelRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  async breakpointLocationsRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  async setInstructionBreakpointsRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  // eslint-disable-next-line no-unused-vars
  async disassembleRequest(response, args, request) {
    const res = await this.gdb.sendRequest(request, args);
    this.sendResponse(res);
  }

  /**
   * Override this hook to implement custom requests.
   */
  // eslint-disable-next-line no-unused-vars
  async customRequest(command, response, args) {
    let request = response;
    const cmd = request.command;
    request.type = "request";
    request.arguments = {
      command: cmd,
      args: args ?? {},
    };
    request.command = "customRequest";
    this.gdb.sendRequest(request);
  }

  /**
   * @param {number} line
   * @returns { number }
   */
  convertClientLineToDebugger(line) {
    console.log("convertClientLineToDebugger called with " + line);
    return super.convertClientLineToDebugger(line);
  }
  /**
   * @param {number} line
   * @returns {number}
   */
  convertDebuggerLineToClient(line) {
    console.log("convertDebuggerLineToClient called with " + line);
    return super.convertDebuggerLineToClient(line);
  }
  /**
   *
   * @param {number} column
   * @returns {number}
   */
  convertClientColumnToDebugger(column) {
    console.log("convertClientColumnToDebugger called with " + column);
    return super.convertClientColumnToDebugger(column);
  }
  /**
   * @param {number} column
   * @returns {number}
   */
  convertDebuggerColumnToClient(column) {
    console.log("convertDebuggerColumnToClient called with " + column);
    return super.convertDebuggerColumnToClient(column);
  }
  /**
   * @param {string} clientPath
   * @returns {string}
   */
  convertClientPathToDebugger(clientPath) {
    console.log("convertClientPathToDebugger called with " + clientPath);
    return super.convertClientPathToDebugger(clientPath);
  }

  /**
   *
   * @param {string} debuggerPath
   * @returns {string}
   */
  convertDebuggerPathToClient(debuggerPath) {
    console.log("convertDebuggerPathToClient calledf with " + debuggerPath);
    return super.convertDebuggerPathToClient(debuggerPath);
  }

  registerTerminal(terminal, onExitHandler = null) {
    this.#terminal = terminal;
    if (onExitHandler) {
      this.#terminal.registerExitAction(onExitHandler);
    }
  }

  addTerminalExitHandler(handler) {
    if (isNothing(this.#terminal)) {
      throw new Error("No terminal registered to register handler with");
    }
    this.#terminal.registerExitAction(handler);
  }

  reloadScripts() {}

  async exec(cmd) {}

  disposeTerminal() {
    if (this.#terminal) this.#terminal.dispose();
  }

  get terminal() {
    return this.#terminal;
  }

  getSpawnConfig() {
    return this.#spawnConfig;
  }

  atMidasExit() {}
}

module.exports = {
  MidasDAPSession,
};
