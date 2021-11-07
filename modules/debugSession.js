"use strict";

const vscodeDebugAdapter = require("vscode-debugadapter");
const vscode = require("vscode");
const { DebugProtocol } = require("vscode-debugprotocol");
const { GDBInterface } = require("./gdbInterface");
const { Subject } = require("await-notify");
const { Thread } = require("gdb-js");
const fs = require("fs");

const STACK_ID_START = 1000;
const VAR_ID_START = 1000 * 1000;
/**
 * @extends DebugProtocol.LaunchRequestArguments
 */
class LaunchRequestArguments {
  /**If noDebug is true the launch request should launch the program without enabling debugging.
   * @type {boolean | undefined} noDebug */
  noDebug;

  /**Optional data from the previous, restarted session.
   * The data is sent as the 'restart' attribute of the 'terminated' event.
   * The client should leave the data intact.
   * @type {any | undefined} __restart */
  __restart;

  /**Path to binary executable to debug
   * @type {string} */
  binary;

  /**Tells debug adapter whether or not we should set a breakpoint on main (or otherwise defined entry point of the executable)
   * @type {boolean | undefined } */
  stopOnEntry;

  /**Sets trace logging for this debug adapter
   * @type {boolean} */
  trace;
}

class DebugSession extends vscodeDebugAdapter.DebugSession {

  /** @type { GDBInterface } */
  gdbInterface;

  /** @type {number} */
  threadId;

  /** @type { Subject } */
  configIsDone;

  _reportProgress;
  useInvalidetedEvent;

  /**
   * Constructs a DebugSession object
   * @param {string} logFile
   */
  constructor(debuggerLinesStartAt1, isServer = false, fileSystem = fs) {
    super();
    // NB! i have no idea what thread id this is supposed to refer to
    this.threadId = 1;
    this.configIsDone = new Subject();
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
    this.gdbInterface = new GDBInterface();
    // TODO(simon): we begin by just making sure this works.. Once it does, the rest is basically smooth sailing
    //  involving some albeit repetitive implementation of all commands etc,
    //  but at least there's a 2-way communication between code and gdb
    this.gdbInterface.on("stopOnEntry", (bp) => {
      let evt = new vscodeDebugAdapter.StoppedEvent("entry", 1);
      this.sendEvent(evt);
    });

    this.gdbInterface.on("breakPointValidated", (bp) => {
      this.sendEvent(
        new vscodeDebugAdapter.BreakpointEvent("changed", {
          id: bp.id,
          verified: true,
          line: bp.line,
        })
      );
    });

    this.gdbInterface.on("breakpoint-hit", (breakpointID) => {
      this.gdbInterface
        .getStackLocals()
        .then((locals) => {
          return locals;
        })
        .catch((err) => {
          console.log("Error trying to get locals");
        })
        .then((locals) => {
          this.sendEvent(
            new vscodeDebugAdapter.StoppedEvent("breakpoint", this.threadId)
          );
        });
    });

    this.gdbInterface.on("exited-normally", () => {
      this.sendEvent(new vscodeDebugAdapter.TerminatedEvent());
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
    if (args.supportsProgressReporting) this._reportProgress = true;
    if (args.supportsInvalidatedEvent) this.useInvalidetedEvent = true;
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
    // make VS Code send the breakpointLocations request
    response.body.supportsBreakpointLocationsRequest = true;
    response.body.supportsConditionalBreakpoints = true;
    response.body.supportsFunctionBreakpoints = true;
    // make VS Code provide "Step in Target" functionality
    response.body.supportsStepInTargetsRequest = true;
    // the adapter defines two exceptions filters, one with support for conditions.
    response.body.supportsExceptionFilterOptions = true;
    response.body.supportsGotoTargetsRequest = true;
    response.body.supportsHitConditionalBreakpoints = true;
    response.body.supportsSetVariable = true;

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

  /**
   *
   * @param { DebugProtocol.LaunchResponse } response
   * @param { LaunchRequestArguments } args
   */
  async launchRequest(response, args) {
    vscodeDebugAdapter.logger.setup(
      args.trace
        ? vscodeDebugAdapter.Logger.LogLevel.Verbose
        : vscodeDebugAdapter.Logger.LogLevel.Stop,
      false
    );
    // wait until configuration has finished (and configurationDoneRequest has been called)
    await this.configIsDone.wait(1000);
    // todo(simon): Ugly hack. This part of the setup
    //  is not fully implemented. Do something about this.
    if (args.program != undefined) {
      args.binary = args.program;
    }
    this.sendResponse(response);
    await this.gdbInterface.start(args.program, true, !args.noDebug);
    this.sendEvent(new vscodeDebugAdapter.InitializedEvent());
  }

  /**
   * This is the function that VSCode UI code calls when they set a breakpoint
   * in the UI.
   * @param {DebugProtocol.SetBreakpointsResponse} response
   * @param {DebugProtocol.SetBreakpointsArguments} args
   * @param {DebugProtocol.Request} [request]
   */
  async setBreakPointsRequest(response, args, request) {
    let path = args.source.path;
    const clientLines = args.lines || [];
    let res = [];
    for (let l of clientLines) {
      let bp = await this.gdbInterface.setBreakPointAtLine(path, l);
      let setbp = new vscodeDebugAdapter.Breakpoint(true, bp.line);
      res.push(setbp);
      response.body = {
        breakpoints: res,
      };
    }

    this.sendResponse(response);
  }
  /**
   *
   * @param {DebugProtocol.ContinueResponse} response
   * @param {DebugProtocol.ContinueArguments} args
   * @param {DebugProtocol.Request} [request]
   */
  continueRequest(response, args, request) {
    // todo(simon): for rr this needs to be implemented differently
    this.gdbInterface.continue(false).then((done) => {
      this.sendResponse(response);
    });
  }
  /**
   *
   * @param {DebugProtocol.SetFunctionBreakpointsResponse} response
   * @param {DebugProtocol.SetFunctionBreakpointsArguments} args
   * @param {DebugProtocol.SetFunctionBreakpointsRequest} [request]
   */
  setFunctionBreakPointsRequest(response, args, request) {
    console.log("User tried to set a FunctionBreakPoint request");
  }

  /**
   *
   * @param {DebugProtocol.PauseResponse} response
   * @param {DebugProtocol.PauseArguments} args
   * @param {DebugProtocol.PauseRequest} [request]
   */
  pauseRequest(response, args, request) {
    console.log("User requested a pause");
  }
  /**
   *
   * @param {DebugProtocol.ThreadsResponse} response
   * @param {DebugProtocol.ThreadsRequest} [request]
   */
  threadsRequest(response, request) {
    response.body = {
      threads: [new vscodeDebugAdapter.Thread(1, "thread 1")],
    };
    this.sendResponse(response);
  }

  /**
   * "Borrowed" from unknown sources
   * @param {number} threadId
   * @param {number} level
   * @returns {number}
   */
  threadToFrameIdMagic(threadId, level) {
    return (level << 16) | threadId;
  }

  /**
   * @param {number} frameId
   * @returns {[number, number]}
   */
  frameIdToThreadAndLevelMagic(frameId) {
    return [frameId & 0xffff, frameId >> 16];
  }

  /**
   * A stack trace request is requested by VS Code when it needs to decide "where should be put the cursor at"
   * @param {DebugProtocol.StackTraceResponse} response
   * @param {DebugProtocol.StackTraceArguments} args
   * @param {DebugProtocol.Request} [request]
   */
  stackTraceRequest(response, args, request) {
    this.gdbInterface.getStack(args.levels, args.threadId).then((stack) => {
      let res = stack.map((frame) => {
        let source = new vscodeDebugAdapter.Source(frame.file, frame.fullname);
        return new vscodeDebugAdapter.StackFrame(
          this.threadToFrameIdMagic(args.threadId, frame.level),
          `${frame.func} @ 0x${frame.addr}`,
          source,
          frame.line,
          0
        );
      });
      response.body = {
        stackFrames: res,
      };
      this.sendResponse(response);
    });
  }
  /**
   *
   * @param {DebugProtocol.VariablesResponse} response
   * @param {DebugProtocol.VariablesArguments} args
   * @param {DebugProtocol.VariablesRequest} [request]
   */
  async variablesRequest(response, args, request) {
    this.gdbInterface.getStackLocals().then((locals) => {
      response.body = {
        variables: locals.map((l) => {
          return {
            name: l.name,
            type: l.type,
            value: l.value,
            variablesReference: 0,
          };
        }),
      };
      this.sendResponse(response);
    });
  }

  /**
   *
   * @param {DebugProtocol.SetVariableResponse} response
   * @param {DebugProtocol.SetVariableArguments} args
   * @param {DebugProtocol.SetVariableRequest} [request]
   */
  setVariableRequest(response, args, request) {

  }

  /**
   * @param {DebugProtocol.ScopesResponse} response
   * @param {DebugProtocol.ScopesArguments} args
   * @param {DebugProtocol.Request} request
   */
  scopesRequest(response, args, request) {
    const scopes = [];
    // TODO(simon): add the global scope as well; on c++ this is a rather massive one though.
    scopes.push(
      new vscodeDebugAdapter.Scope(
        "Local",
        STACK_ID_START + args.frameId || 0,
        false // false = means scope is inexpensive to get
      )
    );
    response.body = {
      scopes: scopes,
    };
    this.sendResponse(response);
  }

  /**
   *
   * @param {DebugProtocol.Response} response
   * @param {DebugProtocol.Message} codeOrMessage
   * @param {string} [format]
   * @param {any} [variables]
   * @param {vscodeDebugAdapter.ErrorDestination} [dest]
   */
  sendErrorResponse(response, codeOrMessage, format, variables, dest) {
    console.log("Sending error resposne");
  }

  // "VIRTUAL FUNCTIONS" av DebugSession som behövs implementeras (några av dom i alla fall)
  // static run(debugSession: typeof DebugSession): void;
  // shutdown(): void;

  // runInTerminalRequest(args: DebugProtocol.RunInTerminalRequestArguments, timeout: number, cb: (response: DebugProtocol.RunInTerminalResponse) => void): void;
  // protected dispatchRequest(request: DebugProtocol.Request): void;
  // protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void;
  // protected attachRequest(response: DebugProtocol.AttachResponse, args: DebugProtocol.AttachRequestArguments, request?: DebugProtocol.Request): void;
  // protected terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments, request?: DebugProtocol.Request): void;
  // protected restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments, request?: DebugProtocol.Request): void;

  // protected setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments, request?: DebugProtocol.Request): void;
  // protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments, request?: DebugProtocol.Request): void;
  // protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments, request?: DebugProtocol.Request): void;
  // protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments, request?: DebugProtocol.Request): void;
  // protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments, request?: DebugProtocol.Request): void;
  // protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments, request?: DebugProtocol.Request): void;
  // protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments, request?: DebugProtocol.Request): void;
  // protected restartFrameRequest(response: DebugProtocol.RestartFrameResponse, args: DebugProtocol.RestartFrameArguments, request?: DebugProtocol.Request): void;
  // protected gotoRequest(response: DebugProtocol.GotoResponse, args: DebugProtocol.GotoArguments, request?: DebugProtocol.Request): void;
  // protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments, request?: DebugProtocol.Request): void;
  // protected sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments, request?: DebugProtocol.Request): void;
  // protected threadsRequest(response: DebugProtocol.ThreadsResponse, request?: DebugProtocol.Request): void;
  // protected terminateThreadsRequest(response: DebugProtocol.TerminateThreadsResponse, args: DebugProtocol.TerminateThreadsArguments, request?: DebugProtocol.Request): void;
  // protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments, request?: DebugProtocol.Request): void;
  // protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): void;

  // protected setExpressionRequest(response: DebugProtocol.SetExpressionResponse, args: DebugProtocol.SetExpressionArguments, request?: DebugProtocol.Request): void;
  // protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments, request?: DebugProtocol.Request): void;
  // protected stepInTargetsRequest(response: DebugProtocol.StepInTargetsResponse, args: DebugProtocol.StepInTargetsArguments, request?: DebugProtocol.Request): void;
  // protected gotoTargetsRequest(response: DebugProtocol.GotoTargetsResponse, args: DebugProtocol.GotoTargetsArguments, request?: DebugProtocol.Request): void;
  // protected completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments, request?: DebugProtocol.Request): void;
  // protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse, args: DebugProtocol.ExceptionInfoArguments, request?: DebugProtocol.Request): void;
  // protected loadedSourcesRequest(response: DebugProtocol.LoadedSourcesResponse, args: DebugProtocol.LoadedSourcesArguments, request?: DebugProtocol.Request): void;
  // protected dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments, request?: DebugProtocol.Request): void;
  // protected setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments, request?: DebugProtocol.Request): void;
  // protected readMemoryRequest(response: DebugProtocol.ReadMemoryResponse, args: DebugProtocol.ReadMemoryArguments, request?: DebugProtocol.Request): void;
  // protected writeMemoryRequest(response: DebugProtocol.WriteMemoryResponse, args: DebugProtocol.WriteMemoryArguments, request?: DebugProtocol.Request): void;
  // protected disassembleRequest(response: DebugProtocol.DisassembleResponse, args: DebugProtocol.DisassembleArguments, request?: DebugProtocol.Request): void;
  // protected cancelRequest(response: DebugProtocol.CancelResponse, args: DebugProtocol.CancelArguments, request?: DebugProtocol.Request): void;
  // protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): void;
  // protected setInstructionBreakpointsRequest(response: DebugProtocol.SetInstructionBreakpointsResponse, args: DebugProtocol.SetInstructionBreakpointsArguments, request?: DebugProtocol.Request): void;
  /**
   * Override this hook to implement custom requests.
   */
  // protected customRequest(command: string, response: DebugProtocol.Response, args: any, request?: DebugProtocol.Request): void;

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

/**
 * "Implements" DebugConfigurationProvider interface. We are basically mimicking vscode-mock-debug
 * at first go here. technically, we won't need this for testing even, as we'll make sure to provide a launch.json anyhow
 * to begin with.
 */
class ConfigurationProvider {
  /**
   * DebugConfigurationProvider
   * Massage a debug configuration just before a debug session is being launched,
   * e.g. add all missing attributes to the debug configuration.
   * @param { vscode.WorkspaceFolder? } folder
   * @param { vscode.DebugConfiguration } config
   * @param { vscode.CancellationToken? } token
   * @returns { vscode.ProviderResult<vscode.DebugConfiguration> }
   */
  resolveDebugConfiguration(folder, config, token) {
    // if launch.json is missing or empty
    if (!config.type && !config.request && !config.name) {
      config.type = "midas";
      config.name = "Launch";
      config.request = "launch";
      config.program = "${workspaceFolder}/build/testapp";
      config.stopOnEntry = true;
    }

    if (!config.program) {
      return vscode.window
        .showInformationMessage("Cannot find a program to debug")
        .then((_) => {
          return undefined; // abort launch
        });
    }
    return config;
  }
}

module.exports = {
  DebugSession,
  ConfigurationProvider,
};
