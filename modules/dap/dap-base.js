const { DebugSession, OutputEvent, InvalidatedEvent, TerminatedEvent } = require("@vscode/debugadapter");
const { window, Uri } = require("vscode");
const vs = require("vscode");
const { toHexString, getAPI } = require("../utils/utils");
const { PrinterFactory } = require("../prettyprinter.js");
const { CustomRequests, ProvidedAdapterTypes, CustomRequestsUI, ContextKeys } = require("../constants");

/**
 *
 * @typedef { Object } MidasExtendedProtocolMessage
 * @property { number } seq
 * @property { 'request' | 'response' | 'event' | string } type
 * @property { number } processId
 *
 * @typedef ProtocolResponse
 * @type { Object }
 * @property { number } request_seq
 * @property { boolean } success
 * @property { string } command
 * @property { 'cancelled' | 'notStopped' | string } message
 * @property { any? } body
 *
 * @typedef ProtocolEvent
 * @type { Object }
 * @property { string } event
 * @property { any? } body
 *
 * @typedef { MidasExtendedProtocolMessage & ProtocolResponse } Response
 * @typedef { MidasExtendedProtocolMessage & ProtocolEvent } Event
 */

/**
 * @import { LaunchSpawnConfig, AttachSpawnConfig, RRSpawnConfig, MdbSpawnConfig } from "../spawn"
 * @typedef { import("./base-process-handle").DebuggerProcessBase } DebuggerProcessBase
 */

class MidasSessionBase extends DebugSession {
  formatValuesAsHex = false;
  /** @type { Set<number> } */
  formattedVariablesMap = new Set();
  /** @type { DebuggerProcessBase } */
  dbg;
  /** @type {import("../terminalInterface").TerminalInterface} */
  #terminal;

  /** @type {import("../ui/checkpoints/checkpoints").CheckpointsViewProvider }*/
  #checkpointsUI;
  #defaultLogger = (output) => {
    console.log(output);
  };

  spawnConfig;
  addressBreakpoints = [];

  // The currently loaded pretty printer.
  #printer;
  /**
   * @param { new (options) => DebuggerProcessBase } DebuggerProcessConstructor
   * @param { LaunchSpawnConfig | AttachSpawnConfig | RRSpawnConfig } spawnConfig
   * @param { * } terminal
   * @param { * } checkpointsUI
   * @param { {response: (res: Response) => void, events: (evt: Event) => void } | null } callbacks
   * @param { import("events").EventEmitter } cleanUp
   */
  constructor(DebuggerProcessConstructor, spawnConfig, terminal, checkpointsUI, callbacks, cleanUp) {
    super(true, false);
    this.spawnConfig = spawnConfig;
    this.#checkpointsUI = checkpointsUI;
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
    this.dbg = new DebuggerProcessConstructor(spawnConfig);
    this.#terminal = terminal;
    this.notifiedOfTermination = false;
    this.rootSessionCleanup = cleanUp;

    const { response, events } = callbacks ?? { response: null, events: null };

    if ("prettyPrinterPath" in spawnConfig && spawnConfig.prettyPrinterPath?.length) {
      const factory = new PrinterFactory(this);
      factory.loadPrettyPrinters(Uri.file(spawnConfig.prettyPrinterPath)).then((printer) => {
        this.#printer = printer;
      });
    }

    if (response) {
      this.dbg.connectResponse(callbacks.response);
    } else {
      this.dbg.connectResponse((res) => {
        if (!res.success) {
          const err = (res.body?.error ?? { stacktrace: "No stack trace info" }).stacktrace;
          console.log(`[request error]: ${res.command} failed\n${err}`);
        }
        switch (res.command) {
          case CustomRequests.DeleteCheckpoint:
          case CustomRequests.SetCheckpoint:
            this.updateCheckpointsView(res.body.checkpoints ?? []);
            break;
          case "threads":
            this.UpdateThreadIdCache(res.body);
            break;
        }
        this.sendResponse(res);
      });
    }

    if (events) {
      this.dbg.connectEvents(callbacks.events);
    } else {
      this.dbg.connectEvents(async (evt) => {
        const { event, body } = evt;
        switch (event) {
          case "terminated":
            this.shutdown();
            break;
          case "exited":
            this.emit("exit");
            break;
          case "startDebugging":
            // currently, only midas-native supports multiprocessing
            // via reverse requesting a debug session.
            await vs.debug
              .startDebugging(
                vs.workspace.workspaceFolders[0],
                {
                  type: ProvidedAdapterTypes.Native,
                  name: body?.configuration?.name ?? "forked",
                  request: "attach",
                  childConfiguration: {
                    path: body.configuration.path,
                  },
                },
                vs.debug.activeDebugSession,
              )
              .then((bool) => {
                if (bool) {
                  console.log(`child session started`);
                }
              });
            return;
        }
        this.sendEvent(evt);
      });
    }

    this.on("error", (event) => {
      this.sendEvent(new OutputEvent(event.body, "console", event));
    });

    if (this.hasProcessHandle()) {
      for (const evt of ["close", "disconnect", "error", "exit"]) {
        this.dbg.process.on(evt, () => {
          if (!this.notifiedOfTermination) {
            this.sendEvent(new TerminatedEvent());
            this.notifiedOfTermination = true;
          }
        });
      }
    }
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
  configureUserInterfaceFor({ sessionType, singleThreadControl, nativeMode, isReplay }) {
    vs.commands.executeCommand("setContext", ContextKeys.DebugType, sessionType);
    vs.commands.executeCommand("setContext", ContextKeys.NoSingleThreadControl, !singleThreadControl);
    vs.commands.executeCommand("setContext", ContextKeys.NativeMode, nativeMode ?? false);
    vs.commands.executeCommand("setContext", ContextKeys.IsReplay, isReplay ?? false);
  }

  // If this is a child session, it holds no handle to a process. It's just a connection to a socket
  hasProcessHandle() {
    return this.dbg.process != null;
  }

  dispose() {
    this.disposeTerminal();
    super.dispose();
    if (this.rootSessionCleanup) {
      // Root Session Cleanup
      this.rootSessionCleanup.emit("shutdown");
    }
  }

  shutdown() {
    super.shutdown();
  }

  log(where, output) {
    const logger = getAPI().getLogger(where);
    if (logger == undefined) {
      this.#defaultLogger(output);
    } else {
      logger.appendLine(output);
    }
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

  updateCheckpointsView(checkpoints) {
    this.#checkpointsUI.updateCheckpoints(checkpoints);
  }

  // REQUESTS \\

  initializeRequest(response, args) {
    this.dbg.sendRequest({ seq: response.request_seq, command: response.command }, args);
  }

  configurationDoneRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  // eslint-disable-next-line no-unused-vars
  launchRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  // eslint-disable-next-line no-unused-vars
  attachRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  // eslint-disable-next-line no-unused-vars
  setBreakPointsRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  // eslint-disable-next-line no-unused-vars
  dataBreakpointInfoRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  // eslint-disable-next-line no-unused-vars
  setDataBreakpointsRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  // eslint-disable-next-line no-unused-vars
  continueRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  setFunctionBreakPointsRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  // eslint-disable-next-line no-unused-vars
  pauseRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  threadsRequest(response, request) {
    this.dbg.sendRequest(request, {});
  }

  stackTraceRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  variablesRequest(response, args, request) {
    if (this.formatValuesAsHex) {
      args.format = { hex: true };
    }

    if (!this.#printer) {
      this.dbg.sendRequest(request, args);
      return;
    }

    // If no pretty printer is found this initiates the variables request as usual.
    this.#printer.print(request, args).then(async (response) => {
      try {
        if (this.#printer) {
          for (const variable of response.body.variables) {
            // If it's already pretty this does nothing.
            await this.#printer.prettify(variable);
          }
        }
      } catch (e) {
        console.log(e.message);
      }

      this.sendResponse(response);
    });
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
    // We reset the current recorded interceptions, since de're getting
    // new scopes and the interceptions have become invalid.
    if (this.#printer) {
      this.#printer.reset();
    }

    this.dbg.sendRequest(request);
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
    this.dbg.sendRequest(request, args);
  }

  runInTerminalRequest(...args) {
    return this.virtualDispatch(...args);
  }

  // eslint-disable-next-line no-unused-vars
  disconnectRequest(response, args, request) {
    try {
      this.dbg.sendRequest(request, args);
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
    this.dbg.sendRequest(request, args);
  }

  restartRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  setExceptionBreakPointsRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  nextRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  stepInRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  stepOutRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  stepBackRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  reverseContinueRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  restartFrameRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  gotoRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  sourceRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  terminateThreadsRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  setExpressionRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
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
    this.dbg.sendRequest(request, args);
  }

  stepInTargetsRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  gotoTargetsRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  completionsRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  exceptionInfoRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  loadedSourcesRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  readMemoryRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  writeMemoryRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  // eslint-disable-next-line no-unused-vars
  cancelRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  breakpointLocationsRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  setInstructionBreakpointsRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  // eslint-disable-next-line no-unused-vars
  disassembleRequest(response, args, request) {
    this.dbg.sendRequest(request, args);
  }

  PauseAll(request) {
    request.command = "customRequest";
    request.arguments = {
      command: CustomRequests.PauseAll,
      arguments: {},
    };
    this.dbg.sendRequest(request);
  }

  ContinueAll(request) {
    request.command = "customRequest";
    request.arguments = {
      command: CustomRequests.ContinueAll,
      arguments: {},
    };
    this.dbg.sendRequest(request);
  }

  OnSelectedThread(request, id) {
    // implement if backend has use for it.
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
        this.dbg.sendRequest(request);
        break;
      }
      case CustomRequests.PauseAll: {
        return this.PauseAll(request);
      }
      case CustomRequests.ContinueAll: {
        return this.ContinueAll(request);
      }
      case CustomRequests.RunToEvent: {
        window.showInputBox().then((event_number) => {
          const num = Number.parseInt(event_number);
          if (Number.isNaN(num)) {
            this.sendErrorResponse(response, 0, "Run To Event requires a number as input.");
            return;
          }
          request.arguments = { event: num };
          this.dbg.sendRequest(request);
        });
        break;
      }

      // UI Related requests. Dumbest in the world that this is the approach vscode has taken.
      case CustomRequestsUI.HasThread: {
        const hasThread = this.ContainsThreadId(args.id);
        response.body = { hasThread: hasThread };
        this.sendResponse(response);
        break;
      }

      case CustomRequestsUI.OnSelectedThread: {
        return this.OnSelectedThread(request, args.id);
      }
      default:
        request.arguments = args ?? {};
        this.dbg.sendRequest(request);
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

  registerTerminal(terminal, onExitHandler = null) {
    this.#terminal = terminal;
    if (onExitHandler) {
      this.#terminal.registerExitAction(onExitHandler);
    }
  }

  disposeTerminal() {
    this.#terminal?.dispose();
  }

  get terminal() {
    return this.#terminal;
  }

  getSpawnConfig() {
    return this.spawnConfig;
  }

  ContainsThreadId(threadId) {
    if (this.threadCache == null) {
      return false;
    }
    return this.threadCache.has(threadId);
  }

  UpdateThreadIdCache({ threads }) {
    if (this.threadCache == null) {
      this.threadCache = new Set();
    }
    this.threadCache.clear();
    try {
      for (const thread of threads) {
        this.threadCache.add(thread.id);
      }
    } catch (ex) {
      console.log(`not iterable?`);
    }
  }
}

module.exports = {
  MidasSessionBase,
};
