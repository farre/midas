const vscode = require("vscode");
const { ConfigurationProviderInitializer, InitExceptionTypes } = require("./initializer");
const { showErrorPopup, getAPI } = require("../utils/utils");
const { ContextKeys } = require("../constants");
const { MdbSpawnConfig } = require("../spawn");
const { MdbSession, MdbChildSession } = require("../dap/mdb");
const fs = require("fs");
const { EventEmitter } = require("events");

const initializer = async (config) => {
  if (config.hasOwnProperty("mdbPath")) {
    const mdbPath = config?.mdbPath ?? "mdb";
    if (!fs.existsSync(mdbPath)) {
      throw { type: InitExceptionTypes.MdbNotFound, message: `MDB could not be found using '${mdbPath}'` };
    }
  }

  if (!config.hasOwnProperty("stopOnEntry")) {
    config.stopOnEntry = false;
  }

  if (!config.hasOwnProperty("setupCommands")) {
    config.setupCommands = [];
  }
};

class MdbConfigurationProvider extends ConfigurationProviderInitializer {
  get type() {
    return "midas-native";
  }

  async resolveDebugConfiguration(folder, config, token) {
    return config;
  }

  async resolveDebugConfigurationWithSubstitutedVariables(folder, config, token) {
    if (config.RRSession == null) {
      config.RRSession = false;
    }

    if (MdbDebugAdapterFactory.RootSession == null) {
      getAPI().clearChannelOutputs();
      try {
        await super.defaultInitialize(config, initializer);
      } catch (err) {
        switch (err.type) {
          case InitExceptionTypes.MdbNotFound:
            showErrorPopup(err.message, err.message, [
              {
                title: "Download & build MDB?",
                action: async () => {
                  await vscode.window.showInformationMessage("This feature is not implemented yet");
                },
              },
            ]).then((choice) => {
              if (choice) choice.action();
            });
            break;
          default:
            showErrorPopup(`Unexpected fatal exception: ${err}`);
            throw err;
        }
        return null;
      }
      if (config.request == "attach" && config.attachArgs == null) {
        throw new Error("attachArgs field is missing. This field is required to determine target to attach to.");
      }
      if (config.request == "attach") {
        config.attachArguments = config.attachArgs;
      }

      return config;
    } else {
      // Assume MDB sends well-formed and sane config to itself.
      if (config.childConfiguration == null && config.childConfiguration?.path == null) {
        throw new Error(`Child session could not spawn: No path was provided in the configuration`);
      }
      return config;
    }
  }
}

class MdbDebugAdapterFactory {
  static RootSession = null;
  #cp_ui;
  constructor(checkpointsUI) {
    this.#cp_ui = checkpointsUI;
  }
  /**
   * @param { vscode.DebugSession } session
   * @returns ProviderResult<vscode.DebugAdapterDescriptor>
   */
  async createDebugAdapterDescriptor(session) {
    if (MdbDebugAdapterFactory.RootSession == null) {
      const config = session.configuration;
      let cleanUp = new EventEmitter();
      cleanUp.on("shutdown", () => {
        MdbDebugAdapterFactory.RootSession = null;
      });
      const mdb = new MdbSession(this.spawnConfig(config), null, this.#cp_ui, cleanUp);
      MdbDebugAdapterFactory.RootSession = mdb;
      return new vscode.DebugAdapterInlineImplementation(MdbDebugAdapterFactory.RootSession);
    } else {
      const mdb = new MdbChildSession(session.configuration.childConfiguration);
      return new vscode.DebugAdapterInlineImplementation(mdb);
    }
  }

  spawnConfig(config) {
    return new MdbSpawnConfig(config);
  }
}

module.exports = {
  MdbConfigurationProvider,
  MdbDebugAdapterFactory,
};
