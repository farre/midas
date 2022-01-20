"use strict";

/**
 * @typedef { import("vscode").Disposable } Disposable
 */
const vscode = require("vscode");
const { showErrorMessage } = require("vscode").window;
const { registerCommand } = require("vscode").commands;

/**
 * Helper function (sorta like unimplemented!(...) in rust, only we don't panic)
 * @param {string} commandName
 * @param { string | undefined } msg
 */
const unimplemented = (commandName, msg = "No message provided") => {
  showErrorMessage(`midas.${commandName} not yet implemented: ${msg}`);
};

/**
 * Returns VS Code commands that are to be registered
 * @returns { Disposable[] }
 */
function getVSCodeCommands() {
  let rrRecord = registerCommand("midas.rr-record", async () => {

    const spawnTerminalRunRecord = (pathToBinary) => {
      let t = vscode.window.createTerminal("rr record terminal");
      t.sendText(`rr record ${pathToBinary}`);
    }

    const config = vscode.workspace.getConfiguration(
      'launch',
      vscode.workspace.workspaceFolders[0].uri
    );
    // retrieve values
    const values = config.get('configurations').filter((cfg) => cfg.type == "midas").map((cfg) => cfg.program);
    let programs = values.map((c) => c.replace("${workspaceFolder}", vscode.workspace.workspaceFolders[0].uri.fsPath));
    let pathToBinaryToRecord = "";
    if(programs.length >= 1) {
      let program = await vscode.window.showQuickPick(programs, {
        canPickMany: false,
        ignoreFocusOut: true,
        title: "Select program to record",
      });
      if(!program) return;
      spawnTerminalRunRecord(program);
    } else {
      vscode.window.showInformationMessage("rr Record command uses the program configuration property in launch.json but this was not set.");
      return;
    }
  });
  let stopDebugging = registerCommand("midas.stop-debug-session", () => unimplemented("stop-debug-session"));
  let continueAll = registerCommand("midas.session-continue-all", () => {
    vscode.debug.activeDebugSession.customRequest("continueAll");
  });

  let pauseAll = registerCommand("midas.session-pause-all", () => {
    vscode.debug.activeDebugSession.customRequest("pauseAll");
  });

  let reverseFinish = registerCommand("midas.reverse-finish", () => {
    vscode.debug.activeDebugSession.customRequest("reverse-finish");
  });

  let watch = registerCommand("midas.set-watchpoint", ({ container, variable }) => {
    if (!container.evaluateName) {
      vscode.window.showErrorMessage("Variable has no evaluatable name");
      return;
    }
    vscode.debug.activeDebugSession.customRequest("set-watchpoint", { location: `${container.evaluateName}.${variable.name}` });
  });

  return [rrRecord, continueAll, pauseAll, reverseFinish, watch];
}

module.exports = {
  getVSCodeCommands,
};
