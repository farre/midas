const vscode = require("vscode");
const { MidasDebugSession } = require("../debugSession");
const fs = require("fs");
const { ConfigurationProviderInitializer, InitExceptionTypes } = require("./initializer");
const { isNothing, resolveCommand, ContextKeys, showErrorPopup, getPid, strEmpty, getAPI } = require("../utils/utils");
const { LaunchSpawnConfig, AttachSpawnConfig } = require("../spawn");

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
    config.gdbPath = getAPI().resolve_tool_path("gdb");
    if(config.gdbPath == undefined) {
      throw { type: InitExceptionTypes.GdbNotFound };
    }
  }
  if (!config.hasOwnProperty("setupCommands")) {
    config.setupCommands = [];
  }
  if (!config.hasOwnProperty("externalConsole")) {
    config.externalConsole = null;
  } else {
    if (isNothing(config.externalConsole.path)) {
      throw new Error("Path field for externalConsole not provided in configuration");
    }
    if (strEmpty(config.externalConsole.path)) {
      try {
        config.externalConsole.path = resolveCommand("x-terminal-emulator");
      } catch (err) {
        throw new Error(`[externalConsole.path error]: ${err.message}`);
      }
    }
  }
  if (!config.program) {
    throw new Error("Inferior to debug was not set in configuration (program field in launch.json)");
  }
};

class ConfigurationProvider extends ConfigurationProviderInitializer {
  get type() {
    return "midas-gdb";
  }

  // eslint-disable-next-line no-unused-vars
  async resolveDebugConfiguration(folder, config, token) {
    try {
      await super.defaultInitialize(config, initializer);
    } catch (err) {
      switch(err.type) {
        case InitExceptionTypes.GdbVersionUnknown:
          showErrorPopup("Incompatible GDB version", err.message, [
            {
              title: "Download GDB source",
              action: async () => {
                await vscode.env.openExternal(vscode.Uri.parse("https://www.sourceware.org/gdb/current/"));
              },
            },
          ]).then((choice) => {
            if (choice) choice.action();
          });
          break;
        case InitExceptionTypes.GdbNotFound:
          vscode.window.showErrorMessage(`Gdb could not be found on your system`);
          break;
        default:
          break;
      }
      return null;
    }

    if (config.request == "attach") {
      if (!config.pid) {
        const pid = await getPid();
        if (isNothing(pid)) {
          return null;
        }
        config.pid = pid;
      }
    }
    vscode.commands.executeCommand("setContext", ContextKeys.RRSession, false);
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
    let dbg_session = new MidasDebugSession(true, false, fs, this.spawnConfig(config));
    vscode.commands.executeCommand("setContext", ContextKeys.DebugType, config.type);
    return new vscode.DebugAdapterInlineImplementation(dbg_session);
  }

  spawnConfig(config) {
    if (config.request == "attach") {
      return new AttachSpawnConfig(config);
    } else if (config.request == "launch") {
      return new LaunchSpawnConfig(config);
    } else {
      throw new Error("Unknown request type");
    }
  }
}

module.exports = {
  ConfigurationProvider,
  DebugAdapterFactory,
};
