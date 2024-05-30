const vscode = require("vscode");
const { ConfigurationProviderInitializer, InitExceptionTypes } = require("./initializer");
const { ContextKeys, showErrorPopup, getAPI } = require("../utils/utils");
const { MdbSpawnConfig } = require("../spawn");
const { MdbSession } = require("../dap/mdb");
const fs = require("fs")

const initializer = async (config) => {

  if(config.hasOwnProperty("mdbPath")) {
    const mdbPath = config?.mdbPath ?? "mdb";
    if(!fs.existsSync(mdbPath)) {
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
    return "midas-canonical";
  }

  async resolveDebugConfiguration(folder, config, token) {
    getAPI().clearChannelOutputs();
    try {
      await super.defaultInitialize(config, initializer);
    } catch (err) {
      switch(err.type) {
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
    if (config.request == "attach" && config["targetVariant"] == null) {
      throw new Error("targetVariant field is missing. This field is required to determine target to attach to.");
    }

    return config;
  }

  async resolveDebugConfigurationWithSubstitutedVariables(folder, debugConfiguration, token) {
    return debugConfiguration;
  }
}

class MdbDebugAdapterFactory {
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
    vscode.commands.executeCommand("setContext", ContextKeys.DebugType, config.type);
    const mdb = new MdbSession(this.spawnConfig(config), null, this.#cp_ui);
    return new vscode.DebugAdapterInlineImplementation(mdb);
  }

  spawnConfig(config) {
    return new MdbSpawnConfig(config);
  }
}

module.exports = {
  MdbConfigurationProvider,
  MdbDebugAdapterFactory,
};
