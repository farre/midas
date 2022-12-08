"use strict";

const vscode = require("vscode");
const { getVSCodeCommands } = require("./commandsRegistry");
const { ConfigurationProvider, DebugAdapterFactory } = require("./providers/midas-gdb");
const { RRConfigurationProvider, RRDebugAdapterFactory } = require("./providers/midas-rr");
const { CheckpointsViewProvider } = require("./ui/checkpoints/checkpoints");

/**
 * @param {vscode.ExtensionContext} context
 * @param {vscode.DebugAdapterDescriptorFactory} [descriptorFactory]
 */
async function activateExtension(context, descriptorFactory) {
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
  const CacheManager = {
    read: () => {
      return context.globalState.get("MidasCache", {
        cache: context.globalState.get("MidasCache", {
          rr: { path: "rr", version: undefined },
          gdb: { path: "gdb", version: undefined },
        }),
      });
    },
    write: async (cache) => {
      context.globalState.update("MidasCache", { cache });
    },
  };
  let { cache } = CacheManager.read();
  return { CacheManager };
}

function deactivateExtension() {}

module.exports = {
  activateExtension,
  deactivateExtension,
};
