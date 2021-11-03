"use strict"

const vscodeDebugAdapter = require("vscode-debugadapter");
const vscode = require("vscode");
const {GDBInterface} = require("./debuggerInterface")



class RRSession extends vscodeDebugAdapter.LoggingDebugSession {
  /** @type GDBInterface */
  #gdbInterface;
  #threadId;
  constructor(logFile) {
    super(logFile);
    // NB! i have no idea what thread id this is supposed to refer to
    this.#threadId = 1;
    this.setDebuggerLinesStartAt1(false);
    this.setDebuggerColumnsStartAt1(false);
    this.#gdbInterface = new GDBInterface();
    // TODO(simon): we begin by just making sure this works.. Once it does, the rest is basically smooth sailing
    //  involving some albeit repetitive implementation of all commands etc, but at least there's a 2-way communication between code and gdb
    this.#gdbInterface.on("stopOnEntry", () => {
      this.sendEvent(new vscodeDebugAdapter.StoppedEvent("entry", ))
    });

  }
}

/**
 * "Implements" DebugConfigurationProvider interface. We are basically mimicking vscode-mock-debug
 * at first go here. technically, we won't need this for testing even, as we'll make sure to provide a launch.json anyhow
 * to begin with.
 */
class rrdbgConfigurationProvider {
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
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.languageId === 'cpp') {
        config.type = 'rrdbg';
        config.name = 'Launch';
        config.request = 'launch';
        config.program = '${file}';
        config.stopOnEntry = true;
      }
    }

    if (!config.program) {
      return vscode.window.showInformationMessage("Cannot find a program to debug").then(_ => {
        return undefined;	// abort launch
      });
    }

    return config;
  }
}

module.exports = {
  RRSession
}