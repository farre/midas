"use strict";

const vscode = require("vscode");
const { RRSession } = require("./debugSession");
const { getVSCodeCommands } = require("./commandsRegistry");

/**
 *
 * @param {vscode.ExtensionContext} context
 * @param {vscode.DebugAdapterDescriptorFactory} [descriptorFactory]
 */
function activateExtension(context, descriptorFactory) {
  context.subscriptions.push(...getVSCodeCommands());
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
              program: "${config:rrdbg.bin}",
            },
          ];
        },
      },
      vscode.DebugConfigurationProviderTriggerKind.Dynamic
    )
  );
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
