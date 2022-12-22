"use strict";

const vscode = require("vscode");
const { getVSCodeCommands } = require("./commandsRegistry");
const { ConfigurationProvider, DebugAdapterFactory } = require("./providers/midas-gdb");
const { RRConfigurationProvider, RRDebugAdapterFactory } = require("./providers/midas-rr");
const { CheckpointsViewProvider } = require("./ui/checkpoints/checkpoints");
const { which } = require("./utils/sysutils");
const { getRR, strEmpty } = require("./utils/utils");
const fs = require("fs");
const { registerCommand } = vscode.commands;

let activate_once = false;

/**
 * Public "API" returned by activate function
 */
class MidasAPI {
  #user_storage;
  #cache_manager;
  constructor(cacheManager, globalUserStorage) {
    this.#cache_manager = cacheManager;
    this.#user_storage = globalUserStorage;
    if (!fs.existsSync(globalUserStorage)) {
      fs.mkdirSync(globalUserStorage, { recursive: true });
    }
  }

  /**
   * @param {string | null} fileOrDir
   * @returns {string} - directory or file path in global storage
   */
  getGlobalStoragePathOf(fileOrDir = null) {
    if (fileOrDir != null) {
      if (fileOrDir[0] == "/") {
        fileOrDir = fileOrDir.substring(1);
      }
      return `${this.#user_storage}/${fileOrDir}`;
    } else {
      return this.#user_storage;
    }
  }

  /**
   * @returns { MidasCacheManager }
   */
  get cacheManager() {
    return this.#cache_manager;
  }

  /**
   * Get path of RR, with multiple fallbacks. First checks global setting in preferences,
   * then cache, and then finally failure.
   */
  async maybe_rr_path() {
    const cfg = vscode.workspace.getConfiguration("midas");
    const rrPathInConfig = cfg.get("rr");
    if(!strEmpty(rrPathInConfig)) {
      return rrPathInConfig;
    }
    if(!strEmpty(this.#cache_manager.rr.path)) {
      return this.#cache_manager.rr.path;
    }
    const rrInPath = await which("rr");
    if(!strEmpty(rrInPath)) {
      return rrInPath;
    }
    return undefined;
  }
}

class MidasCacheManager {
  #default = {
    toolchain: {
      rr: { path: undefined, version: undefined },
      gdb: { path: undefined, version: undefined },
    },
    extension_initialized: false,
  };

  /** @type {function(): vscode.Memento & { setKeysForSync(keys: readonly string[]): void; }} */
  #stateGetter;

  /**
   * @param {function(): vscode.Memento & { setKeysForSync(keys: readonly string[]): void; }} stateGetter
   */
  constructor(stateGetter) {
    this.#stateGetter = stateGetter;
  }

  get cache() {
    // returns cache or default if it doesn't exist.
    return this.#stateGetter().get("MidasCache", this.#default);
  }

  get rr() {
    return this.cache.toolchain.rr;
  }

  get gdb() {
    return this.cache.toolchain.gdb;
  }

  get has_been_initialized() {
    return this.cache.extension_initialized;
  }

  async set_initialized(value = true) {
    let cache_ = this.cache;
    cache_.extension_initialized = value;
    await this.#write_cache(cache_);
  }

  /**
   * @param {{path?: string, version?: string}} rr_update - update the global rr settings.
   * Each property is optional and only the passed in properties are set. Passing `rr_update` as undefined
   * reverts the setting back to default.
   */
  async set_rr(rr_update) {
    let cache_ = this.cache;
    if (rr_update === undefined) {
      const default_ = this.#default;
      cache_.toolchain.rr = default_.toolchain.rr;
    } else {
      try {
        for (const property in rr_update) {
          cache_.toolchain.rr[property] = rr_update[property];
        }
      } catch (err) {
        // Possible corruption of setting, restore to default, then write new settings
        cache_.toolchain.rr = this.#default.toolchain.rr;
        await this.#write_cache(cache_);
        for (const property in rr_update) {
          cache_.toolchain.rr[property] = rr_update[property];
        }
      }
    }
    await this.#write_cache(cache_);
  }

  /**
   * @param {{path?: string, version?: string}} gdb_update - update the global gdb settings.
   * Each property is optional and only the passed in properties are set. Passing `gdb_update` as undefined
   * reverts the setting back to default.
   */
  async set_gdb(gdb_update) {
    let cache_ = this.cache;
    if (gdb_update === undefined) {
      const default_ = this.#default;
      cache_.toolchain.gdb = default_.toolchain.gdb;
    } else {
      try {
        for (const property in gdb_update) {
          cache_.toolchain.gdb[property] = gdb_update[property];
        }
      } catch (err) {
        // Possible corruption of setting, restore to default, then write new settings
        cache_.toolchain.gdb = this.#default.toolchain.gdb;
        await this.#write_cache(cache_);
        for (const property in gdb_update) {
          cache_.toolchain.rr[property] = gdb_update[property];
        }
      }
    }
    await this.#write_cache(cache_);
  }

  async #write_cache(cache) {
    return this.#stateGetter().update("MidasCache", cache);
  }
}

/**
 * Run first time midas runs.
 * @param { MidasAPI } api
 */
async function init_midas(api) {
  const manager = api.cacheManager;
  await manager.set_initialized();
  const answers = ["yes", "no"];
  const msg = "Thank you for using Midas. Do you want to setup RR settings for Midas?";
  const opts = { modal: true, detail: "Midas will attempt to find RR on your system" };
  const answer = await vscode.window.showInformationMessage(msg, opts, ...answers);
  if (answer == "yes") {
    const rr = await which("rr");
    if(strEmpty(rr)) {
      const msg = "No RR found in $PATH. Do you want Midas to install RR?";
      const opts = { modal: true };
      if ((await vscode.window.showInformationMessage(msg, opts, ...answers)) == "yes") {
        getRR();
      }
    } else {
      await manager.set_rr({ path: rr });
    }
  }
}

/**
 * @param {vscode.ExtensionContext} context
 * @returns { Promise<MidasAPI> }
 */
async function activateExtension(context) {
  if (!activate_once) {
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

    const getGlobalState = () => {
      return context.globalState;
    };

    const midas_api = new MidasAPI(new MidasCacheManager(getGlobalState), context.globalStorageUri.fsPath);
    const init_toolchain = async () => {
      await init_midas(midas_api);
    };
    const setup_toolchain_cmd = registerCommand("midas.setup-toolchain", init_toolchain);
    if (!midas_api.cacheManager.has_been_initialized) {
      await init_toolchain();
    }
    context.subscriptions.push(setup_toolchain_cmd);
    return midas_api;
  } else {
    const getGlobalState = () => {
      return context.globalState;
    };
    return new MidasAPI(new MidasCacheManager(getGlobalState), context.globalStorageUri.fsPath);
  }
}

function deactivateExtension() {
  activate_once = false;
}

module.exports = {
  activateExtension,
  deactivateExtension,
  MidasAPI
};
