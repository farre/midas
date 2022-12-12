"use strict";

const { async } = require("regenerator-runtime");
const vscode = require("vscode");
const { getVSCodeCommands } = require("./commandsRegistry");
const { ConfigurationProvider, DebugAdapterFactory } = require("./providers/midas-gdb");
const { RRConfigurationProvider, RRDebugAdapterFactory } = require("./providers/midas-rr");
const { CheckpointsViewProvider } = require("./ui/checkpoints/checkpoints");

let activated = false;

class MidasCacheManager {
  #default = { toolchain: { rr: { path: "rr", version: undefined }, gdb: { path: "gdb", version: undefined } } };

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

  get rr() {
    return this.cache.toolchain.rr;
  }

  get gdb() {
    return this.cache.toolchain.gdb;
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
 * @param {vscode.ExtensionContext} context
 * @returns { Promise<{ cache: MidasCacheManager }> }
 */
async function activateExtension(context) {
  if (!activated) {
    const cp_provider = new CheckpointsViewProvider(context);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(cp_provider.type, cp_provider, {
        webviewOptions: { retainContextWhenHidden: true },
      })
    );
    context.subscriptions.push(...getVSCodeCommands(context));
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
    activated = true;
  }
  /**

  /**
   * @returns { vscode.Memento & { setKeysForSync(keys: readonly string[]): void; }}
   */
  const getGlobalState = () => {
    return context.globalState;
  };

  let cacheManager = new MidasCacheManager(getGlobalState);
  return { cache: cacheManager };
}

function deactivateExtension() {}

module.exports = {
  activateExtension,
  deactivateExtension,
  MidasCacheManager,
};
