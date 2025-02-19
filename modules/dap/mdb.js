// @ts-check
"use strict";
const { MidasCommunicationChannel } = require("./dap-utils");
const { DebuggerProcessBase } = require("./base-process-handle");
const { getAPI, toHexString } = require("../utils/utils");
const { MdbSpawnConfig } = require("../spawn");
const { CustomRequests, ProvidedAdapterTypes, ContextKeys } = require("../constants");
const vs = require("vscode");
const { DebugSession, TerminatedEvent, InvalidatedEvent } = require("@vscode/debugadapter");
const { randomUUID } = require("crypto");

/**
 * Serialize request, preparing it to be sent over the wire to GDB
 * @param { number } seq
 * @param { number } processId
 * @param { string } request
 * @param { * } args
 * @returns { string }
 */
function serializeExtensionRequest(seq, processId, request, args = {}) {
  let ProtocolMessage = {
    seq,
    type: "request",
    processId: processId,
    command: request,
    arguments: args,
  };

  const data = JSON.stringify(ProtocolMessage);
  const length = data.length;
  const res = `Content-Length: ${length}\r\n\r\n${data}`;
  return res;
}


/**
 * Configures the user interface based on the provided settings.
 *
 * @param { Object } configUI - The configuration object for the user interface.
 * @param { "midas-gdb" | "midas-rr" | "midas-native" } configUI.sessionType - One of the midas sessions
 * @param { boolean } configUI.singleThreadControl - Configure UI for single thread control
 * @param { boolean | undefined } [configUI.nativeMode] - Configure the UI for native debugger mode
 * @param { boolean | undefined } [configUI.isReplay] - Make RR UI widgets available
 */
function configureUserInterface({ sessionType, singleThreadControl, nativeMode, isReplay }) {
  vs.commands.executeCommand("setContext", ContextKeys.DebugType, sessionType);
  vs.commands.executeCommand("setContext", ContextKeys.NoSingleThreadControl, !singleThreadControl);
  vs.commands.executeCommand("setContext", ContextKeys.NativeMode, nativeMode ?? false);
  vs.commands.executeCommand("setContext", ContextKeys.IsReplay, isReplay ?? false);
}

class MdbSocket extends MidasCommunicationChannel {
  /** @type {import("child_process").ChildProcessWithoutNullStreams} */
  process;

  constructor(name, process, emitter) {
    super(name, emitter);
    this.name = name;
    this.emitter = emitter;
    this.process = process;
  }

  /**
   * @returns { Promise<import("./dap-utils").DataChannel> }
   */
  async resolveInputDataChannel() {
    return { recv: this.process.stdout, send: this.process.stdin };
  }
}

/**
 * @typedef {Object} DebugMdb
 * @property { boolean | null } recordSession
 * @property { number | null } globalThreadPoolSize
 */

class MdbProcess extends DebuggerProcessBase {
  constructor(options) {
    super(options);
    if (this.options?.debug?.recordSession) {
      const { path: rr } = getAPI().getToolchainConfiguration().rr;
      // Read MDB "documentation" (the source code): the -r CLI parameter, configures the wait system to use signals
      // (instead of waitpid syscall) to work (properly) while being recorded by RR.
      const newOptions = ["record", this.path(), "-r", ...this.options.options];
      try {
        const p = rr;
        this.spawnDebugger(p, newOptions);
      } catch (ex) {
        console.log(`Creating instance of ${this.path()} failed: ${ex}`);
        // re-throw exception - this must be a hard error
        throw ex;
      }
    } else {
      const spawnOptions = [...this.options.options];
      this.spawnDebugger(this.path(), spawnOptions);
    }
    this.socket = new MdbSocket("stdio", this.process, this.messages);
  }

  spawnArgs() {
    return this.options;
  }

  async initialize() {
    await this.socket.connect();
  }

  requestChannel() {
    return this.socket;
  }

  /** @throws { Error } */
  sendRequest(req, args) {
    const output = serializeExtensionRequest(req.seq, req.processId, req.command, args ?? req.arguments);
    this.requestChannel().write(output);
  }

  waitableSendRequest(req, args) {
    return new Promise((resolve, reject) => {
      this.messages.once(`${req.seq}`, (response) => {
        resolve(response);
      });
      try {
        this.sendRequest(req, args);
      } catch (ex) {
        reject(ex);
      }
    });
  }
}

class MidasSessionController {
  formatValuesAsHex = false;
  /** @type { Set<number> } */
  formattedVariablesMap = new Set();
  /** @type { MdbProcess } */
  dbg;
  /** @type {import("../terminalInterface").TerminalInterface} */
  #terminal;

  /** @type {import("../ui/checkpoints/checkpoints").CheckpointsViewProvider }*/
  #checkpointsUI;
  #defaultLogger = (output) => {
    console.log(output);
  };

  spawnConfig;

  // The currently loaded pretty printer.
  #printer;
  /** @type { Map<number, MidasNativeSession > } */
  #sessions = new Map();

  // same as `#sessions` but using the UUID prepared by the debug adapter.
  // This ID, unlike the process ID which the debugger gives as a unique ID
  // is to be used during initialization before a process ID can be reported by the debugger.
  /** @type { Map<string, MidasNativeSession > } */
  #initSessions = new Map();

  #initialized = false;
  /**
   * @param { MdbProcess } mdbProcess
   * @param { MdbSpawnConfig } spawnConfig
   * @param { * } terminal
   * @param { * } checkpointsUI
   * @param { import("events").EventEmitter } cleanUp
   */
  constructor(mdbProcess, spawnConfig, terminal, checkpointsUI, cleanUp) {
    this.spawnConfig = spawnConfig;
    this.#checkpointsUI = checkpointsUI;
    this.dbg = mdbProcess;
    this.hasExited = false;
    if (this.dbg == undefined || this.dbg == null || !(this.dbg instanceof MdbProcess)) {
      throw new Error(`Midas Session Controller was not provided the MDB debugger instance`);
    }
    this.#terminal = terminal;
    this.notifiedOfTermination = false;
    this.rootSessionCleanup = cleanUp;

    if ("prettyPrinterPath" in spawnConfig && spawnConfig.prettyPrinterPath?.length) {
      vs.window.showInformationMessage("Pretty printers are not supported for MDB yet");
    }

    this.dbg.connectResponse((res) => {
      if (!res.success) {
        const err = (res.body?.error ?? { stacktrace: "No stack trace info" }).stacktrace;
        console.log(`[request error]: ${res.command} failed\n${err}`);
      }
      switch (res.command) {
        case CustomRequests.DeleteCheckpoint:
        case CustomRequests.SetCheckpoint:
          this.#checkpointsUI.updateCheckpoints(res.body.checkpoints ?? []);
          break;
      }
      const processId = res.processId;
      let session = this.#sessions.get(processId);
      // we're in the initialization steps. Check init sessions
      if(session == null) {
        session = this.#initSessions.get(`${processId}`);
      }
      session.sendResponse(res);
    });

    const doShutdown = () => {
      this.shutdown();
    };

    this.dbg.process.on("close", doShutdown);
    this.dbg.process.on("error", doShutdown);
    this.dbg.process.on("exit", doShutdown);
    this.dbg.process.on("disconnect", doShutdown);

    this.dbg.connectEvents(async (evt) => {
      const { event, body } = evt;
      switch (event) {
        case "initialized":
          let session = this.#initSessions.get(body.sessionId);
          if(session.id == 0) {
            session.id = body.processId;
            this.#sessions.set(body.processId, session);
          }
          return session.sendEvent(evt);
        case "exited":
          // TODO: Exit all sessions because the debugger has exited in it's entirety.
          break;
        case "process": {
          // currently, only midas-native supports multiprocessing
          // via reverse requesting a debug session.
          await vs.debug
            .startDebugging(
              vs.workspace.workspaceFolders[0],
              {
                type: ProvidedAdapterTypes.Native,
                name: body?.name ?? "forked",
                request: "attach",
                childConfiguration: {
                  processId: body?.processId,
                  fakeAttach: true,
                },
              },
              {
                parentSession: null,
                lifecycleManagedByParent: true,
                consoleMode: vs.DebugConsoleMode.MergeWithParent,
                noDebug: false,
                compact: true,
                suppressSaveBeforeStart: false,
                suppressDebugToolbar: true,
                suppressDebugStatusbar: true,
                suppressDebugView: true,
              },
            )
            .then((bool) => {
              if (bool) {
                console.log(`child session started`);
              }
            });
          break;
        }
      }
      const processId = evt.processId;
      const session = this.#sessions.get(processId);
      session.sendEvent(evt);
    });
  }

  shutdown() {
    for(let session of this.#sessions.values()) {
      session.sendEvent(new TerminatedEvent());
      this.#sessions.delete(session.id);
    }
    if (!this.hasExited) {
      this.hasExited = true;
      this.rootSessionCleanup.emit("shutdown");
    }
  }

  get terminal() {
    return this.#terminal;
  }

  get checkpointUI() {
    return this.#checkpointsUI;
  }

  sendRequest(processId, request, args) {
    request.processId = processId;
    this.dbg.sendRequest(request, args);
  }

  async waitableSendRequest(processId, request, args) {
    request.processId = processId;
    return this.dbg.waitableSendRequest(request, args);
  }

  isInitialized() {
    return this.#initialized;
  }

  async initialize() {
    if (!this.isInitialized()) {
      this.#initialized = true;
      await this.dbg.initialize();
    }
  }

  initSession(session) {
    this.#initSessions.set(session.sessionId, session);
  }

  addSession(session) {
    this.#sessions.set(session.id, session);
  }

  removeSession(session) {
    this.#sessions.delete(session.id);
  }

  //
  updateSessionId(id, session) {
    let sessionEntry = this.#sessions.get(session.id);
    this.#sessions.set(id, sessionEntry);
  }

  createNewSessionId() {
    return randomUUID();
  }

  log(output) {
    this.#defaultLogger(output);
  }
}

class MidasNativeSession extends DebugSession {
  #config;
  #processId;
  #sessionId;
  /**
   * @param { MidasSessionController } controller
   */
  constructor(controller, config) {
    super(true, false);
    this.controller = controller;
    this.#config = config;
    this.#processId = config.processId ?? 0;
    this.#sessionId = controller.createNewSessionId();
    this.controller.initSession(this);
    // session is automatic (not a manual launch). We will almost certainly have all the necessary meta data to configure it up front.
    if(this.id != 0) {
      this.controller.addSession(this);
    }
    configureUserInterface({
      sessionType: "midas-native",
      singleThreadControl: true,
      nativeMode: true,
      isReplay: this.getConfiguration().isReplay,
    });
  }

  get sessionId() {
    return this.#sessionId;
  }

  get id() {
    return this.#processId;
  }

  set id(value) {
    this.#processId = value;
  }

  async initializeRequest(response, args) {
    args["RRSession"] = this.getConfiguration().isReplay;
    args["sessionId"] = this.sessionId;
    await this.controller.initialize();
    let dbgResponse = await this.controller.waitableSendRequest(
      0,
      { seq: response.request_seq, command: response.command },
      args,
    );
    this.sendResponse(dbgResponse);
  }

  async launchRequest(response, args, request) {
    args.sessionId = this.#sessionId;
    this.controller.sendRequest(this.#processId, request, args);
  }

  async attachRequest(response, args, request) {
    let attachArgs = args.attachArguments;
    attachArgs.sessionId = this.#sessionId;
    this.controller.sendRequest(this.#processId, request, attachArgs);
  }

  dispose() {
    super.dispose();
    this.controller.removeSession(this);
  }

  shutdown() {
    super.shutdown();
  }

  log(where, output) {
    this.controller.log(output);
  }

  hexFormatAllVariables(variables) {
    if (this.formatValuesAsHex) {
      for (let v of variables) {
        if (!isNaN(v.value)) {
          v.value = toHexString(v.value);
        }
      }
    }
  }

  // REQUESTS \\

  configurationDoneRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  // eslint-disable-next-line no-unused-vars
  setBreakPointsRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  // eslint-disable-next-line no-unused-vars
  dataBreakpointInfoRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  // eslint-disable-next-line no-unused-vars
  setDataBreakpointsRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  // eslint-disable-next-line no-unused-vars
  continueRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  setFunctionBreakPointsRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  // eslint-disable-next-line no-unused-vars
  pauseRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  threadsRequest(response, request) {
    this.controller.sendRequest(this.#processId, request, {});
  }

  stackTraceRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  variablesRequest(response, args, request) {
    if (this.formatValuesAsHex) {
      args.format = { hex: true };
    }

    this.controller.sendRequest(this.#processId, request, args);
  }

  checkForHexFormatting(variablesReference, variables) {
    if (this.controller.formattedVariablesMap.has(variablesReference)) {
      for (let v of variables) {
        if (v.variablesReference > 0) {
          this.controller.formattedVariablesMap.add(v.variablesReference);
        }
        if (!isNaN(v.value)) {
          v.value = toHexString(v.value);
        }
      }
    }
  }

  scopesRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
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
    this.controller.sendRequest(this.#processId, request, args);
  }

  runInTerminalRequest(...args) {
    return this.virtualDispatch(...args);
  }

  // eslint-disable-next-line no-unused-vars
  disconnectRequest(response, args, request) {
    try {
      this.controller.sendRequest(this.#processId, request, args);
    } catch (ex) {
      const msg = {
        id: 100,
        format: `Failed to send disconnect: ${ex}`,
        variables: null,
        sendTelemetry: false,
        showUser: true,
        url: null,
        urlLabel: null,
      };
      this.sendErrorResponse(response, msg);
      this.sendEvent(new TerminatedEvent());
    }
  }

  terminateRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  restartRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  setExceptionBreakPointsRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  nextRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  stepInRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  stepOutRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  stepBackRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  reverseContinueRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  restartFrameRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  gotoRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  sourceRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  terminateThreadsRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  setExpressionRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  // eslint-disable-next-line no-unused-vars
  evaluateRequest(response, args, request) {
    args.format = { hex: false };
    switch (args.context) {
      case "watch":
        {
          const ishex_pos = args.expression.lastIndexOf(",x");
          if (ishex_pos != -1) {
            args.expression = args.expression.substring(0, ishex_pos);
            args.format = { hex: true };
          }
        }
        break;
    }
    this.controller.sendRequest(this.#processId, request, args);
  }

  stepInTargetsRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  gotoTargetsRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  completionsRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  exceptionInfoRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  loadedSourcesRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  readMemoryRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  writeMemoryRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  // eslint-disable-next-line no-unused-vars
  cancelRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  breakpointLocationsRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  setInstructionBreakpointsRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  // eslint-disable-next-line no-unused-vars
  disassembleRequest(response, args, request) {
    this.controller.sendRequest(this.#processId, request, args);
  }

  PauseAll(request) {
    request.command = "customRequest";
    request.arguments = {
      command: CustomRequests.PauseAll,
      arguments: {},
    };
    this.controller.sendRequest(this.#processId, request);
  }

  ContinueAll(request) {
    request.command = "customRequest";
    request.arguments = {
      command: CustomRequests.ContinueAll,
      arguments: {},
    };
    this.controller.sendRequest(this.#processId, request);
  }

  /**
   * Override this hook to implement custom requests.
   */
  // eslint-disable-next-line no-unused-vars
  customRequest(command, response, args, request) {
    request.type = "request";
    request.command = command;
    switch (command) {
      case "toggle-hex":
        this.formatValuesAsHex = !this.formatValuesAsHex;
        this.sendEvent(new InvalidatedEvent(["variables"]));
        break;
      case CustomRequests.RestartCheckpoint:
      case CustomRequests.DeleteCheckpoint: {
        request.arguments = { id: args };
        this.controller.sendRequest(this.#processId, request);
        break;
      }
      case CustomRequests.PauseAll: {
        return this.PauseAll(request);
      }
      case CustomRequests.ContinueAll: {
        return this.ContinueAll(request);
      }
      default:
        vs.window.showInformationMessage(`Unsupported custom request: ${command}`);
    }
  }

  /**
   * @param {number} line
   * @returns { number }
   */
  convertClientLineToDebugger(line) {
    return super.convertClientLineToDebugger(line);
  }
  /**
   * @param {number} line
   * @returns {number}
   */
  convertDebuggerLineToClient(line) {
    return super.convertDebuggerLineToClient(line);
  }
  /**
   *
   * @param {number} column
   * @returns {number}
   */
  convertClientColumnToDebugger(column) {
    return super.convertClientColumnToDebugger(column);
  }
  /**
   * @param {number} column
   * @returns {number}
   */
  convertDebuggerColumnToClient(column) {
    return super.convertDebuggerColumnToClient(column);
  }
  /**
   * @param {string} clientPath
   * @returns {string}
   */
  convertClientPathToDebugger(clientPath) {
    return super.convertClientPathToDebugger(clientPath);
  }

  /**
   *
   * @param {string} debuggerPath
   * @returns {string}
   */
  convertDebuggerPathToClient(debuggerPath) {
    return super.convertDebuggerPathToClient(debuggerPath);
  }

  /** @returns { MdbSpawnConfig } */
  getConfiguration() {
    if (this.#config instanceof MdbSpawnConfig) {
      return this.#config;
    }
    throw new Error(`Invalid configuration for MidasSession`);
  }
}

module.exports = {
  MdbProcess,
  MidasNativeSession,
  MidasSessionController,
};
