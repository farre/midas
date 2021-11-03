"use strict";

const vscode = require("vscode");
const {RRSession} = require("./debugSession");

const rrdbg_unimplemented = (commandName) => {
  vscode.window.showErrorMessage(`rrdbg.${commandName} not yet implemented`);
};

/**
 *
 * @param {vscode.ExtensionContext} context
 * @param {vscode.DebugAdapterDescriptorFactory} [descriptorFactory]
 */
function activateExtension(context, descriptorFactory) {
  let rr_start = vscode.commands.registerCommand("rrdbg.rr-start", () => rrdbg_unimplemented("rr-start"));
  let rr_stop = vscode.commands.registerCommand("rrdbg.rr-stop", () => rrdbg_unimplemented("rr-stop"));
  let getExecutable = vscode.commands.registerCommand("rrdbg.get-binary", () => rrdbg_unimplemented("get-binary"));
  context.subscriptions.push(rr_start);
  context.subscriptions.push(rr_stop);
  context.subscriptions.push(getExecutable);

  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider("rrdbg", {
    /**
     * @param {vscode.WorkspaceFolder | undefined} folder
     * @returns { vscode.ProviderResult<vscode.DebugConfiguration[]> }
    */
    provideDebugConfigurations(folder) {
      return [
        {
          "name": "Launch",
          "request": "launch",
          "type": "rrdbg",
          "program": "${config:rrdbg.bin}"
        }
      ]
    }
  }, vscode.DebugConfigurationProviderTriggerKind.Dynamic));
  if(!descriptorFactory) {
    descriptorFactory = new RRDebugAdapterFactory();
  }
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory("rrdbg", descriptorFactory));
}

class RRDebugAdapterFactory {
  /**
   *
   * @param { vscode.DebugSession } session
   * @returns ProviderResult<vscode.DebugAdapterDescriptor>
   */
  createDebugAdapterDescriptor(session) {
    return new vscode.DebugAdapterInlineImplementation(new RRSession("rrdbg.log"));
  }
}


module.exports = {
  activateExtension
}