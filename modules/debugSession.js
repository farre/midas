"use strict";

const DebugAdapter = require("@vscode/debugadapter");
const vscode = require("vscode");

// eslint-disable-next-line no-unused-vars
const { DebugProtocol } = require("@vscode/debugprotocol");
const { GDB, MidasVariable } = require("./gdb");
const { Subject } = require("await-notify");
const fs = require("fs");
const net = require("net");
const { Server } = require("http");

let server;

class DebugSession extends DebugAdapter.DebugSession {
  /** @type { GDB } */
  gdb;

  /** @type {number} */
  threadId;

  /** @type { Subject } */
  configIsDone;

  _reportProgress;
  useInvalidetedEvent;

  // eslint-disable-next-line no-unused-vars
  constructor(debuggerLinesStartAt1, isServer = false, fileSystem = fs) {
    super();
    // NB! i have no idea what thread id this is supposed to refer to
    this.threadId = 1;
    this.configIsDone = new Subject();
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);

    this.on("error", (event) => {
      console.log(event.body);
    });
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

    // leave uncommented. Because it does nothing. Perhaps implement it for them?
    // response.body.supportsValueFormattingOptions = true;

    response.body.supportsRestartRequest = true;

    // Enable this when we upgrade to DAP 1.51.0
    // response.body.supportsSingleThreadExecutionRequests = true;

    response.body.exceptionBreakpointFilters = [
      {
        filter: "namedException",
        label: "Named Exception",
        description: `Break on named exceptions. Enter the exception's name as the Condition.`,
        default: false,
        supportsCondition: true,
        conditionDescription: `Enter the exception's name`,
      },
      {
        filter: "otherExceptions",
        label: "Other Exceptions",
        description: "This is a other exception",
        default: true,
        supportsCondition: false,
      },
    ];
    // make VS Code send exceptionInfo request
    response.body.supportsExceptionInfoRequest = true;
    // make VS Code send setExpression request
    response.body.supportsSetExpression = true;
    // make VS Code send disassemble request
    response.body.supportsDisassembleRequest = true;
    response.body.supportsSteppingGranularity = true;
    response.body.supportsInstructionBreakpoints = true;
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

    this.gdb = new GDB(this, args.program, args.gdbPath, args.debuggeeArgs);
    this.gdb.initialize(args.stopOnEntry);

    await this.gdb.start(args.program, args.stopOnEntry, !args.noDebug, args.trace, args.allStopMode ?? false);
  }

  async setBreakPointAtLine(path, line) {
    let id = 0;
    if (this.gdb) {
      let breakpoint = await this.gdb.setBreakPointAtLine(path, line);
      line = breakpoint.line;
      id = breakpoint.id;
    }
    let response = {
      verified: true,
      line: line,
      id: id,
    };
    return response;
  }

  // eslint-disable-next-line no-unused-vars
  async setBreakPointsRequest(response, args, request) {
    let path = args.source.path;
    let res = [];
    // todo(simon): room for optimization. instead of emptying and re-setting, just remove those not in request.
    this.gdb.clearBreakPointsInFile(path);

    for (let { line } of args?.breakpoints ?? []) {
      res.push(this.setBreakPointAtLine(path, line));
    }

    response.body = {
      breakpoints: await Promise.all(res),
    };
    this.sendResponse(response);
  }

  // eslint-disable-next-line no-unused-vars
  async continueRequest(response, args) {
    // todo(simon): for rr this needs to be implemented differently
    response.body = {
      allThreadsContinued: this.gdb.allStopMode,
    };
    await this.gdb.continue(this.gdb.allStopMode ? undefined : args.threadId, false);
    this.sendResponse(response);
  }

  async setFunctionBreakPointsRequest(response, args) {
    this.gdb.clearFunctionBreakpoints();
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
    await this.gdb.pauseExecution(args.threadId).then(() => {});
  }

  async threadsRequest(response) {
    response.body = {
      threads: await this.gdb.threads(),
    };
    this.sendResponse(response);
  }

  /**
   * Creates a frame ID for VSCode based on the `threadId` and the `level` of the
   * provided stackframe.
   * @param {number} threadId
   * @param {number} level
   * @returns {number}
   */
  threadFrameIdentifier(threadId, level) {
    return (level << 16) | threadId;
  }

  /**
   * Reverses the process in `threadFrameIdentifier(threadId, level)` and
   * returns the thread ID and it's stack frame level
   * @param {number} frameId
   * @returns { { threadId: number, frameLevel: number } }
   */
  threadAndFrameLevelFromFrameID(frameId) {
    return {
      threadId: frameId & 0xffff,
      frameLevel: frameId >> 16,
    };
  }

  async stackTraceRequest(response, args) {
    let exec_ctx = this.gdb.executionContexts.get(args.threadId);
    if (exec_ctx.stack.length == 0) {
      response.body = {
        stackFrames: await this.gdb.getTrackedStack(exec_ctx, args.levels),
      };
      this.sendResponse(response);
    } else {
      let frameInfo = await this.gdb.readRBP(exec_ctx.threadId);
      if (+frameInfo != exec_ctx.stack[0].frameAddress) {
        // todo: we invalidate the entire stack, as soon as current != top. in the future, might scan to "chop" of stack.
        await exec_ctx.clearState();
        response.body = {
          stackFrames: await this.gdb.getTrackedStack(exec_ctx, args.levels),
        };
        this.sendResponse(response);
      } else {
        response.body = {
          stackFrames: exec_ctx.stack,
        };
        this.sendResponse(response);
      }
    }
  }

  async variablesRequest(response, args) {
    // unfortunately, due to the convoluted nature of GDB MI's approach, we discard the changelist
    // and instead read the values with -var-evaluate-expression calls.
    // However, we must call this, otherwise the var objs do not get updated in the backend
    const { variablesReference } = args;
    await this.gdb.execMI(`-var-update *`);
    let evaluatableVar = this.gdb.evaluatableStructuredVars.get(variablesReference);
    if (evaluatableVar) {
      await this.handleStructFromEvaluatableRequest(response, evaluatableVar);
      return;
    }

    const threadId = this.gdb.varRefContexts.get(variablesReference).threadId;
    let executionContext = this.gdb.executionContexts.get(threadId);
    let stackFrameLocal = executionContext.stackFrameLocals.get(variablesReference);
    if (stackFrameLocal) {
      await this.handleStackFrameLocalsVariablesRequest(response, executionContext, stackFrameLocal);
      return;
    }
    let registers = executionContext.stackFrameRegisterContents.get(variablesReference);
    if (registers) {
      this.handleStackFrameRegisterVariablesRequest(response, executionContext, registers);
      return;
    }
    let struct = executionContext.structs.get(variablesReference);
    if (struct) {
      await this.handleStructVariablesRequest(response, executionContext, struct);
      return;
    }
  }

  async handleStackFrameLocalsVariablesRequest(response, executionContext, stackFrameLocal) {
    // todo(simon): this is logic that DebugSession should not handle. Partially, this stuff gdb.js should be responsible for
    if (stackFrameLocal.variables.length == 0) {
      let result = await this.gdb.getStackLocals(executionContext.threadId, stackFrameLocal.frameLevel);
      for (const { name, type, value } of result) {
        let nextRef = this.gdb.generateVariableReference({
          threadId: executionContext.threadId,
          frameLevel: stackFrameLocal.frameLevel,
        });
        let vscodeRef = 0;
        const voname = `vr_${nextRef}`;
        let cmd = `-var-create ${voname} * ${name}`;
        if (!value) {
          vscodeRef = nextRef;
          executionContext.structs.set(nextRef, {
            variableObjectName: voname,
            frameLevel: stackFrameLocal.frameLevel,
            memberVariables: [],
          });
        }
        stackFrameLocal.variables.push(new MidasVariable(name, value ?? type, vscodeRef, voname, value ? false : true));
        await this.gdb.execMI(cmd, executionContext.threadId);
      }
      response.body = {
        variables: stackFrameLocal.variables,
      };
      this.sendResponse(response);
    } else {
      // we need to update the stack frame
      await this.gdb.updateMidasVariables(executionContext.threadId, stackFrameLocal.variables);
      response.body = {
        variables: stackFrameLocal.variables,
      };
      this.sendResponse(response);
    }
  }

  async handleStackFrameRegisterVariablesRequest(response, executionContext, stackFrameRegisters) {
    // todo(simon): this is logic that DebugSession should not handle. Partially, this stuff gdb.js should be responsible for
    await this.gdb.selectStackFrame(stackFrameRegisters.frameLevel, executionContext.threadId);
    let miResult = await this.gdb.execMI(`-data-list-register-values N ${this.gdb.generalPurposeRegCommandString}`);
    response.body = {
      variables: miResult["register-values"].map(
        (res, index) => new DebugAdapter.Variable(this.gdb.registerFile[index], res.value)
      ),
    };
    this.sendResponse(response);
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
        struct.memberVariables.push(new MidasVariable(v.value.exp, displayValue, nextRef, v.value.name, isStruct));
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
  async handleStructVariablesRequest(response, executionContext, struct) {
    // todo(simon): this is logic that DebugSession should not handle. Partially, this stuff gdb.js should be responsible for
    if (struct.memberVariables.length == 0) {
      // we haven't cached it's members
      let structAccessModifierList = await this.gdb.execMI(
        `-var-list-children --all-values "${struct.variableObjectName}"`,
        executionContext.threadId
      );
      let requests = [];
      for (const accessModifier of structAccessModifierList.children) {
        const membersCommands = `-var-list-children --all-values "${accessModifier.value.name}"`;
        let members = await this.gdb.execMI(membersCommands, executionContext.threadId);
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
          nextRef = this.gdb.generateVariableReference({ threadId: executionContext.threadId, frameLevel: struct.frameLevel });
          executionContext.structs.set(nextRef, {
            variableObjectName: v.value.name,
            frameLevel: struct.frameLevel,
            memberVariables: [],
          });
          displayValue = v.value.type;
          isStruct = true;
        } else {
          displayValue = v.value.value;
          isStruct = false;
        }
        struct.memberVariables.push(new MidasVariable(v.value.exp, displayValue, nextRef, v.value.name, isStruct));
      }
      response.body = {
        variables: struct.memberVariables,
      };
      this.sendResponse(response);
    } else {
      this.gdb.updateMidasVariables(executionContext.threadId, struct.memberVariables).then(() => {
        response.body = {
          variables: struct.memberVariables,
        };
        this.sendResponse(response);
      });
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
    let vrContext = this.gdb.varRefContexts.get(args.frameId);
    let executionContext = this.gdb.executionContexts.get(vrContext.threadId);
    let registerScopeVariablesReference = this.gdb.generateVariableReference(vrContext);
    executionContext.stackFrameRegisterContents.set(registerScopeVariablesReference, {
      frameLevel: vrContext.frameLevel,
      variables: [],
    });
    let registers = this.createScope("Register", "registers", registerScopeVariablesReference, false);
    let locals_scope = this.createScope("Locals", "locals", args.frameId, false);

    // TODO(simon): add the global scope as well; on c++ this is a rather massive one though.
    // todo(simon): retrieve frame level/address from GDB and add as "Locals" scopes
    // let parameters = {
    //   name: "Parameters",
    //   variablesReference: 0,
    //   expensive: false,
    //   presentationHint: "arguments",
    // };

    scopes.push(locals_scope, registers);
    response.body = {
      scopes: scopes,
    };
    this.sendResponse(response);
  }

  // "VIRTUAL FUNCTIONS" av DebugSession som behövs implementeras (några av dom i alla fall)
  static run(port) {
    if (!port) {
      DebugAdapter.DebugSession.run(DebugSession);
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
        const session = new DebugSession();
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

  async setVariableRequest(response, args) {
    const threadId = this.gdb.varRefContexts.get(args.variablesReference).threadId;
    let executionContext = this.gdb.executionContexts.get(threadId);
    let stackFrame = executionContext.stackFrameLocals.get(args.variablesReference);
    if (stackFrame) {
      for (const v of stackFrame.variables) {
        if (v.name == args.name) {
          let res = await this.gdb.execMI(`-var-assign ${v.voName} "${args.value}"`, threadId);
          if (res.value) {
            v.value = res.value;
            response.body = {
              value: res.value,
              variablesReference: v.variablesReference,
            };
          }
          this.sendResponse(response);
          return;
        }
      }
    } else {
      let struct = executionContext.structs.get(args.variablesReference);
      for (const v of struct.memberVariables) {
        if (v.name == args.name) {
          let res = await this.gdb.execMI(`-var-assign ${v.voName} "${args.value}"`, threadId);
          if (res.value) {
            v.value = res.value;
            response.body = {
              value: res.value,
              variablesReference: v.variablesReference,
            };
          }
          this.sendResponse(response);
          return;
        }
      }
    }
  }

  runInTerminalRequest(...args) {
    return this.virtualDispatch(...args);
  }

  // Super's implementation is fine.
  dispatchRequest(...args) {
    return super.dispatchRequest(args[0]);
  }

  // Super's implementation is fine.
  disconnectRequest(...args) {
    return super.disconnectRequest(args[0], args[1], args[3]);
  }

  attachRequest(...args) {
    return this.virtualDispatch(...args);
  }

  terminateRequest(...args) {
    return this.virtualDispatch(...args);
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

  stepBackRequest(...args) {
    return this.virtualDispatch(...args);
  }

  async reverseContinueRequest(response, args) {
    // todo(simon): for rr this needs to be implemented differently
    response.body = {
      allThreadsContinued: this.gdb.allStopMode,
    };
    await this.gdb.continue(this.gdb.allStopMode ? undefined : args.threadId, true);
    this.sendResponse(response);
    return this.virtualDispatch(...args);
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

    if (args.context == "watch") {
      await this.gdb
        .evaluateExpression(args.expression, args.frameId)
        // .execMI(`-data-evaluate-expression ${args.expression}`)
        .then((data) => {
          if (data) {
            if (data.variablesReference != 0) {
              response.body.variablesReference = data.variablesReference;
              response.body.result = "{ ... }";
            } else {
              response.body.result = data.value;
            }
          }
          this.sendResponse(response);
        })
        .catch((err) => {
          response.success = false;
          response.message = "could not be evaluated";
          this.sendResponse(response);
        });
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

  dataBreakpointInfoRequest(...args) {
    return this.virtualDispatch(...args);
  }

  setDataBreakpointsRequest(...args) {
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
        this.gdb.continueAll();
        break;
      case "pauseAll":
        this.gdb.pauseAll();
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
}

class ConfigurationProvider {
  // eslint-disable-next-line no-unused-vars
  async resolveDebugConfiguration(folder, config, token) {
    // if launch.json is missing or empty
    if (!config || !config.type || config.type == undefined) {
      vscode.window.showErrorMessage("Cannot start debugging because no launch configuration has been provided.").then(() => {
        return null;
      });

      return null;
    }

    if (!config.type && !config.request && !config.name) {
      const editor = vscode.window.activeTextEditor;
      if (editor && (editor.document.languageId === "cpp" || editor.document.languageId === "c")) {
        config.type = "midas";
        config.name = "Launch Debug";
        config.request = "launch";
        config.stopOnEntry = true;
        config.trace = false;
        config.allStopMode = false;
      }
    }

    if (!config.program) {
      await vscode.window.showInformationMessage("Cannot find a program to debug").then(() => {});
      return null;
    }
    vscode.commands.executeCommand("setContext", "midas.allStopModeSet", config.allStopMode);
    return config;
  }
}

module.exports = {
  DebugSession,
  ConfigurationProvider,
};
