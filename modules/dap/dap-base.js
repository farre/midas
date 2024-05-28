const { DebugSession, OutputEvent, InvalidatedEvent, TerminatedEvent } = require("@vscode/debugadapter");
const { commands, window } = require("vscode");
const { InitializedEvent } = require("@vscode/debugadapter");
const { CustomRequests } = require("../debugSessionCustomRequests");
const { ContextKeys, uiSetAllStopComponent, toHexString, getAPI } = require("../utils/utils");
const { getExtensionPathOf } = require("../utils/sysutils");

/**
 *
 * @typedef { Object } ProtocolMessage
 * @property { number } seq
 * @property { 'request' | 'response' | 'event' | string } type
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
 * @typedef { ProtocolMessage & ProtocolResponse } Response
 * @typedef { ProtocolMessage & ProtocolEvent } Event
 */

/**
 * @typedef { import("./base-process-handle").DebuggerProcessBase } DebuggerProcessBase
 * @typedef { import("../spawn").SpawnConfig } SpawnConfig
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

  /**
   * @type { SpawnConfig }
   */
  spawnConfig;
  addressBreakpoints = [];

  /**
   * @param { new (path: string, options: string[]) => DebuggerProcessBase } DebuggerProcessConstructor
   * @param { SpawnConfig } spawnConfig
   * @param { * } terminal
   * @param { * } checkpointsUI
   * @param { {response: (res: Response) => void, events: (evt: Event) => void } | null } callbacks
   */
  constructor(DebuggerProcessConstructor, spawnConfig, terminal, checkpointsUI, callbacks) {
    super();
    this.spawnConfig = spawnConfig;
    this.#checkpointsUI = checkpointsUI;
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
    this.dbg = new DebuggerProcessConstructor(spawnConfig.path, spawnConfig?.options ?? []);
    this.#terminal = terminal;

    if(callbacks) {
      this.dbg.connectResponse(callbacks.response);
      this.dbg.connectEvents(callbacks.events);
    } else {
      this.dbg.connectResponse((response) => {
        if(!response.success) {
          const err = (response.body.error ?? { stacktrace: "No stack trace info" }).stacktrace;
          console.log(`[request error]: ${response.command} failed\n${err}`);
        }
        switch(response.command) {
          case "variables":
            this.performHexFormat(response.body.variables);
            break;
          case CustomRequests.DeleteCheckpoint:
          case CustomRequests.SetCheckpoint:
            this.#checkpointsUI.updateCheckpoints(response.body.checkpoints);
            break;
        }
        this.sendResponse(response);
      });

      this.dbg.connectEvents((evt) => {
        const { event, body } = evt;
        switch (event) {
          case "exited":
            this.sendEvent(new TerminatedEvent(false));
            this.emit("exit");
            break;
          case "output":
            this.sendEvent(new OutputEvent(body.output, "console"));
            break;
          default:
            this.sendEvent(evt);
            break;
        }
      })
    }


    this.on("error", (event) => {
      this.sendEvent(new OutputEvent(event.body, "console", event));
    });

  }

  dispose() {
    commands.executeCommand("setContext", ContextKeys.RRSession, false);
    this.disposeTerminal();
    super.dispose();
  }

  atExitCleanUp(signal) {
    this.dbg.process.kill(signal);

    if (this.spawnConfig.disposeOnExit()) this.disposeTerminal();
    else {
      if (this.#terminal) this.#terminal.disposeChildren();
    }
  }

  shutdown() {
    console.log(`SHUTDOWN CALLED`);
  }

  /**
   * @returns { import("../buildMode").MidasRunMode }
   */
  get buildSettings() {
    return this.spawnConfig.traceSettings;
  }

  log(where, output) {
    const logger = getAPI().getLogger(where);
    if (logger == undefined) {
      this.#defaultLogger(output);
    } else {
      logger.appendLine(output);
    }
  }

  performHexFormat(variables) {
    if(this.formatValuesAsHex) {
      for(let v of variables) {
        if (!isNaN(v.value)) {
          v.value = toHexString(v.value);
        }
      }
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
    this.dbg.sendRequest({ seq: response.request_seq, command: response.command }, args);
  }

  /**
   * Called at the end of the configuration sequence.
   * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
   * @param {import("@vscode/debugprotocol").DebugProtocol.ConfigurationDoneResponse} response
   * @param {import("@vscode/debugprotocol").DebugProtocol.ConfigurationDoneArguments} args
   */
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
  setBreakPointsRequestPython(response, args, request) {
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
    this.dbg.sendRequest(request, args);
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
    this.dbg.sendRequest(request, args);
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
    switch(args.context) {
      case "watch": {
        const ishex_pos = args.expression.lastIndexOf(",x");
        if(ishex_pos != -1) {
          args.expression = args.expression.substring(0, ishex_pos);
          args.format = { hex: true };
        }
      } break;
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

  /**
   * Override this hook to implement custom requests.
   */
  // eslint-disable-next-line no-unused-vars
  customRequest(command, response, args, request) {
    request.type = "request";
    request.command = command;
    switch(command) {
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
      case CustomRequests.RunToEvent: {
        window.showInputBox().then(event_number => {
          const num = Number.parseInt(event_number);
          if(Number.isNaN(num)) {
            this.sendErrorResponse(response, 0, "Run To Event requires a number as input.");
            return;
          }
          request.arguments = { event: num }
          this.dbg.sendRequest(request);
        })
        break;
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

  disposeTerminal() {
    this.#terminal?.dispose();
  }

  get terminal() {
    return this.#terminal;
  }

  getSpawnConfig() {
    return this.spawnConfig;
  }
}

module.exports = {
  MidasSessionBase
}