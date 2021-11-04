"use strict";

const vscodeDebugAdapter = require("vscode-debugadapter");
const vscode = require("vscode");
const { DebugProtocol } = require("vscode-debugprotocol");
const { GDBInterface } = require("./debuggerInterface");

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

class RRSession extends vscodeDebugAdapter.LoggingDebugSession {
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
    super(logFile);
    // NB! i have no idea what thread id this is supposed to refer to
    this.#threadId = 1;
    this.setDebuggerLinesStartAt1(false);
    this.setDebuggerColumnsStartAt1(false);
    this.#gdbInterface = new GDBInterface();
    // TODO(simon): we begin by just making sure this works.. Once it does, the rest is basically smooth sailing
    //  involving some albeit repetitive implementation of all commands etc, but at least there's a 2-way communication between code and gdb
    this.#gdbInterface.on("stopOnEntry", (bp) => {
      console.log("yay we caught our custom 'stop on entry' event");
      this.sendEvent(
        new vscodeDebugAdapter.StoppedEvent("entry", this.#threadId)
      );
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

    this.#gdbInterface.on("stopOnBreakpoint", () => {
      this.sendEvent(
        new vscodeDebugAdapter.StoppedEvent("breakpoint", this.#threadId)
      );
    });

    this.#gdbInterface.on("execution-end", (payload) => {
      this.sendEvent();
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
      !!args.stopOnEntry,
      !args.noDebug
    );
    this.sendResponse(response);
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
