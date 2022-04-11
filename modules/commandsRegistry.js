"use strict";
const fs = require("fs");
/**
 * @typedef { import("vscode").Disposable } Disposable
 */
const vscode = require("vscode");
const { registerCommand } = require("vscode").commands;

/**
 * Returns VS Code commands that are to be registered
 * @param {vscode.ExtensionContext} context
 * @returns { Disposable[] }
 */
function getVSCodeCommands(context) {
  let rrRecord = registerCommand("midas.rr-record", async () => {
    const spawnTerminalRunRecord = (pathToBinary) => {
      let t = vscode.window.createTerminal("rr record terminal");
      t.show();
      t.sendText(`rr record ${pathToBinary}`);
    };

    const config = vscode.workspace.getConfiguration("launch", vscode.workspace.workspaceFolders[0].uri);
    // retrieve values
    const values = config
      .get("configurations")
      .filter((cfg) => cfg.type == "midas" || cfg.type == "midas-rr" || cfg.type == "midas-gdb")
      .map((cfg) => cfg.program);
    let programs = values.map((c) => c.replace("${workspaceFolder}", vscode.workspace.workspaceFolders[0].uri.fsPath));
    if (programs.length >= 1) {
      let program = await vscode.window.showQuickPick(programs, {
        canPickMany: false,
        ignoreFocusOut: true,
        title: "Select program to record",
      });
      if (!program) return;
      spawnTerminalRunRecord(program);
    } else {
      vscode.window.showInformationMessage(
        "rr Record command uses the program configuration property in launch.json but this was not set."
      );
      return;
    }
  });

  let continueAll = registerCommand("midas.session-continue-all", () => {
    vscode.debug.activeDebugSession.customRequest("continueAll");
  });

  let pauseAll = registerCommand("midas.session-pause-all", () => {
    vscode.debug.activeDebugSession.customRequest("pauseAll");
  });

  let reverseFinish = registerCommand("midas.reverse-finish", () => {
    vscode.debug.activeDebugSession.customRequest("reverse-finish");
  });

  let hotReloadScripts = registerCommand("midas.hot-reload-scripts", () => {
    vscode.debug.activeDebugSession.customRequest("hot-reload-scripts");
  });

  let displayLogs = registerCommand("midas.show-logs", async () => {
    const debug_log = `${context.extensionPath}/debug.log`;
    if (fs.existsSync(debug_log)) {
      vscode.window.showTextDocument(vscode.Uri.parse(debug_log), { viewColumn: 1 });
      vscode.window.showTextDocument(vscode.Uri.parse(`${context.extensionPath}/error.log`), { viewColumn: 2 });
      vscode.window.showTextDocument(vscode.Uri.parse(`${context.extensionPath}/performance_time.log`), { viewColumn: 3 });
    } else {
      vscode.window.showInformationMessage("No logs have yet been created");
    }
  });

  return [rrRecord, continueAll, pauseAll, reverseFinish, hotReloadScripts, displayLogs];
}

module.exports = {
  getVSCodeCommands,
};
