const vscode = require("vscode");
const { ConfigurationProviderInitializer, InitExceptionTypes, gdbSettingsOk } = require("./initializer");
const { isNothing, resolveCommand, showErrorPopup, getPid, strEmpty, getAPI } = require("../utils/utils");
const { LaunchSpawnConfig, AttachSpawnConfig } = require("../spawn");
const { GdbDAPSession } = require("../dap/gdb");
const { consoleErr } = require("../utils/log");

const initializer = async (config) => {
  if (!config.hasOwnProperty("stopOnEntry")) {
    config.stopOnEntry = false;
  }
  if (!config.hasOwnProperty("trace")) {
    config.trace = "off";
  }
  // allStopMode is legacy name from gdb.
  if (config.hasOwnProperty("allStopMode")) {
    vscode.window.showWarningMessage("allStopMode is a deprecated flag. Use noSingleThreadControl instead");
    config.noSingleThreadControl = config.allStopMode;
  }

  if (!config.hasOwnProperty("noSingleThreadControl") && config.noSingleThreadControl == undefined) {
    config.noSingleThreadControl = true;
  }
  if (!config.hasOwnProperty("gdbPath")) {
    config.gdbPath = await getAPI().resolveToolPath("gdb");
    if (config.gdbPath == undefined) {
      throw { type: InitExceptionTypes.GdbNotFound };
    }
  }
  await gdbSettingsOk(config);
  if (!config.hasOwnProperty("setupCommands")) {
    config.setupCommands = [];
  }
  if (!config.hasOwnProperty("remoteTargetConfig")) {
    config.remoteTargetConfig = null;
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
  if (!config.program && config.remoteTargetConfig == null && config.request != "attach") {
    throw new Error("Program or remoteTargetConfig was not set. One of these fields has to be set in launch.json");
  }
};

class ConfigurationProvider extends ConfigurationProviderInitializer {
  get type() {
    return "midas-gdb";
  }

  // eslint-disable-next-line no-unused-vars
  async resolveDebugConfiguration(folder, config, token) {
    return config;
  }

  // for now, we do not substitute any variables in the launch config, but we will. this will be used then.
  // @ts-ignore
  async resolveDebugConfigurationWithSubstitutedVariables(folder, config, token) {
    getAPI().clearChannelOutputs();
    try {
      await super.defaultInitialize(config, initializer);
    } catch (err) {
      switch (err.type) {
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
          consoleErr(`Unexpected exception: ${err}`);
          break;
      }
      return null;
    }

    if (config.request == "attach" && config.target == null) {
      if (!config.pid) {
        const pid = await getPid();
        if (isNothing(pid)) {
          return null;
        }
        config.pid = pid;
      }
    }
    return config;
  }
}

class DebugAdapterFactory {
  /**
   * @param { vscode.DebugSession } session
   * @returns ProviderResult<vscode.DebugAdapterDescriptor>
   */
  async createDebugAdapterDescriptor(session) {
    const config = session.configuration;
    let terminal = null;
    const midas_session = new GdbDAPSession(this.spawnConfig(config), terminal, null);
    return new vscode.DebugAdapterInlineImplementation(midas_session);
  }

  spawnConfig(config) {
    switch (config.request) {
      case "attach":
        return new AttachSpawnConfig(config);
      case "launch":
        return new LaunchSpawnConfig(config);
      default:
        throw new Error("Unknown request type");
    }
  }
}

module.exports = {
  ConfigurationProvider,
  DebugAdapterFactory,
};
