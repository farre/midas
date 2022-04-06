const vscode = require("vscode");
const { MidasDebugSession } = require("../debugSession");
const fs = require("fs");
const { ConfigurationProviderInitializer } = require("./initializer");
const { MidasRunMode } = require("../buildMode");

const initializer = (config) => {
  if (!config.hasOwnProperty("stopOnEntry")) {
    config.stopOnEntry = false;
  }
  if (!config.hasOwnProperty("trace")) {
    config.trace = "off";
  }
  if (!config.hasOwnProperty("allStopMode")) {
    config.allStopMode = true;
  }
  if (!config.hasOwnProperty("gdbPath")) {
    config.gdbPath = "gdb";
  }
  if(!config.hasOwnProperty("setupCommands")) {
    config.setupCommands = [];
  }
  if(!config.hasOwnProperty("externalConsole")) {
    config.externalConsole = null;
  }
  if(!config.program) {
    throw new Error("Cannot find a program to debug");
  }
}

class ConfigurationProvider extends ConfigurationProviderInitializer {
  get type() {
    return "midas-gdb";
  }

  // eslint-disable-next-line no-unused-vars
  async resolveDebugConfiguration(folder, config, token) {
    try {
      super.defaultInitialize(config, initializer);
    } catch(err) {
      await vscode.window.showErrorMessage(err.message);
      return null;
    }
    
    if(config.request == "attach") {
      if(!config.pid) {
        const options = { canPickMany: false, ignoreFocusOut: true, title: "Select process to debug" };
        const pid = await vscode.window.showInputBox(options);
        if(!pid) {
          await vscode.window.showInformationMessage("You must provide a pid for attach requests.");
          return null;
        }
        config.pid = pid;
      }
    }
    vscode.commands.executeCommand("setContext", "midas.rrSession", false);
    return config;
  }

  // for now, we do not substitute any variables in the launch config, but we will. this will be used then.
  // @ts-ignore
  async resolveDebugConfigurationWithSubstitutedVariables(folder, debugConfiguration, token) {
    return debugConfiguration;
  }
}

class DebugAdapterFactory {
  /**
   * @param { vscode.DebugSession } session
   * @returns ProviderResult<vscode.DebugAdapterDescriptor>
   */
  async createDebugAdapterDescriptor(session) {
    const config = session.configuration;
    let dbg_session = new MidasDebugSession(true, false, fs, new MidasRunMode(config));
    return new vscode.DebugAdapterInlineImplementation(dbg_session);
  }
}

module.exports = {
  ConfigurationProvider,
  DebugAdapterFactory
};
