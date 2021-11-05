"use strict";

const vscodeDebugAdapter = require("vscode-debugadapter");
const vscode = require("vscode");
const { DebugProtocol } = require("vscode-debugprotocol");
const { GDBInterface } = require("./gdbInterface");

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

class RRSession extends vscodeDebugAdapter.DebugSession {
  /** @type { GDBInterface } */
  #gdbInterface;

  /** @type {number} */
  #threadId;

  /** @type {boolean} */
  #configurationIsDone;

  /**
   * Constructs a RRSession object
   * @param {string} logFile
   */
  constructor(logFile) {
    super();
    // NB! i have no idea what thread id this is supposed to refer to
    this.#threadId = 1;
    this.setDebuggerLinesStartAt1(false);
    this.setDebuggerColumnsStartAt1(false);
    this.#gdbInterface = new GDBInterface();
    // TODO(simon): we begin by just making sure this works.. Once it does, the rest is basically smooth sailing
    //  involving some albeit repetitive implementation of all commands etc, but at least there's a 2-way communication between code and gdb
    this.#gdbInterface.on("stopOnEntry", (bp) => {
      console.log(`yay we caught our custom 'stop on entry' event. Breakpoint: ${bp.thread.id}`);
      let evt = new vscodeDebugAdapter.StoppedEvent("breakpoint", this.#threadId);
      this.sendEvent(evt);
    });

    this.#gdbInterface.on("breakPointValidated", (bp) => {
      this.sendEvent(
        new vscodeDebugAdapter.BreakpointEvent("changed", {
          id: bp.id,
          verified: true,
          line: bp.line,
        })
      );
    });

    this.#gdbInterface.on("stopOnBreakpoint", (payload) => {
      console.log(`Caught stopOnBreakpoint`);
      this.sendEvent(
        new vscodeDebugAdapter.StoppedEvent("breakpoint", this.#threadId)
      );
    });

    this.#gdbInterface.on("execution-end", (payload) => {
      this.sendEvent(new vscodeDebugAdapter.TerminatedEvent());
    });
  }
  /**
   * As per Mock debug adapter:
   * The 'initialize' request is the first request called by the frontend
   * to interrogate the features the debug adapter provides.
   */
  initializeRequest(response, args) {
    if (args.supportsProgressReporting) this._reportProgress = true;
    if (args.supportsInvalidatedEvent) this.useInvalidetedEvent = true;
    // build and return the capabilities of this debug adapter:
    response.body = response.body || {};
    // the adapter implements the configurationDone request.
    response.body.supportsConfigurationDoneRequest = true;
    // make VS Code use 'evaluate' when hovering over source
    response.body.supportsEvaluateForHovers = false;
    // make VS Code show a 'step back' button
    response.body.supportsStepBack = false;
    // make VS Code support data breakpoints
    response.body.supportsDataBreakpoints = true;
    // make VS Code support completion in REPL
    response.body.supportsCompletionsRequest = false;
    response.body.completionTriggerCharacters = [".", "["];
    // make VS Code send cancel request
    response.body.supportsCancelRequest = true;
    // make VS Code send the breakpointLocations request
    response.body.supportsBreakpointLocationsRequest = true;
    // make VS Code provide "Step in Target" functionality
    response.body.supportsStepInTargetsRequest = true;
    // the adapter defines two exceptions filters, one with support for conditions.
    response.body.supportsExceptionFilterOptions = true;
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
    response.body.supportsExceptionInfoRequest = false;
    // make VS Code send setVariable request
    response.body.supportsSetVariable = false;
    // make VS Code send setExpression request
    response.body.supportsSetExpression = false;
    // make VS Code send disassemble request
    response.body.supportsDisassembleRequest = false;
    response.body.supportsSteppingGranularity = true;
    response.body.supportsInstructionBreakpoints = true;
    this.sendResponse(response);
    // since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
    // we request them early by sending an 'initializeRequest' to the frontend.
    // The frontend will end the configuration sequence by calling 'configurationDone' request.
    this.sendEvent(new vscodeDebugAdapter.InitializedEvent());
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
    this.#configurationIsDone = true;
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
    if (args.program != undefined) {
      args.binary = args.program;
    }
    await this.#gdbInterface.start(
      args.program,
      true,
      !args.noDebug
    );
    this.sendResponse(response);
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
    for(let l of clientLines) {
      let bp = await this.#gdbInterface.setBreakPointAtLine(path, l);
      let setbp = new vscodeDebugAdapter.Breakpoint(true, bp.line);
      res.push(setbp);
      console.log("User tried to set a breakpoint");
      response.body = {
        breakpoints: res
      }
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
    console.log("User requested a continue");
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


  // "VIRTUAL FUNCTIONS" av DebugSession som behövs implementeras (några av dom i alla fall)
  // static run(debugSession: typeof DebugSession): void;
  // shutdown(): void;
  // protected sendErrorResponse(response: DebugProtocol.Response, codeOrMessage: number | DebugProtocol.Message, format?: string, variables?: any, dest?: ErrorDestination): void;
  // runInTerminalRequest(args: DebugProtocol.RunInTerminalRequestArguments, timeout: number, cb: (response: DebugProtocol.RunInTerminalResponse) => void): void;
  // protected dispatchRequest(request: DebugProtocol.Request): void;
  // protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void;
  // protected attachRequest(response: DebugProtocol.AttachResponse, args: DebugProtocol.AttachRequestArguments, request?: DebugProtocol.Request): void;
  // protected terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments, request?: DebugProtocol.Request): void;
  // protected restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments, request?: DebugProtocol.Request): void;

  // protected setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments, request?: DebugProtocol.Request): void;
  // protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments, request?: DebugProtocol.Request): void;
  // protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments, request?: DebugProtocol.Request): void;
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
  // protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments, request?: DebugProtocol.Request): void;
  // protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments, request?: DebugProtocol.Request): void;
  // protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): void;
  // protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments, request?: DebugProtocol.Request): void;
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
  // protected convertClientLineToDebugger(line: number): number;
  // protected convertDebuggerLineToClient(line: number): number;
  // protected convertClientColumnToDebugger(column: number): number;
  // protected convertDebuggerColumnToClient(column: number): number;
  // protected convertClientPathToDebugger(clientPath: string): string;
  // protected convertDebuggerPathToClient(debuggerPath: string): string;
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
      config.type = "rrdbg";
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
  RRSession,
  ConfigurationProvider,
};
