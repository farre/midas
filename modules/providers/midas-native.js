const vscode = require("vscode");
const { ConfigurationProviderInitializer, InitExceptionTypes } = require("./initializer");
const { showErrorPopup, getAPI } = require("../utils/utils");
const { MdbSpawnConfig } = require("../spawn");
const { MidasSessionController, MdbProcess, MidasNativeSession } = require("../dap/mdb");
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
      if (!config.childConfiguration) {
        throw new Error(`Child session could not spawn: No path was provided in the configuration`);
      }
      config.attachArguments = {
        type: "auto",
        processId: config.childConfiguration.processId
      };
      return config;
    }
  }
}

class MdbDebugAdapterFactory {
  /** @type {MidasSessionController} */
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
    const config = session.configuration;
    let cleanUp = new EventEmitter();
    cleanUp.on("shutdown", () => {
      MdbDebugAdapterFactory.RootSession = null;
    });
    if (MdbDebugAdapterFactory.RootSession == null) {
      MdbDebugAdapterFactory.RootSession = new MidasSessionController(
        new MdbProcess(this.spawnConfig(config)),
        this.spawnConfig(config),
        null,
        this.#cp_ui,
        cleanUp,
      );
    }

    return new vscode.DebugAdapterInlineImplementation(
      new MidasNativeSession(MdbDebugAdapterFactory.RootSession, this.spawnConfig(config)),
    );
  }

  spawnConfig(config) {
    return new MdbSpawnConfig(config);
  }
}

module.exports = {
  MdbConfigurationProvider,
  MdbDebugAdapterFactory,
};
