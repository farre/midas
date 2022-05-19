"use strict";

const DebugAdapter = require("@vscode/debugadapter");
const vscode = require("vscode");

// eslint-disable-next-line no-unused-vars
const { DebugProtocol } = require("@vscode/debugprotocol");
const { GDB } = require("./gdb");
const { Subject } = require("await-notify");
const fs = require("fs");
const net = require("net");
const { isNothing, ContextKeys, toHexString } = require("./utils");
const nixkernel = require("./kernelsettings");
let server;

let REPL_MESSAGE_SHOWN = 0;

class MidasDebugSession extends DebugAdapter.DebugSession {
  /** @type { Set<number> } */
  formattedVariablesMap = new Set();
  /** @type { GDB } */
  gdb;

  /** @type { Subject } */
  configIsDone;
  _reportProgress;
  useInvalidetedEvent;
  /** @type {import("./terminalInterface").TerminalInterface} */
  #terminal;

  fnBkptChain = Promise.resolve();

  #buildSettings;

  #spawnConfig;
  /** @type {import("./ui/checkpoints/checkpoints").CheckpointsViewProvider }*/
  #checkpointsUI;
  // eslint-disable-next-line no-unused-vars
  constructor(debuggerLinesStartAt1, isServer = false, fileSystem = fs, spawnConfig, terminal, checkpointsUI) {
    super();
    // NB! i have no idea what thread id this is supposed to refer to
    this.#spawnConfig = spawnConfig;
    this.configIsDone = new Subject();
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);

    this.on("error", (event) => {
      console.log(event.body);
    });
    this.#checkpointsUI = checkpointsUI;
    this.#terminal = terminal;
  }

  /**
   * @returns { import("./buildMode").MidasRunMode }
   */
  get buildSettings() {
    return this.#spawnConfig.traceSettings;
  }

  /**
   * As per Mock debug adapter:
   * The 'initialize' request is the first request called by the frontend
   * to interrogate the features the debug adapter provides.
   * @param {DebugProtocol.InitializeResponse} response
   * @param {DebugProtocol.InitializeRequestArguments} args
   */
  initializeRequest(response, args) {
    this._reportProgress = args.supportsProgressReporting;

    this.useInvalidetedEvent = args.supportsInvalidatedEvent;

    // build and return the capabilities of this debug adapter:
    response.body = response.body || {};
    // the adapter implements the configurationDone request.
    response.body.supportsConfigurationDoneRequest = true;
    // response.body.supportsEvaluateForHovers = true;

    response.body.supportsReadMemoryRequest;
    // make VS Code show a 'step back' button
    response.body.supportsStepBack = true;
    // make VS Code support data breakpoints
    response.body.supportsDataBreakpoints = true;
    // make VS Code support completion in REPL
    response.body.supportsCompletionsRequest = false;
    response.body.completionTriggerCharacters = [".", "["];
    // make VS Code send cancel request
    response.body.supportsCancelRequest = true;

    // this option actually would require LSP support; since we would have to
    // scan the source code and analyze it for possible ways to set a breakpoint.
    // We are language server agnostic, for a reason: speed.
    response.body.supportsBreakpointLocationsRequest = false;

    response.body.supportsConditionalBreakpoints = true;
    response.body.supportsFunctionBreakpoints = true;
    // make VS Code provide "Step in Target" functionality
    response.body.supportsStepInTargetsRequest = true;
    // the adapter defines two exceptions filters, one with support for conditions.
    response.body.supportsExceptionFilterOptions = true;
    response.body.supportsGotoTargetsRequest = true;
    response.body.supportsHitConditionalBreakpoints = true;
    response.body.supportsSetVariable = true;

    response.body.supportsRestartFrame = true;

    // leave uncommented. Because it does nothing. Perhaps implement it for them?
    response.body.supportsValueFormattingOptions = true;

    response.body.supportsRestartRequest = true;

    // Enable this when we upgrade to DAP 1.51.0
    response.body.supportsSingleThreadExecutionRequests = true;

    // make VS Code send exceptionInfo request
    response.body.supportsExceptionInfoRequest = true;
    // make VS Code send setExpression request
    response.body.supportsSetExpression = true;
    // make VS Code send disassemble request
    response.body.supportsDisassembleRequest = true;
    response.body.supportsSteppingGranularity = true;
    response.body.supportsInstructionBreakpoints = true;

    // we'll use this to brute force VSCode to not request 20 stack frames. N.B: does not work.
    // response.body.supportsDelayedStackTraceLoading = true;
    this.sendResponse(response);
  }

  /**
   * Called at the end of the configuration sequence.
   * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
   * @param {DebugProtocol.ConfigurationDoneResponse} response
   * @param {DebugProtocol.ConfigurationDoneArguments} args
   * @returns {void}
   */
  configurationDoneRequest(response, args) {
    super.configurationDoneRequest(response, args);
    // notify the launchRequest that configuration has finished
    this.configIsDone.notify();
  }

  // eslint-disable-next-line no-unused-vars
  async launchRequest(response, args, request) {
    DebugAdapter.logger.setup(
      args.trace ? DebugAdapter.Logger.LogLevel.Verbose : DebugAdapter.Logger.LogLevel.Stop,
      false
    );
    // wait until configuration has finished (and configurationDoneRequest has been called)
    await this.configIsDone.wait(1000);
    this.sendResponse(response);
    if (args.type == "midas-rr") {
      vscode.commands.executeCommand("setContext", ContextKeys.RRSession, true);
      this.gdb = new GDB(this, this.#spawnConfig);
      this.gdb.setupEventHandlers(args.stopOnEntry);
      await this.gdb.startWithRR(args.program, args.stopOnEntry);
    } else {
      this.gdb = new GDB(this, this.#spawnConfig);
      this.gdb.setupEventHandlers(args.stopOnEntry);
      await this.gdb.start(args);
    }
  }

  // eslint-disable-next-line no-unused-vars
  async attachRequest(response, args, request) {
    await this.configIsDone.wait(1000);
    let ptraceScope = 0;
    try {
      ptraceScope = nixkernel.readPtraceScope();
    } catch (e) {
      vscode.window.showErrorMessage(
        "You are running an old Linux which does not have the Yama security module. Attempting to attach."
      );
    }
    if (ptraceScope == 1) {
      const Message = {
        /** Unique identifier for the message. */
        id: 1,
        format:
          "Ptrace privileges are restricted. Run 'sudo sysctl kernel.yama.ptrace_scope=0' to allow non-children to ptrace other processes.",
        showUser: true,
        /** An optional url where additional information about this message can be found. */
        url: "https://askubuntu.com/questions/41629/after-upgrade-gdb-wont-attach-to-process",
        /** An optional label that is presented to the user as the UI for opening the url. */
        urlLabel: "Read more about ptrace privileges",
      };
      this.sendErrorResponse(response, Message);
      return;
    }
    this.gdb = new GDB(this, this.#spawnConfig);
    this.gdb.setupEventHandlers(false);
    await this.gdb.attach_start(args.program);
    this.sendResponse(response);
  }

  // eslint-disable-next-line no-unused-vars
  async setBreakPointsRequest(response, args, request) {
    // todo(simon): room for optimization. instead of emptying and re-setting, just remove those not in request.
    // await this.setBreakPointsRequestPython(response, args, request)
    const res = await this.gdb.setBreakpointsInFile(args.source.path, args.breakpoints);
    this.gdb.vscodeBreakpoints.set(args.source.path, res);
    response.body = {
      breakpoints: res,
    };
    this.sendResponse(response);
  }

  // eslint-disable-next-line no-unused-vars
  async setBreakPointsRequestPython(response, args, request) {
    const serialized_request = JSON.stringify(args);
    const prepared = serialized_request.replaceAll(`"`, `'`);
    const cmd = `setbreakpoints ${prepared}`;
    response.body = await this.exec(cmd);
    this.sendResponse(response);
  }

  // eslint-disable-next-line no-unused-vars
  async dataBreakpointInfoRequest(response, args, request) {
    response.body = await this.exec(`data-breakpoint-info ${args.name} ${args.variablesReference}`);
    this.sendResponse(response);
  }
  // eslint-disable-next-line no-unused-vars
  async setDataBreakpointsRequest(response, args, request) {
    const res = await this.gdb.updateWatchpoints(args.breakpoints);
    response.body = {
      breakpoints: res,
    };
    this.sendResponse(response);
  }

  // eslint-disable-next-line no-unused-vars
  async continueRequest(response, args) {
    // todo(simon): for rr this needs to be implemented differently
    response.body = {
      allThreadsContinued: this.gdb.allStopMode,
    };
    this.gdb.interrupt_operations();
    await this.gdb.continue(this.gdb.allStopMode ? undefined : args.threadId, false);

    vscode.commands.executeCommand("setContext", ContextKeys.Running, true);
    this.sendResponse(response);
  }

  async setFunctionBreakPointsRequest(response, args) {
    this.fnBkptChain = this.fnBkptChain.then(async () => {
      let res = [];
      this.gdb.removeFnBreakpointsNotInList(args.breakpoints.map((bp) => bp.name));
      for (let { name, condition, hitCondition } of args.breakpoints) {
        res.push(await this.gdb.setFunctionBreakpoint(name, condition, hitCondition));
      }
      response.body = {
        breakpoints: res,
      };
      this.sendResponse(response);
    });
  }

  // eslint-disable-next-line no-unused-vars
  async pauseRequest(response, args) {
    await this.gdb.pauseExecution(args.threadId);
    vscode.commands.executeCommand("setContext", ContextKeys.Running, false);
    this.sendResponse(response);
  }

  async threadsRequest(response) {
    response.body = {
      threads: await this.gdb.threads(),
    };
    this.sendResponse(response);
  }

  async stackTraceRequest(response, { threadId, startFrame, levels }) {
    response.body = await this.exec(`stacktrace-request ${threadId} ${startFrame} ${levels}`);
    this.sendResponse(response);
  }

  async variablesRequest(response, { variablesReference }, request) {
    response.body = await this.exec(`variable-request ${variablesReference}`);
    this.checkForHexFormatting(variablesReference, response.body.variables);
    this.sendResponse(response);
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

  async scopesRequest(response, { frameId }) {
    response.body = await this.exec(`scopes-request ${frameId}`);
    this.sendResponse(response);
  }

  // "VIRTUAL FUNCTIONS" av DebugSession som behövs implementeras (några av dom i alla fall)
  static run(port) {
    if (!port) {
      DebugAdapter.DebugSession.run(MidasDebugSession);
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
        const session = new MidasDebugSession();
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

  async setVariableRequest(response, { variablesReference, name, value }) {
    // todo: needs impl in new backend
    this.sendResponse(response);
  }

  runInTerminalRequest(...args) {
    return this.virtualDispatch(...args);
  }

  // Super's implementation is fine.
  // dispatchRequest(...args) {
  // return super.dispatchRequest(args[0]);
  // }

  async disconnectRequest(response, args) {
    this.gdb.kill();
    this.gdb.cleanup();
    this.sendResponse(response);
    this.shutdown();
  }

  terminateRequest(response, args, request) {
    super.terminateRequest(response, args, request);
    this.gdb.kill();
    this.gdb.cleanup();
  }

  async restartRequest(response, { arguments: args }) {
    const { program, stopOnEntry } = args;
    await this.gdb.restart(program, stopOnEntry);
    this.sendResponse(response);
  }

  setExceptionBreakPointsRequest(...args) {
    return this.virtualDispatch(...args);
  }

  async nextRequest(response, args) {
    let granularity = args.granularity ?? "line";
    switch (granularity) {
      case "line":
        await this.gdb.stepOver(args.threadId);
        break;
      case "instruction":
        await this.gdb.stepInstruction(args.threadId);
        break;
      case "statement":
      default:
    }
    this.sendResponse(response);
  }

  async stepInRequest(response, args) {
    switch (args.granularity ?? "line") {
      case "statement":
        // todo(simon): examine if we will be able to step into "statements" without language server insight into the code
        await this.gdb.stepIn(args.threadId);
        break;
      case "line":
        await this.gdb.stepIn(args.threadId);
        break;
      case "instruction":
        // todo(simon): introduce stepping down to assembly level, once disassemble-feature is completed
        await this.gdb.stepIn(args.threadId);
        break;
    }
    this.sendResponse(response);
  }

  async stepOutRequest(response, args) {
    this.gdb.finishExecution(args.threadId);
    this.sendResponse(response);
  }

  async stepBackRequest(response, args) {
    let granularity = args.granularity ?? "line";
    switch (granularity) {
      case "line":
        await this.gdb.stepOver(args.threadId, true);
        break;
      case "instruction":
        await this.gdb.stepInstruction(args.threadId, true);
        break;
      case "statement":
      default:
        await this.gdb.stepOver(args.threadId, true);
    }
    this.sendResponse(response);
  }

  async reverseContinueRequest(response, args) {
    // todo(simon): for rr this needs to be implemented differently
    response.body = {
      allThreadsContinued: this.gdb.allStopMode,
    };
    await this.gdb.continue(this.gdb.allStopMode ? undefined : args.threadId, true);
    this.sendResponse(response);
  }

  restartFrameRequest(...args) {
    return this.virtualDispatch(...args);
  }

  gotoRequest(...args) {
    return this.virtualDispatch(...args);
  }

  sourceRequest(...args) {
    return this.virtualDispatch(...args);
  }

  terminateThreadsRequest(...args) {
    return this.virtualDispatch(...args);
  }

  setExpressionRequest(...args) {
    return this.virtualDispatch(...args);
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
    const { name, subscript } = result;
    return {
      name: name.endsWith(",x") ? name.substring(0, name.length - 2) : name,
      formatting: expression.endsWith(",x") ? "hex" : "none",
      subscript,
    };
  }
  // eslint-disable-next-line no-unused-vars
  async evaluateRequest(response, args, request) {
    const { expression, frameId, context } = args;
    if (context == "watch") {
      try {
        // meeeeeh. This is what you get for not having real types.
        const { name, formatting, subscript } = this.parse_evaluate_request_parameters(expression);
        const cmd = `watch-variable ${name} ${frameId} ${subscript.begin} ${subscript.end}`;
        let { body, success, message } = await this.exec(cmd);
        if (formatting == "hex" && success) {
          if (body.variablesReference > 0) {
            this.formattedVariablesMap.add(Number.parseInt(body.variablesReference));
          }
          if (!isNaN(body.result)) {
            body.result = toHexString(body.result);
          }
        }
        response.body = body;
        response.success = success;
        response.message = message;
        this.sendResponse(response);
      } catch (ex) {
        response.body = null;
        response.success = false;
        response.message = "watch expression wrong format";
        this.sendResponse(response);
      }
    } else if (context == "repl") {
      if (!REPL_MESSAGE_SHOWN) {
        vscode.debug.activeDebugConsole.appendLine(
          "REPL is semi-unsupported currently: any side effects you cause are not guaranteed to be seen in the UI"
        );
        REPL_MESSAGE_SHOWN += 1;
      }
      try {
        let msg = await this.gdb.replInput(expression);
        response.body = { result: msg };
        response.message = msg;
        this.sendResponse(response);
      } catch (err) {
        response.body = { result: `Error: ${err}` };
        response.message = `Error: ${err}`;
        response.success = false;
        this.sendResponse(response);
      }
    }
  }

  stepInTargetsRequest(...args) {
    return this.virtualDispatch(...args);
  }

  gotoTargetsRequest(...args) {
    return this.virtualDispatch(...args);
  }

  completionsRequest(...args) {
    return this.virtualDispatch(...args);
  }

  exceptionInfoRequest(...args) {
    return this.virtualDispatch(...args);
  }

  loadedSourcesRequest(...args) {
    return this.virtualDispatch(...args);
  }

  readMemoryRequest(...args) {
    return this.virtualDispatch(...args);
  }

  writeMemoryRequest(...args) {
    return this.virtualDispatch(...args);
  }

  disassembleRequest(...args) {
    return this.virtualDispatch(...args);
  }

  cancelRequest(response, args, request) {
    return this.virtualDispatch(response, args, request);
  }

  breakpointLocationsRequest(...args) {
    return this.virtualDispatch(...args);
  }

  setInstructionBreakpointsRequest(...args) {
    return this.virtualDispatch(...args);
  }

  /**
   * Override this hook to implement custom requests.
   */
  // eslint-disable-next-line no-unused-vars
  async customRequest(command, response, args) {
    switch (command) {
      case "continueAll":
        await this.gdb.continueAll();
        response.body = {
          allThreadsContinued: this.gdb.allStopMode,
        };
        this.sendResponse(response);
        this.gdb.sendContinueEvent(1, true);
        break;
      case "pauseAll":
        await this.gdb.pauseAll();
        let evt = { body: { reason: "pause", allThreadsStopped: true } };
        this.gdb.sendEvent(evt);
        break;
      case "reverse-finish":
        await this.gdb.finishExecution(undefined, true);
        this.sendResponse(response);
        break;
      case "hot-reload-scripts":
        try {
          await this.gdb.reload_scripts();
          vscode.window.showInformationMessage(`Successfully reloaded backend scripts`);
        } catch (err) {
          vscode.window.showInformationMessage(`Failed to re-initialize midas`);
        }
        break;
      case "spawnConfig":
        return this.#spawnConfig;
      case "setRRCheckpointRequest":
        let cp = await this.gdb.execCLI("checkpoint");
        this.#checkpointsUI.addCheckpoint(parseCheckpoint(cp));
        break;
      default:
        vscode.window.showInformationMessage(`Unknown request: ${command}`);
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

  // terminal where rr has been started in
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

  reloadScripts() {
    this.gdb.setup();
  }

  async exec(cmd) {
    return await this.gdb.execCMD(cmd);
  }

  disposeTerminal() {
    this.#terminal.dispose();
  }

  get terminal() {
    return this.#terminal;
  }

  getSpawnConfig() {
    return this.#spawnConfig;
  }
}

let cpID = 0;

/**
 *
 * @param {string} checkpointResultString
 * @returns {{ id: number, when: number, file: string, path: string, line: number }}
 */
function parseCheckpoint(checkpointResultString) {
  return { id: cpID++, when: 0, file: "baz.c", path: "/foo/bar", line: 1 };
}

module.exports = {
  MidasDebugSession,
};
