"use strict";

const DebugAdapter = require("@vscode/debugadapter");
const { spawn } = require("child_process");
const EventEmitter = require("events");

// eslint-disable-next-line no-unused-vars
const fs = require("fs");
const net = require("node:net");
const { isNothing, toHexString, getAPI, uiSetAllStopComponent } = require("../utils/utils");
const { TerminatedEvent, OutputEvent, InitializedEvent } = require("@vscode/debugadapter");
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

const MAX_TRIES = 10;
function connect_socket(name, path, attempts, attempt_interval) {
  return new Promise((res, rej) => {
    const socket = new net.Socket();
    socket.connect({path: path});

    socket.on('connect', () => {
      res(socket);
    });

    socket.on('error', (error) => {
      socket.destroy();

      if (attempts === 0) {
        rej(error);
      } else {
        setTimeout(() => {
          connect_socket(name, path, attempts - 1, attempt_interval + 50).then(res).catch(rej);
        }, attempt_interval);
      }
    });
  });
}

class MidasSocket {
  buffer;

  constructor(name, path, type, emitter) {
    
    this.name = name;
    this.path = path;
    this.type = type;
    this.emitter = emitter;
    // TODO(simon): Do something much better. For now this is just easy enough, i.e. using a string.
    //  We *really* should do something better here. But until it becomes a problem, let's just be stupid here
    this.buffer = ""
  }

  // have to use a custom re-try logic here, because we can't know, when GDB actually has spawned it's threads and opened the sockets
  connect() {
    return connect_socket(this.name, this.path, MAX_TRIES, 50).then(socket => {
      this.socket = socket;
      this.socket.on("data", (data) => {
        const str = data.toString();
        this.buffer = this.buffer.concat(str);
        const packets = process_buffer(this.buffer).filter((i) => i.all_received);
        const { buffer: remaining_buffer, protocol_messages } = parse_buffer(this.buffer, packets);
        this.buffer = remaining_buffer;
        for (const msg of protocol_messages) {
          this.emitter.emit(this.type, msg);
        }
      });
    });
  }

  write(data) {
    this.socket.write(data, (err) => {
      if(err) {
        console.error(`Failed to write ${data} to socket: ${err}`);
        throw err;
      }
    });
  }
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
  constructor(path, options) {
    this.path = path;
    this.options = options;
    const args = [
      ...options,
      "-q",
      "-ex",
      `source ${getExtensionPathOf("/modules/python/dap-wrapper/variables_reference.py")}`,
      "-ex",
      `source ${getExtensionPathOf("/modules/python/dap-wrapper/dap.py")}`,
    ];
    try {
      const gdb_process = spawn(path, args);
      this.events = new EventEmitter();
      this.responses = new EventEmitter();
      this.commands_socket = new MidasSocket("commands", "/tmp/midas-commands", "response", this.responses);
      this.events_socket = new MidasSocket("events", "/tmp/midas-events", "event", this.events);      
      gdb_process.stderr.on("data", (data) => {
        console.log(data.toString());
      });

      gdb_process.stdout.on("data", (data) => {
        console.log(data.toString());
      });

      this.gdb = gdb_process;
    } catch (ex) {
      throw new Error(`Could not launch GDB with path ${path}`);
    }
  }

  async initialize() {
    await this.commands_socket.connect();
    await this.events_socket.connect();
  }

  response_connect(callback) {
    this.responses.on("response", callback);
  }

  events_connect(callback) {
    this.events.on("event", callback);
  }

  sendRequest(req, args) {
    this.commands_socket.write(serialize_request(req.seq, req.command, args ?? req.arguments));
  }
}

class MidasDAPSession extends DebugAdapter.DebugSession {
  /** @type { Set<number> } */
  formattedVariablesMap = new Set();
  /** @type { Gdb } */
  gdb;
  /** @type {import("../terminalInterface").TerminalInterface} */
  #terminal;
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
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
    this.gdb = new Gdb(spawnConfig.path, spawnConfig.options ?? []);

    this.gdb.response_connect((response) => {
      if(!response.success) {
        const err = (response.body.error ?? { stacktrace: "No stack trace info" }).stacktrace;
        this.sendErrorResponse(response, 0, err);
      }
      this.sendResponse(response);
    });

    this.gdb.events_connect((evt) => {
      const { event, body } = evt;
      switch (event) {
        case "exited":
          this.sendEvent(new TerminatedEvent(false));
          break;
        case "output":
          this.sendEvent(new OutputEvent(body.output, "console"));
          break;
        default:
          this.sendEvent(evt);
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
  initializeRequest(response, args) {
    this.gdb.initialize().then(() => {
      this.gdb.sendRequest({ seq: response.request_seq, command: response.command }, args);
    }).catch(err => {
      this.sendErrorResponse(response, { id: 0, format: `Failed to connect to DAP server: ${err}`});
      throw err;
    }).then(() => {
      let init = new InitializedEvent();
      this.sendEvent(init);
    })
  }

  /**
   * Called at the end of the configuration sequence.
   * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
   * @param {import("@vscode/debugprotocol").DebugProtocol.ConfigurationDoneResponse} response
   * @param {import("@vscode/debugprotocol").DebugProtocol.ConfigurationDoneArguments} args
   */
  configurationDoneRequest(response, args, request) {
    this.gdb.sendRequest(request, args);
  }

  // eslint-disable-next-line no-unused-vars
  launchRequest(response, args, request) {
    if(args.allStopMode != null) {
      uiSetAllStopComponent(args.allStopMode);
    }
    DebugAdapter.logger.setup(
      args.trace ? DebugAdapter.Logger.LogLevel.Verbose : DebugAdapter.Logger.LogLevel.Stop,
      false
    );
    this.gdb.sendRequest(request, {program: args.program, stopOnEntry: args.stopOnEntry, allStopMode: args.allStopMode});
  }

  // eslint-disable-next-line no-unused-vars
  attachRequest(response, args, request) {
    this.gdb.sendRequest(request, args);
  }

  // eslint-disable-next-line no-unused-vars
  setBreakPointsRequest(response, args, request) {
    this.gdb.sendRequest(request, args);
  }

  // eslint-disable-next-line no-unused-vars
  setBreakPointsRequestPython(response, args, request) {
    this.gdb.sendRequest(request, args);
  }

  // eslint-disable-next-line no-unused-vars
  dataBreakpointInfoRequest(response, args, request) {
    this.gdb.sendRequest(request, args);
  }
  
  // eslint-disable-next-line no-unused-vars
  setDataBreakpointsRequest(response, args, request) {
    this.gdb.sendRequest(request, args);
  }

  // eslint-disable-next-line no-unused-vars
  continueRequest(response, args, request) {
    this.gdb.sendRequest(request, args);
  }

  setFunctionBreakPointsRequest(response, args, request) {
    this.gdb.sendRequest(request, args);
  }

  // eslint-disable-next-line no-unused-vars
  pauseRequest(response, args, request) {
    this.gdb.sendRequest(request, args);
  }

  threadsRequest(response, request) {
    this.gdb.sendRequest(request, {});
  }

  stackTraceRequest(response, args, request) {
    this.gdb.sendRequest(request, args);
  }

  variablesRequest(response, args, request) {
    this.gdb.sendRequest(request, args);
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

  scopesRequest(response, args, request) {
    this.gdb.sendRequest(request);
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
  setVariableRequest(response, args, request) {
    this.gdb.sendRequest(request, args);
  }

  runInTerminalRequest(...args) {
    return this.virtualDispatch(...args);
  }

  // eslint-disable-next-line no-unused-vars
  disconnectRequest(response, args, request) {
    this.gdb.sendRequest(request, args);
  }

  terminateRequest(response, args, request) {
    this.gdb.sendRequest(request, args);
  }

  restartRequest(response, args, request) {
    this.gdb.sendRequest(request, args);
  }

  setExceptionBreakPointsRequest(response, args, request) {
    this.gdb.sendRequest(request, args);
  }

  nextRequest(response, args, request) {
    this.gdb.sendRequest(request, args);
  }

  stepInRequest(response, args, request) {
    this.gdb.sendRequest(request, args);
  }

  stepOutRequest(response, args, request) {
    this.gdb.sendRequest(request, args);
  }

  stepBackRequest(response, args, request) {
    this.gdb.sendRequest(request, args);
  }

  reverseContinueRequest(response, args, request) {
    this.gdb.sendRequest(request, args);
  }

  restartFrameRequest(response, args, request) {
    this.gdb.sendRequest(request, args);
  }

  gotoRequest(response, args, request) {
    this.gdb.sendRequest(request, args);
  }

  sourceRequest(response, args, request) {
    this.gdb.sendRequest(request, args);
  }

  terminateThreadsRequest(response, args, request) {
    this.gdb.sendRequest(request, args);
  }

  setExpressionRequest(response, args, request) {
    this.gdb.sendRequest(request, args); 
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
  evaluateRequest(response, args, request) {
    this.gdb.sendRequest(request, args);  
  }

  stepInTargetsRequest(response, args, request) {
    this.gdb.sendRequest(request, args);  
  }

  gotoTargetsRequest(response, args, request) {
    this.gdb.sendRequest(request, args);  
  }

  completionsRequest(response, args, request) {
    this.gdb.sendRequest(request, args);  
  }

  exceptionInfoRequest(response, args, request) {
    this.gdb.sendRequest(request, args);
  }

  loadedSourcesRequest(response, args, request) {
    this.gdb.sendRequest(request, args);  
  }

  readMemoryRequest(response, args, request) {
    this.gdb.sendRequest(request, args);  
  }

  writeMemoryRequest(response, args, request) {
    this.gdb.sendRequest(request, args); 
  }

  // eslint-disable-next-line no-unused-vars
  cancelRequest(response, args, request) {
    this.gdb.sendRequest(request, args);  
  }

  breakpointLocationsRequest(response, args, request) {
    this.gdb.sendRequest(request, args);  
  }

  setInstructionBreakpointsRequest(response, args, request) {
    this.gdb.sendRequest(request, args);
  }

  // eslint-disable-next-line no-unused-vars
  disassembleRequest(response, args, request) {
    this.gdb.sendRequest(request, args);
  }

  /**
   * Override this hook to implement custom requests.
   */
  // eslint-disable-next-line no-unused-vars
  customRequest(command, response, args, request) {
    request.type = "request";
    request.arguments = args ?? {};
    request.command = command;
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

  disposeTerminal() {
    if (this.#terminal) this.#terminal.dispose();
  }

  get terminal() {
    return this.#terminal;
  }

  getSpawnConfig() {
    return this.#spawnConfig;
  }
}

module.exports = {
  MidasDAPSession,
};
