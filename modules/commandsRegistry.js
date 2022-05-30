"use strict";
const { execSync } = require("child_process");
const fs = require("fs");
const { getPid, getVersion, isNothing } = require("./utils/utils");
/**
 * @typedef { import("vscode").Disposable } Disposable
 */
const vscode = require("vscode");
const { CustomRequests } = require("./debugSessionCustomRequests");
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
    const programs = config
      .get("configurations")
      .filter((cfg) => cfg.type == "midas" || cfg.type == "midas-rr" || cfg.type == "midas-gdb")
      .map((cfg) => cfg.program)
      .map((c) => c.replace("${workspaceFolder}", vscode.workspace.workspaceFolders[0].uri.fsPath));
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
    vscode.debug.activeDebugSession.customRequest(CustomRequests.ContinueAll);
  });

  let pauseAll = registerCommand("midas.session-pause-all", () => {
    vscode.debug.activeDebugSession.customRequest(CustomRequests.PauseAll);
  });

  let reverseFinish = registerCommand("midas.reverse-finish", () => {
    vscode.debug.activeDebugSession.customRequest(CustomRequests.ReverseFinish);
  });

  const issueGithubReport = registerCommand("midas.issue-report", async () => {
    if (vscode.debug.activeDebugSession) {
      const cfg = vscode.debug.activeDebugSession.configuration;
      if (!isNothing(cfg) && (cfg.type == "midas-rr" || cfg.type == "midas-gdb")) {
        const gdb_version = await getVersion(cfg.gdbPath);
        let log_pretext = [];
        try {
          let output = execSync("uname -a");
          log_pretext.push(output.toString());
        } catch {
          log_pretext.push("Linux Distro: <enter distro & version>");
        }
        log_pretext.push(`User GDB Version: ${gdb_version.major}.${gdb_version.minor}.${gdb_version.patch}`);
        if (cfg.type == "midas-rr") {
          const rrpath = cfg.rrPath;
          const rr_version = await getVersion(rrpath);
          log_pretext.push(`User RR Version: ${rr_version.major}.${rr_version.minor}.${rr_version.patch}`);
        }
        log_pretext.push("Python Error Logs:");
        const python_log = `${context.extensionPath}/error.log`;
        const data = fs.readFileSync(python_log);
        log_pretext.push("\n");
        log_pretext.push(data.toString());

        let doc = await vscode.workspace.openTextDocument({ language: "text", content: log_pretext.join("\n") });
        vscode.window.showTextDocument(doc);
        return;
      }
    }
    vscode.window.showInformationMessage("You must have an active debug session running to create a Github issue log");
  });

  let hotReloadScripts = registerCommand("midas.hot-reload-scripts", () => {
    vscode.debug.activeDebugSession.customRequest(CustomRequests.ReloadMidasScripts);
  });

  let displayLogs = registerCommand("midas.show-logs", async () => {
    const debug_log = `${context.extensionPath}/debug.log`;
    if (fs.existsSync(debug_log)) {
      vscode.window.showTextDocument(vscode.Uri.parse(debug_log), { viewColumn: 1 });
      vscode.window.showTextDocument(vscode.Uri.parse(`${context.extensionPath}/error.log`), { viewColumn: 2 });
      vscode.window.showTextDocument(vscode.Uri.parse(`${context.extensionPath}/performance_time.log`), {
        viewColumn: 3,
      });
    } else {
      vscode.window.showInformationMessage("No logs have yet been created");
    }
  });

  const getPid_ = registerCommand("midas.getPid", getPid);

  return [rrRecord, continueAll, pauseAll, reverseFinish, hotReloadScripts, displayLogs, issueGithubReport, getPid_];
}

module.exports = {
  getVSCodeCommands,
};
