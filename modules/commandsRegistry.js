"use strict";
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { getPid, getVersion, isNothing, showReleaseNotes, getAPI } = require("./utils/utils");
const { getExtensionPathOf } = require("./utils/sysutils");
/**
 * @typedef { import("vscode").Disposable } Disposable
 */
const vscode = require("vscode");
const { CustomRequests, ProvidedAdapterTypes } = require("./constants");
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
      switch (cfg.type ?? "") {
        case ProvidedAdapterTypes.Gdb:
        case ProvidedAdapterTypes.RR:
        case ProvidedAdapterTypes.Native:
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

  const continueAll = registerCommand("midas.continueAll", async (uiElementId) => {
    if (uiElementId) {
      if (uiElementId == vscode.debug.activeDebugSession.id) {
        return vscode.debug.activeDebugSession.customRequest(CustomRequests.ContinueAll, {});
      }

      for (const session of getAPI().GetDebugSessions().values()) {
        const hasThread = await session.ManagesThread(uiElementId);
        if (hasThread) {
          return session.ContinueAll();
        }
      }
    } else {
      vscode.debug.activeDebugSession.customRequest(CustomRequests.ContinueAll, {});
    }
  });

  const pauseAll = registerCommand("midas.pauseAll", async (uiElementId) => {
    if (uiElementId) {
      if (uiElementId == vscode.debug.activeDebugSession.id) {
        vscode.debug.activeDebugSession.customRequest(CustomRequests.PauseAll);
        return;
      }

      const map = getAPI().GetDebugSessions();
      for (const v of map.values()) {
        if (v.CompareId(uiElementId) || await v.ManagesThread(uiElementId)) {
          return v.PauseAll();
        }
      }
    } else {
      // request came via the debug toolbar which is the active session
      vscode.debug.activeDebugSession.customRequest(CustomRequests.PauseAll);
    }
  });

  let reverseFinish = registerCommand("midas.reverse-finish", () => {
    vscode.debug.activeDebugSession.customRequest(CustomRequests.ReverseFinish);
  });

  let toggleHexFormatting = registerCommand("midas.toggle-hex-formatting", (/** item */) => {
    vscode.debug.activeDebugSession.customRequest("toggle-hex");
  });

  const zenWorkaround = registerCommand("midas.zen-workaround", async (/** item */) => {
    const rrSourceDir = getAPI().getToolchain().getTool("rr").sourceDirectory;
    const script = path.join(rrSourceDir, "scripts", "zen_workaround.py");
    if (fs.existsSync(script)) {
      try {
        await getAPI().getPython().sudoExecute([script]);
        vscode.window.showInformationMessage("Zen Workaround is active");
      } catch (ex) {
        vscode.window.showInformationMessage("Zen Workaround failed");
      }
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

  const ToolInstaller = async (name) => {
    const mgr = getAPI().getToolchain();
    const tool = mgr.getTool(name);
    mgr.installDependencies(tool).then(async (wasNotCancelled) => {
      if (wasNotCancelled) {
        await tool.beginInstallerUI()
      } else {
        vscode.window.showInformationMessage("Install cancelled.");
      }
    });
  };

  const getPid_ = registerCommand("midas.getPid", getPid);
  const getRR_ = registerCommand("midas.get-rr", async () => {
    try {
      await ToolInstaller("rr");
    } catch (ex) {
      vscode.window.showErrorMessage(`RR install failed: ${ex}`);
    }
  });
  const getMdb = registerCommand("midas.get-mdb", async () => {
    try {
      await ToolInstaller("mdb");
    } catch (ex) {
      vscode.window.showErrorMessage(`MDB install failed: ${ex}`);
    }
  });

  const getGdb = registerCommand("midas.get-gdb", async () => {
    try {
      await ToolInstaller("gdb");
    } catch (ex) {
      vscode.window.showErrorMessage(`GNU Debugger install failed: ${ex}`);
    }
  });

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
    getMdb,
    getGdb,
    showReleaseNotes_,
    toggleHexFormatting,
    runToEvent,
    zenWorkaround
  ];
}

module.exports = {
  getVSCodeCommands,
};
