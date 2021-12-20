"use strict";

const DebugAdapter = require("vscode-debugadapter");
const vscode = require("vscode");

// eslint-disable-next-line no-unused-vars
const { DebugProtocol } = require("vscode-debugprotocol");
const { GDB, MidasVariable } = require("./gdb");
const { Subject } = require("await-notify");
// eslint-disable-next-line no-unused-vars
const { Thread } = require("gdb-js");
const fs = require("fs");
const net = require("net");
// eslint-disable-next-line no-unused-vars
const { Server } = require("http");
const { VariableObject } = require("./gdbtypes");
const { VariableHandler, STACK_ID_START } = require("./variablesHandler");

let server;

/**
 * Creates a Scope object. Calling vscode-debugadapter's Scope constructor, does not provide the implementation
 * of debug protocol scope that we need.
 * @param { number } variableReference
 * @returns { { name: string, variablesReference: number, expensive: boolean, presentationHint: string }}
 */
const createLocalScope = (variableReference) => {
  return {
    name: "locals",
    variablesReference: variableReference,
    expensive: false,
    presentationHint: "locals",
  };
};

class DebugSession extends DebugAdapter.DebugSession {
  /** @type { GDB } */
  gdb;

  /** @type {number} */
  threadId;

  /** @type { Subject } */
  configIsDone;

  /** @type { VariableHandler } */
  variableHandler;

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
    this.variableHandler = new VariableHandler();

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
    // make VS Code use 'evaluate' when hovering over source
    response.body.supportsEvaluateForHovers = true;
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
    DebugAdapter.logger.setup(
      args.trace
        ? DebugAdapter.Logger.LogLevel.Verbose
        : DebugAdapter.Logger.LogLevel.Stop,
      false
    );
    // wait until configuration has finished (and configurationDoneRequest has been called)
    await this.configIsDone.wait(1000);
    this.sendResponse(response);

    this.gdb = new GDB(this, args.program, args.gdbPath, args.debuggeeArgs);
    this.gdb.initialize(args.stopOnEntry);

    await this.gdb.start(
      args.program,
      args.stopOnEntry,
      !args.noDebug,
      args.trace,
      args.allStopMode ?? false
    );
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
    await this.gdb.continue(
      this.gdb.allStopMode ? undefined : args.threadId,
      false
    );
    this.sendResponse(response);
  }

  async setFunctionBreakPointsRequest(response, args) {
    this.gdb.clearFunctionBreakpoints();
    let res = [];
    for (let { name, condition, hitCondition } of args.breakpoints) {
      res.push(this.gdb.setFunctionBreakpoint(name, condition, hitCondition));
    }
    response.body = {
      breakpoints: await Promise.all(res).then((res) =>
        res.map(() => new DebugAdapter.Breakpoint(true))
      ),
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
    let exec_ctx = this.gdb.executionStates.get(args.threadId);
    if (exec_ctx.executingFrameAddress == null) {
      let miResult = await this.gdb.execMI(
        `-data-evaluate-expression $rbp`,
        args.threadId
      );
      exec_ctx.executingFrameAddress = miResult.value;
      await this.gdb
        .getStack(args.levels, args.threadId)
        .then(async (stack) => {
          const res = stack.map((frame, index) => {
            const source = new DebugAdapter.Source(frame.file, frame.fullname);
            const stackFrameIdentifier = this.gdb.nextFrameRef;

            exec_ctx.stackFrameLocals.set(stackFrameIdentifier, {
              threadId: args.threadId,
              frameLevel: index,
              variables: [],
            });

            this.gdb.varRefContexts.set(stackFrameIdentifier, {
              threadId: args.threadId,
              frameLevel: index,
            });

            return new DebugAdapter.StackFrame(
              stackFrameIdentifier,
              `${frame.func} @ 0x${frame.addr}`,
              source,
              frame.line,
              0
            );
          });
          response.body = {
            stackFrames: res,
          };
          exec_ctx.stack = res;
          this.sendResponse(response);
        });
    } else {
      let miResult = await this.gdb.execMI(
        `-data-evaluate-expression $rbp`,
        args.threadId
      );
      if (miResult.value != exec_ctx.executingFrameAddress) {
        // invalidate execution state, time to rebuild it
        // TODO: check if we've just chopped off the top of the stack, if so, we don't need to rebuild the entire thing, just the [stack.top() - 1]
        exec_ctx.clearState();
        exec_ctx.executingFrameAddress = miResult.value;
        await this.gdb
          .getStack(args.levels, args.threadId)
          .then(async (stack) => {
            const res = stack.map((frame, index) => {
              const source = new DebugAdapter.Source(
                frame.file,
                frame.fullname
              );
              const stackFrameIdentifier = this.gdb.nextFrameRef;

              exec_ctx.stackFrameLocals.set(stackFrameIdentifier, {
                threadId: args.threadId,
                frameLevel: index,
                variables: [],
              });

              this.gdb.varRefContexts.set(stackFrameIdentifier, {
                threadId: args.threadId,
                frameLevel: index,
              });
              return new DebugAdapter.StackFrame(
                stackFrameIdentifier,
                `${frame.func} @ 0x${frame.addr}`,
                source,
                frame.line,
                0
              );
            });
            response.body = {
              stackFrames: res,
            };
            exec_ctx.stack = res;
            this.sendResponse(response);
          });
      } else {
        response.body = {
          stackFrames: exec_ctx.stack,
        };
        this.sendResponse(response);
      }
    }
  }

  async variablesRequest(response, { variablesReference }) {
    // unfortunately, due to the convoluted nature of GDB MI's approach, we discard the changelist
    // and instead read the values with -var-evaluate-expression calls.
    await this.gdb.execMI(`-var-update *`);
    const isVisibilityModifier = (expr) => {
      return expr === "public" || expr === "private" || expr === "protected";
    };
    let { threadId, frameLevel } =
      this.gdb.varRefContexts.get(variablesReference);
    let executionContext = this.gdb.executionStates.get(threadId);
    let stackFrameLocal =
      executionContext.stackFrameLocals.get(variablesReference);
    // let stackFrameLocal = this.gdb.stackFrameLocals.get(variablesReference);
    if (stackFrameLocal) {
      // we are a stack frame
      if (stackFrameLocal.variables.length == 0) {
        // we need to build the stack frame
        await this.gdb
          .getStackLocals(threadId, frameLevel)
          .then(async (result) => {
            for (const { name, type, value } of result) {
              let nextRef = this.gdb.nextVarRef;
              this.gdb.varRefContexts.set(nextRef, { threadId, frameLevel });
              let vscodeRef = 0;
              const voname = `vr_${nextRef}`;

              let cmd = `-var-create ${voname} * ${name}`;
              if (!value) {
                vscodeRef = nextRef;
                executionContext.structs.set(nextRef, {
                  variableObjectName: voname,
                  threadId: threadId,
                  frameLevel: frameLevel,
                  variables: [],
                });
              }
              stackFrameLocal.variables.push(
                new MidasVariable(
                  name,
                  value ?? type,
                  vscodeRef,
                  voname,
                  value ? false : true
                )
              );
              await this.gdb.execMI(cmd, threadId);
            }
            response.body = {
              variables: stackFrameLocal.variables,
            };
            this.sendResponse(response);
          });
      } else {
        // we need to update the stack frame
        for (const v of stackFrameLocal.variables) {
          if (!v.isStruct) {
            let r = (
              await this.gdb.execMI(`-var-evaluate-expression ${v.voName}`)
            ).value;
            if (r) {
              v.value = r;
            } else {
              v.value = "error reading value";
            }
          }
        }
        response.body = {
          variables: stackFrameLocal.variables,
        };
        this.sendResponse(response);
      }
    } else {
      // we are a struct scope, produce this struct's members
      let struct = executionContext.structs.get(variablesReference);
      // let struct = this.gdb.structs.get(variablesReference);
      if (struct.variables.length == 0) {
        // we haven't cached it's members
        let structAccessModifierList = await this.gdb.execMI(
          `-var-list-children --all-values "${struct.variableObjectName}"`,
          struct.threadId
        );
        let requests = [];
        for (const accessModifier of structAccessModifierList.children) {
          const membersCommands = `-var-list-children --all-values "${accessModifier.value.name}"`;
          let members = await this.gdb.execMI(membersCommands, struct.threadId);
          const expr = members.children[0].value.exp;
          if (expr) {
            if (isVisibilityModifier(expr)) {
              let sub = await this.gdb.execMI(
                `-var-list-children --all-values "${accessModifier.value.name}.${expr}"`
              );
              requests.push(sub);
            } else {
              requests.push(members);
            }
          }
        }
        for (let arr of requests) {
          for (let v of arr.children) {
            let nextRef = 0;
            let display = "";
            let isStruct = false;
            if (!v.value.value || v.value.value == "{...}") {
              nextRef = this.gdb.nextVarRef;
              this.gdb.varRefContexts.set(nextRef, {
                threadId: threadId,
                frameLevel: struct.frameLevel,
              });
              executionContext.structs.set(nextRef, {
                variableObjectName: v.value.name,
                threadId: struct.threadId,
                frameLevel: struct.frameLevel,
                variables: [],
              });
              display = v.value.type;
              isStruct = true;
            } else {
              display = v.value.value;
              isStruct = false;
            }
            struct.variables.push(
              new MidasVariable(
                v.value.exp,
                display,
                nextRef,
                v.value.name,
                isStruct
              )
            );
          }
        }
        response.body = {
          variables: struct.variables,
        };
      } else {
        // TODO(simon): we have, now update those members
        for (let v of struct.variables) {
          if (!v.isStruct) {
            let r = (
              await this.gdb.execMI(`-var-evaluate-expression ${v.voName}`)
            ).value;
            if (r) {
              v.value = r;
            } else {
              v.value = "error reading value";
            }
          }
        }
        response.body = {
          variables: struct.variables,
        };
      }
      this.sendResponse(response);
    }
  }

  scopesRequest(response, args) {
    const scopes = [];
    // TODO(simon): add the global scope as well; on c++ this is a rather massive one though.
    // todo(simon): retrieve frame level/address from GDB and add as "Locals" scopes
    let locals_scope = createLocalScope(args.frameId);
    scopes.push(locals_scope);
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

  setVariableRequest(...args) {
    return this.virtualDispatch(...args);
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

  reverseContinueRequest(...args) {
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

  evaluateRequest(...args) {
    return this.virtualDispatch(...args);
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
      vscode.window
        .showErrorMessage(
          "Cannot start debugging because no launch configuration has been provided."
        )
        .then((r) => {
          return null;
        });

      return null;
    }

    if (!config.type && !config.request && !config.name) {
      const editor = vscode.window.activeTextEditor;
      if (
        editor &&
        (editor.document.languageId === "cpp" ||
          editor.document.languageId === "c")
      ) {
        config.type = "midas";
        config.name = "Launch Debug";
        config.request = "launch";
        config.stopOnEntry = true;
        config.trace = false;
        config.allStopMode = false;
      }
    }

    if (!config.program) {
      await vscode.window
        .showInformationMessage("Cannot find a program to debug")
        .then(() => {});
      return null;
    }
    vscode.commands.executeCommand(
      "setContext",
      "midas.allStopModeSet",
      config.allStopMode
    );
    return config;
  }
}

module.exports = {
  DebugSession,
  ConfigurationProvider,
};
