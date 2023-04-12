"use strict";

const vscode = require("vscode");
const { getVSCodeCommands } = require("./commandsRegistry");
const { ConfigurationProvider, DebugAdapterFactory } = require("./providers/midas-gdb");
const { RRConfigurationProvider, RRDebugAdapterFactory } = require("./providers/midas-rr");
const { CheckpointsViewProvider } = require("./ui/checkpoints/checkpoints");
const { which } = require("./utils/sysutils");
const { getRR, strEmpty } = require("./utils/utils");
const fs = require("fs");
const Path = require("path")

/** @typedef { { path: string, version: string, managed: boolean } } Tool */
/** @typedef { { rr: Tool, gdb: Tool } } Toolchain */
/** @typedef { { midas_version: string, toolchain: Toolchain } } MidasConfig */

/**
 * @returns { MidasConfig }
 */
const default_config_contents = () => {
  return {
    midas_version: "",
    toolchain: {
      rr: { path: "", version: "", managed: false },
      gdb: { path: "", version: "", managed: false },
    },
  }
};

global.API = null;

/**
 * Public "API" returned by activate function
 */
class MidasAPI {
  #CFG_NAME = ".config";

  /** @type {import("vscode").ExtensionContext} */
  #context;

  #toolchainAddedToEnv = false

  /** @param {import("vscode").ExtensionContext} ctx */
  constructor(ctx) {
    this.#context = ctx;

    if (!fs.existsSync(this.get_storage_path_of())) {
      fs.mkdirSync(this.get_storage_path_of(), { recursive: true });
    }
    let cfg_path = this.get_storage_path_of(this.#CFG_NAME);
    if(!fs.existsSync(cfg_path)) {
      fs.writeFileSync(cfg_path, JSON.stringify(default_config_contents()));
    }
  }

  setup_env_vars() {
    const cfg = this.get_config();
    if(!this.#toolchainAddedToEnv) {
      if(!strEmpty(cfg.toolchain.rr.path)) {
        const path = Path.dirname(cfg.toolchain.rr.path);
        this.#context.environmentVariableCollection.append("PATH", `:${path}`)
        console.log(`appended ${path} to $PATH`)
        this.#toolchainAddedToEnv = true;
      }
    }
  }

  /** @param { MidasConfig } cfg */
  #write_config(cfg) {
    try {
      const data = JSON.stringify(cfg, null, 2);
      fs.writeFileSync(this.get_storage_path_of(this.#CFG_NAME), data);
      console.log(`Wrote configuration ${data}`);
    } catch(err) {
      console.log(`Failed to write configuration. Error: ${err}`);
    }
  }

  /** @returns {MidasConfig} */
  get_config() {
    const cfg_path = this.get_storage_path_of(this.#CFG_NAME);
    if(!fs.existsSync(cfg_path)) {
      fs.writeFileSync(cfg_path, JSON.stringify(default_config_contents()));
      return default_config_contents();
    } else {
      const data = fs.readFileSync(cfg_path).toString();
      const cfg = JSON.parse(data);
      return cfg;
    }
  }

  /** @returns { Toolchain } */
  get_toolchain() {
    const midas_config_file = this.get_storage_path_of(this.#CFG_NAME);
    try {
      const data = fs.readFileSync(midas_config_file).toString();
      if(data) {
        const parsed = JSON.parse(data);
        console.assert(parsed.toolchain != undefined, "Toolchain has not been recorded in configuration file");
        console.log(`Toolchain settings: ${JSON.stringify(parsed.toolchain, null, 2)}`);
        return parsed.toolchain;
      } else {
        console.log("Configuration file could not be read");
      }
    } catch(err) {
      console.log(`Midas Configuration read failed: ${err}`);
    }
  }

  /**
   * Write RR settings to config file
   * @param {Tool} rr
   */
  write_rr(rr) {
    let cfg = this.get_config();
    cfg.toolchain.rr = rr;
    this.#write_config(cfg);
  }

  /**
   * Write GDB settings to config file
   * @param {Tool} gdb
   */
  write_gdb(gdb) {
    let cfg = this.get_config();
    cfg.toolchain.gdb = gdb;
    this.#write_config(cfg);
  }

  /**
   * Write Midas version to config file
   */
  write_midas_version() {
    let cfg = this.get_config();
    cfg.midas_version = this.#context.extension.packageJSON["version"];
    this.#write_config(cfg);
  }

  /**
   * @param {string | null} fileOrDir
   * @returns {string} - directory or file path in global storage
   */
  get_storage_path_of(fileOrDir = null) {
    if (fileOrDir != null) {
      if (fileOrDir[0] == "/") {
        fileOrDir = fileOrDir.substring(1);
      }
      return `${this.#context.globalStorageUri.fsPath}/${fileOrDir}`;
    } else {
      return this.#context.globalStorageUri.fsPath;
    }
  }

  /**
   * Get path of `tool`, with multiple fallbacks. Order of resolving of `tool` path:
   * 1. VSCode Midas.\<rr | gdb\> Settings
   * 2. Midas managed toolchain (when built or installed via Midas command)
   * 3. $PATH
   * 4. null|undefined if not found in path
   * @param { "rr" | "gdb" } tool
   * @returns { Promise<string?> }
   */
  async resolve_tool_path(tool) {
    const cfg = vscode.workspace.getConfiguration("midas");
    if(!strEmpty(cfg.get(tool)))
      return cfg.get(tool);

    const toolchain = this.get_toolchain();

    if(!strEmpty(toolchain[tool].path))
      return toolchain[tool].path;

    const tool_in_path = await which(tool);
    if(!strEmpty(tool_in_path))
      return tool_in_path;
    return undefined;
  }

  log() {
    let cfg = this.get_config();
    console.log(`Current settings: ${JSON.stringify(cfg, null, 2)}`)
  }
}

/**
 * Run first time midas runs.
 * @param { MidasAPI } api
 */
async function init_midas(api) {
  const cfg = api.get_config();
  // the first time we read config, this will be empty.
  // this can't be guaranteed with vscode mementos. They just live their own life of which we
  // have 0 oversight over.
  if(strEmpty(cfg.midas_version)) {
    const answers = ["yes", "no"];
    const msg = "Thank you for using Midas. Do you want to setup RR settings for Midas?";
    const opts = { modal: true, detail: "Midas will attempt to find RR on your system" };
    const answer = await vscode.window.showInformationMessage(msg, opts, ...answers);
    if (answer == "yes") {
      const rr = await which("rr");
      if(strEmpty(rr)) {
        const msg = "No RR found in $PATH. Do you want Midas to install or build RR?";
        const opts = { modal: true };
        if ((await vscode.window.showInformationMessage(msg, opts, ...answers)) == "yes") {
          await getRR();
        }
      }
    }
  }
  api.setup_env_vars()
  api.write_midas_version()
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function activateExtension(context) {
  const cp_provider = new CheckpointsViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(cp_provider.type, cp_provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
  context.subscriptions.push(...getVSCodeCommands());
  let provider = new ConfigurationProvider();
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(
      provider.type,
      provider,
      vscode.DebugConfigurationProviderTriggerKind.Dynamic
    )
  );
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(provider.type, new DebugAdapterFactory())
  );

  let rrProvider = new RRConfigurationProvider();
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(
      rrProvider.type,
      rrProvider,
      vscode.DebugConfigurationProviderTriggerKind.Dynamic
    )
  );
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(rrProvider.type, new RRDebugAdapterFactory(cp_provider))
  );
  global.API = new MidasAPI(context);
  global.API.log();
  await init_midas(global.API);
}

function deactivateExtension() {}

module.exports = {
  activateExtension,
  deactivateExtension,
  MidasAPI
};
