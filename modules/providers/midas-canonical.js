const vscode = require("vscode");
const { ConfigurationProviderInitializer, InitExceptionTypes } = require("./initializer");
const { ContextKeys, showErrorPopup, getAPI } = require("../utils/utils");
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
    return "midas-canonical";
  }

  prepareAttachArgs(config)  {
    const variants = [config.targetVariant?.rr, config.targetVariant?.remote, config.targetVariant?.native];
    if(variants.filter(v => v != null).length != 1) {
      throw new Error(`targetVariant on attach configuration must be one of either 'rr', 'remote' or 'native'. You have ${variants.length} set`);
    }

    if(config.targetVariant?.rr) {
      const [host, port] = config.targetVariant.rr.host.split(":");
      const portNumber = Number.parseInt(port);
      config.RRSession = true;
      return {
        type: "rr",
        host: host,
        port: portNumber,
        allstop: true,
      };
    }

    if(config.targetVariant?.remote) {
      const [host, port] = config.targetVariant.rr.host.split(":");
      const portNumber = Number.parseInt(port);
      config.RRSession = false;
      return {
        type: "gdbremote",
        host: host,
        port: portNumber,
        allstop: true,
      };
    }

    if(config.targetVariant?.native) {
      config.RRSession = false;
      throw new Error(`Attach for ptrace not yet implemented`);
      // return { type: "ptrace", pid: null, allstop: true };
    }

  }

  async resolveDebugConfiguration(folder, config, token) {
    return config;
  }

  async resolveDebugConfigurationWithSubstitutedVariables(folder, config, token) {
    if(config.RRSession == null) {
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
      if (config.request == "attach" && config["targetVariant"] == null) {
        throw new Error("targetVariant field is missing. This field is required to determine target to attach to.");
      }
      if(config.request == "attach") {
        config.attachArguments = this.prepareAttachArgs(config);
      }

      return config;
    } else {
      // Assume MDB sends well-formed and sane config to itself.
      if(config.childConfiguration == null && config.childConfiguration?.path == null) {
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
      vscode.commands.executeCommand("setContext", ContextKeys.DebugType, config.type);
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
