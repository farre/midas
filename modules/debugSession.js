"use strict";

const DebugAdapter = require("@vscode/debugadapter");
const vscode = require("vscode");

// eslint-disable-next-line no-unused-vars
const { DebugProtocol } = require("@vscode/debugprotocol");
const { GDB, VSCodeVariable } = require("./gdb");
const { Subject } = require("await-notify");
const fs = require("fs");
const net = require("net");
const { isReplaySession } = require("./utils");
const { ExecutionContextState } = require("./executionContextState");

let server;

class MidasDebugSession extends DebugAdapter.DebugSession {
  /** @type { GDB } */
  gdb;

  /** @type { Subject } */
  configIsDone;
  _reportProgress;
  useInvalidetedEvent;

  withRR = false;

  /** @type {vscode.Terminal} */
  #terminal;

  #buildSettings;

  // eslint-disable-next-line no-unused-vars
  constructor(debuggerLinesStartAt1, isServer = false, fileSystem = fs, buildSettings) {
    super();
    // NB! i have no idea what thread id this is supposed to refer to
    this.#buildSettings = buildSettings;
    this.configIsDone = new Subject();
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);

    this.on("error", (event) => {
      console.log(event.body);
    });
  }

  /**
   * @returns { import("./buildMode").MidasRunMode }
   */
  get buildSettings() {
    return this.#buildSettings;
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
    // response.body.supportsValueFormattingOptions = true;

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
    DebugAdapter.logger.setup(args.trace ? DebugAdapter.Logger.LogLevel.Verbose : DebugAdapter.Logger.LogLevel.Stop, false);
    // wait until configuration has finished (and configurationDoneRequest has been called)
    await this.configIsDone.wait(1000);
    this.sendResponse(response);

    if (isReplaySession(args)) {
      this.gdb = new GDB(this, args);
      this.gdb.withRR = true;
      this.gdb.setupEventHandlers(args.stopOnEntry);
      await this.gdb.startWithRR(args.program, args.stopOnEntry);
    } else if (args.type == "midas") {
      this.gdb = new GDB(this, args);
      this.gdb.setupEventHandlers(args.stopOnEntry);
      await this.gdb.start(args.program, args.stopOnEntry, args.allStopMode ?? false);
    }
  }

  // eslint-disable-next-line no-unused-vars
  async setBreakPointsRequest(response, args, request) {
    // todo(simon): room for optimization. instead of emptying and re-setting, just remove those not in request.
    const res = await this.gdb.setBreakpointsInFile(args.source.path, args.breakpoints);
    this.gdb.vscodeBreakpoints.set(args.source.path, res);
    response.body = {
      breakpoints: res,
    };
    this.sendResponse(response);
  }

  dataBreakpointInfoRequest(response, args, request) {
    let container = this.gdb.references.get(args.variablesReference);
    let dataId;
    if(container) {
      let prefix = container.evaluatePath();
      if(prefix == "") dataId = args.name;
      else dataId = `${prefix}.${args.name}`;
    } else {
      dataId = args.name;
    }
    response.body = {
      dataId: dataId,
      accessTypes: ["read", "write", "readWrite"],
      canPersist: false
    };
    this.sendResponse(response);
  }

  async setDataBreakpointsRequest(response, args, request) {
    const res = await this.gdb.updateWatchpoints(args.breakpoints);
    response.body = {
      breakpoints: res
    }
    this.sendResponse(response);
  }

  // eslint-disable-next-line no-unused-vars
  async continueRequest(response, args) {
    // todo(simon): for rr this needs to be implemented differently
    response.body = {
      allThreadsContinued: this.gdb.allStopMode,
    };
    await this.gdb.continue(this.gdb.allStopMode ? undefined : args.threadId, false);
    vscode.commands.executeCommand("setContext", "midas.notRunning", false);
    this.sendResponse(response);
  }

  async setFunctionBreakPointsRequest(response, args) {
    let res = [];
    for (let { name, condition, hitCondition } of args.breakpoints) {
      res.push(this.gdb.setFunctionBreakpoint(name, condition, hitCondition));
    }
    response.body = {
      breakpoints: await Promise.all(res).then((res) => res.map(() => new DebugAdapter.Breakpoint(true))),
    };
    this.sendResponse(response);
  }

  // eslint-disable-next-line no-unused-vars
  async pauseRequest(response, args) {
    await this.gdb.pauseExecution(args.threadId);
    vscode.commands.executeCommand("setContext", "midas.notRunning", true);
    this.sendResponse(response);
  }

  async threadsRequest(response) {
    response.body = {
      threads: await this.gdb.threads(),
    };
    this.sendResponse(response);
  }

  async stackTraceRequest(response, args) {
    let ec = this.gdb.getExecutionContext(args.threadId);
    // this is an unfortunate hack, since VSCode double-fires this request, possibly a VSCode bug.
    if(ec == undefined) {
      this.gdb.executionContexts.set(args.threadId, new ExecutionContextState(args.threadId));
      ec = this.gdb.getExecutionContext(args.threadId);
    }
    await ec.pendingStackTrace;
    ec.pendingStackTrace = new Promise(async resolve => {
      let exec_ctx = this.gdb.executionContexts.get(args.threadId);
      if (args.startFrame == 0) {
        await this.gdb.buildExecutionState(args.threadId, args.levels);
        response.body = {
          stackFrames: exec_ctx.stack,
        };
      } else {
        const frames = await this.gdb.requestMoreFrames(args.threadId, args.levels);
        response.body = {
          stackFrames: frames
        };
      }
      this.sendResponse(response);
      resolve();
    });
  }

  async variablesRequest(response, args) {
    // unfortunately, due to the convoluted nature of GDB MI's approach, we discard the changelist
    // and instead read the values with -var-evaluate-expression calls.
    // However, we must call this, otherwise the var objs do not get updated in the backend
    const { variablesReference } = args;

    let handler = this.gdb.references.get(variablesReference);
    if (handler) {
      const prepared_response = await handler.handleRequest(response, this.gdb);
      this.sendResponse(prepared_response);
      return;
    }

    let evaluatableVar = this.gdb.evaluatableStructuredVars.get(variablesReference);
    if (evaluatableVar) {
      await this.handleStructFromEvaluatableRequest(response, evaluatableVar);
      return;
    }
  }

  async handleStructFromEvaluatableRequest(response, struct) {
    // todo(simon): this is logic that DebugSession should not handle. Partially, this stuff gdb.js should be responsible for
    if (struct.memberVariables.length == 0) {
      // we haven't cached it's members
      let structAccessModifierList = await this.gdb.execMI(`-var-list-children --all-values "${struct.variableObjectName}"`);
      let requests = [];
      for (const accessModifier of structAccessModifierList.children) {
        const membersCommands = `-var-list-children --all-values "${accessModifier.value.name}"`;
        let members = await this.gdb.execMI(membersCommands);
        const expr = members.children[0].value.exp;
        if (expr) {
          requests.push(members);
        }
      }
      for (let v of requests.flatMap((i) => i.children)) {
        let nextRef = 0;
        let displayValue = "";
        let isStruct = false;
        if (!v.value.value || v.value.value == "{...}") {
          let nextRef = this.gdb.nextVarRef;
          this.gdb.evaluatableStructuredVars.set(nextRef, {
            variableObjectName: v.value.name,
            memberVariables: [],
          });
          displayValue = v.value.type;
          isStruct = true;
        } else {
          displayValue = v.value.value;
          isStruct = false;
        }
        struct.memberVariables.push(new VSCodeVariable(v.value.exp, displayValue, nextRef, v.value.name, isStruct));
      }
      response.body = {
        variables: struct.memberVariables,
      };
      this.sendResponse(response);
    } else {
      for (const member of struct.memberVariables) {
        if (!member.isStruct) {
          let r = (await this.gdb.execMI(`-var-evaluate-expression ${member.voName}`)).value;
          if (r) {
            member.value = r;
          }
        }
      }
      response.body = {
        variables: struct.memberVariables,
      };
      this.sendResponse(response);
    }
  }

  createScope(name, hint, variablesReference, expensive = false) {
    return {
      name: name,
      variablesReference: variablesReference,
      expensive: expensive,
      presentationHint: hint,
    };
  }
  scopesRequest(response, args) {
    const scopes = [];
    let locals = this.gdb.getReferenceContext(args.frameId);
    // @ts-ignore
    if(locals) {
      let registers = this.createScope("Register", "registers", locals.registerScopeIdentifier, false);
      let locals_scope = this.createScope("Locals", "locals", args.frameId, false);
      // @ts-ignore
      let args_scope = this.createScope("Args", "arguments", locals.argScopeIdentifier, false);
  
      scopes.push(args_scope, locals_scope, registers);
      response.body = {
        scopes: scopes,
      };
    }
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
        socket.on("end", () => { });
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
    let ref = this.gdb.references.get(variablesReference);
    if (!ref) {
      // for now, we disallow setting value of watch variables.
      // todo(simon): fix this.
      this.sendResponse(response);
    } else {
      const prepared_response = await ref.update(response, this.gdb, name, value);
      this.sendResponse(prepared_response);
    }
  }

  runInTerminalRequest(...args) {
    return this.virtualDispatch(...args);
  }

  // Super's implementation is fine.
  // dispatchRequest(...args) {
  // return super.dispatchRequest(args[0]);
  // }

  // Super's implementation is fine.
  disconnectRequest(response, args) {
    this.gdb.kill();
    // todo(simon): add possibility to disconnect *without* killing the rr process.
    if (this.#terminal) this.#terminal.dispose();
    return super.disconnectRequest(args[0], args[1], args[3]);
  }

  attachRequest(...args) {
    return this.virtualDispatch(...args);
  }

  terminateRequest(response, args, request) {
    super.terminateRequest(response, args, request);
    this.gdb.kill();
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

  async evaluateRequest(response, args, request) {
    response.body = {
      result: null,
      type: "some type",
      presentationHint: {
        kind: "class",
      },
      variablesReference: 0,
    };
    let { expression, frameId, context } = args;
    if (context == "watch") {
      await this.gdb
        .evaluateExpression(expression, frameId)
        .then((data) => {
          if (data) {
            response.body.variablesReference = data.variablesReference;
            response.body.result = data.value;
          }
          this.sendResponse(response);
        })
        .catch((err) => {
          // means expression did not exist
          response.success = false;
          response.message = "could not be evaluated";
          this.sendResponse(response);
        });
    } else if (context == "repl") {
      vscode.debug.activeDebugConsole.appendLine(
        "REPL is semi-unsupported currently: any side effects you cause are not guaranteed to be seen in the UI"
      );
      try {
        let msg = await this.gdb.replInput(expression);
        response.body.message = msg;
        response.body.result = msg;
        this.sendResponse(response);
      } catch (err) {
        response.body.result = `Error: ${err}`;
        response.body.message = `Error: ${err}`;
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

  cancelRequest(...args) {
    return this.virtualDispatch(...args);
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
  async customRequest(command, response, args) {
    switch (command) {
      case "continueAll":
        await this.gdb.continueAll();
        response.body = {
          allThreadsContinued: this.gdb.allStopMode,
        };
        this.sendResponse(response);
        break;
      case "pauseAll":
        await this.gdb.pauseAll();
        break;
      case "reverse-finish":
        await this.gdb.finishExecution(undefined, true);
        this.sendResponse(response);
        break;
      case "hot-reload-scripts":
        try {
          await this.gdb.reload_scripts();
          console.log(`Successfully hot reloaded scripts`);
        } catch(err) {
          console.log(`failed to reload scripts ${err}`);
        }
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
  registerTerminal(terminal) {
    this.#terminal = terminal;
  }

  reloadScripts() {
    this.gdb.setup();
  }
}

module.exports = {
  MidasDebugSession,
};
