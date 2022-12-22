/* eslint-disable no-unused-vars */
const vscode = require("vscode");
const { activateExtension, deactivateExtension } = require("./modules/activateDebuggerExtension");
// this method is called when your extension is activated
// your extension is activated the very first time the command is executed

/**
 * @param {vscode.ExtensionContext} context
 * @returns { Promise<import("./modules/activateDebuggerExtension").MidasAPI> }
 */
async function activate(context) {
  return activateExtension(context);
}

// this method is called when your extension is deactivated
function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
