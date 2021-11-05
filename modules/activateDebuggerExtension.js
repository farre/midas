"use strict";

const vscode = require("vscode");
const { RRSession } = require("./debugSession");
const { getVSCodeCommands } = require("./commandsRegistry");
const { ConfigurationProvider } = require("./debugSession");
/**
 *
 * @param {vscode.ExtensionContext} context
 * @param {vscode.DebugAdapterDescriptorFactory} [descriptorFactory]
 */
function activateExtension(context, descriptorFactory) {
  context.subscriptions.push(...getVSCodeCommands());

  let provider = new ConfigurationProvider();
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(
      "rrdbg",
      provider,
      vscode.DebugConfigurationProviderTriggerKind.Dynamic
    )
  );
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(
      "rrdbg",
      {
        /**
         * @param {vscode.WorkspaceFolder | undefined} folder
         * @returns { vscode.ProviderResult<vscode.DebugConfiguration[]> }
         */
        provideDebugConfigurations(folder) {
          return [
            {
              name: "Launch",
              request: "launch",
              type: "rrdbg",
              program: "${workspaceFolder}/build/testapp",
              stopOnEntry: true,
            },
          ];
        },
      },
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
    descriptorFactory = new RRDebugAdapterFactory();
  }
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(
      "rrdbg",
      descriptorFactory
    )
  );
}

class RRDebugAdapterFactory {
  /**
   *
   * @param { vscode.DebugSession } session
   * @returns ProviderResult<vscode.DebugAdapterDescriptor>
   */
  createDebugAdapterDescriptor(session) {
    return new vscode.DebugAdapterInlineImplementation(
      new RRSession("rrdbg.log")
    );
  }
}

module.exports = {
  activateExtension,
};
