"use strict";

const vscode = require("vscode");
const { DebugSession } = require("./debugSession");
const { getVSCodeCommands } = require("./commandsRegistry");
const { ConfigurationProvider } = require("./debugSession");

/**
 *
 * @param {vscode.ExtensionContext} context
 * @param {vscode.DebugAdapterDescriptorFactory} [descriptorFactory]
 */
function activateExtension(context, descriptorFactory) {
  context.subscriptions.push(...getVSCodeCommands());
  context.workspaceState.update("allStopModeSet", false);
  let provider = new ConfigurationProvider();
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(
      "midas",
      provider,
      vscode.DebugConfigurationProviderTriggerKind.Dynamic
    )
  );
  // TODO(simon): when we've implemented the most bare bones debugger
  //  meaning, we can start gdb, launch a program and stop on entry
  //  we need to implement some "frontend" functionality,
  //  such as, "what happens when the user hoves on a variable in the text editor?"
  //  we do that by adding subscriptions to the context, by using functions like
  //  vscode.languages.registerEvaluatableExpressionProvider(...)
  if (!descriptorFactory) {
    descriptorFactory = new DebugAdapterFactory();
  }
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(
      "midas",
      descriptorFactory
    )
  );
}

class DebugAdapterFactory {
  /**
   *
   * @param { vscode.DebugSession } session
   * @returns ProviderResult<vscode.DebugAdapterDescriptor>
   */
  createDebugAdapterDescriptor(session) {
    return new vscode.DebugAdapterInlineImplementation(new DebugSession(true));
  }
}

module.exports = {
  activateExtension,
};
