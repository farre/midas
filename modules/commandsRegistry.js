"use strict";
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { getPid, getVersion, isNothing, getRR, showReleaseNotes, getAPI } = require("./utils/utils");
const { getExtensionPathOf, sudo } = require("./utils/sysutils");
/**
 * @typedef { import("vscode").Disposable } Disposable
 */
const vscode = require("vscode");
const { CustomRequests } = require("./debugSessionCustomRequests");
const { ProvidedAdapterTypes } = require("./shared");
const { registerCommand } = require("vscode").commands;

/**
 * Returns VS Code commands that are to be registered
 * @returns { Disposable[] }
 */
function getVSCodeCommands() {
  let rrRecord = registerCommand("midas.rr-record", async () => {
    const spawnTerminalRunRecord = (pathToBinary) => {
      let t = vscode.window.createTerminal("rr record terminal");
      t.show();
      t.sendText(`rr record ${pathToBinary}`);
    };

    const config = vscode.workspace.getConfiguration("launch", vscode.workspace.workspaceFolders[0].uri);
    // retrieve values
    const isMidasConfig = (cfg) => {
      switch(cfg.type ?? "") {
        case ProvidedAdapterTypes.Gdb:
        case ProvidedAdapterTypes.RR:
        case ProvidedAdapterTypes.Canonical:
          return true;
        default:
          return false;
      }
    };
    const programs = config
      .get("configurations")
      .filter(
        (cfg) => isMidasConfig(cfg) && cfg.program !== undefined
      )
      .map((cfg) => cfg.program.replace("${workspaceFolder}", vscode.workspace.workspaceFolders[0].uri.fsPath));
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
    vscode.debug.activeDebugSession.customRequest(CustomRequests.ContinueAll, {});
  });

  let pauseAll = registerCommand("midas.session-pause-all", () => {
    vscode.debug.activeDebugSession.customRequest(CustomRequests.PauseAll);
  });

  let reverseFinish = registerCommand("midas.reverse-finish", () => {
    vscode.debug.activeDebugSession.customRequest(CustomRequests.ReverseFinish);
  });

  let toggleHexFormatting = registerCommand("midas.toggle-hex-formatting", (/** item */) => {
    vscode.debug.activeDebugSession.customRequest("toggle-hex");
  });

  const zenWorkaround = registerCommand("midas.zen-workaround", async (/** item */) => {
    const script = path.join(getAPI().getToolchain().rr.root_dir, "rr-master", "scripts", "zen_workaround.py");
    if (fs.existsSync(script)) {
      let pass = await vscode.window.showInputBox({ prompt: "input your sudo password", password: true });
      await sudo(["python", script], pass, (code) => {
        if (code == 0) {
          vscode.window.showInformationMessage("Zen Workaround is active");
        } else {
          vscode.window.showInformationMessage("Zen Workaround failed");
        }
      });
    }
  });

  let runToEvent = registerCommand("midas.run-to-event", () => {
    vscode.debug.activeDebugSession.customRequest(CustomRequests.RunToEvent);
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
        const python_log = getExtensionPathOf("error.log");
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
    const debug_log = getExtensionPathOf("debug.log");
    if (fs.existsSync(debug_log)) {
      vscode.window.showTextDocument(vscode.Uri.parse(debug_log), { viewColumn: 1 });
      vscode.window.showTextDocument(vscode.Uri.parse(getExtensionPathOf("error.log")), { viewColumn: 2 });
      vscode.window.showTextDocument(vscode.Uri.parse(getExtensionPathOf("performance_time.log")), {
        viewColumn: 3,
      });
    } else {
      vscode.window.showInformationMessage("No logs have yet been created");
    }
  });

  const getPid_ = registerCommand("midas.getPid", getPid);
  const getRR_ = registerCommand("midas.get-rr", getRR);

  const showReleaseNotes_ = registerCommand("midas.show-release-notes", showReleaseNotes);

  return [
    rrRecord,
    continueAll,
    pauseAll,
    reverseFinish,
    hotReloadScripts,
    displayLogs,
    issueGithubReport,
    getPid_,
    getRR_,
    showReleaseNotes_,
    toggleHexFormatting,
    runToEvent,
    zenWorkaround
  ];
}

module.exports = {
  getVSCodeCommands,
};
