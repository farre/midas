"use strict";

const vscode = require("vscode");
const { getVSCodeCommands } = require("./commandsRegistry");
const { ConfigurationProvider, DebugAdapterFactory } = require("./providers/midas-gdb");
const { RRConfigurationProvider, RRDebugAdapterFactory } = require("./providers/midas-rr");

/**
 * @param {vscode.ExtensionContext} context
 * @param {vscode.DebugAdapterDescriptorFactory} [descriptorFactory]
 */
function activateExtension(context, descriptorFactory) {
  context.subscriptions.push(...getVSCodeCommands());
  let provider = new ConfigurationProvider();
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(provider.type, provider, vscode.DebugConfigurationProviderTriggerKind.Dynamic)
  );
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(provider.type, new DebugAdapterFactory())
  );

  let rrProvider = new RRConfigurationProvider();
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(rrProvider.type, rrProvider, vscode.DebugConfigurationProviderTriggerKind.Dynamic)
  );
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(rrProvider.type, new RRDebugAdapterFactory())
  );
}

function deactivateExtension() {}

module.exports = {
  activateExtension,
  deactivateExtension,
};
