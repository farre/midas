const vscode = require("vscode");
const { MidasDebugSession } = require("../debugSession");
const fs = require("fs");

const { getFreeRandomPort } = require("../netutils");
const { tracePicked, getTraces, parseProgram } = require("../rrutils");
const { ConfigurationProviderInitializer } = require("./initializer");
const { MidasRunMode } = require("../buildMode");
const { spawnExternalRrConsole, showErrorPopup, ContextKeys } = require("../utils");
const krnl = require("../kernelsettings");

const initializerPopupChoices = {
  perf_event_paranoid: [
    {
      title: "Read more...",
      action: async () => {
        await vscode.env.openExternal(vscode.Uri.parse("https://www.dedoimedo.com/computers/rr-gdb-tool.html"));
      },
    },
  ],
};

const initializer = async (config) => {
  if (!config.hasOwnProperty("trace")) {
    config.trace = "off";
  }
  if (!config.hasOwnProperty("gdbPath")) {
    config.gdbPath = "gdb";
  }
  if (!config.hasOwnProperty("rrPath")) {
    config.rrPath = "rr";
  }
  if (!config.hasOwnProperty("setupCommands")) {
    config.setupCommands = [];
  }
  const perf_event_paranoid = krnl.readPerfEventParanoid();
  if (perf_event_paranoid > 0) {
    let choice = await showErrorPopup(
      "perf_event_paranoid not set to 0.",
      "rr requires it to be set to 0",
      initializerPopupChoices.perf_event_paranoid
    );
    if (choice) await choice.action();
    throw new Error("Canceled");
  }
};

class RRConfigurationProvider extends ConfigurationProviderInitializer {
  get type() {
    return "midas-rr";
  }

  async resolveReplayConfig(folder, config, token) {
    if (!config.serverAddress) {
      try {
        let port = await getFreeRandomPort();
        config.serverAddress = `127.0.0.1:${port}`;
      } catch (err) {
        showErrorPopup("No port available for rr to listen on");
        return null;
      }
    }

    if (config.traceWorkspace && !config.replay.pid) {
      config = await tracePicked(config.traceWorkspace).then((replay_parameters) => {
        if (replay_parameters) {
          config.replay.parameters = replay_parameters;
          return config;
        } else {
          showErrorPopup("You did not pick a trace.");
          return null;
        }
      });
    } else if (!config.traceWorkspace && !config.replay) {
      const options = {
        canPickMany: false,
        ignoreFocusOut: true,
        title: "Select process to debug",
      };
      config = await vscode.window
        .showQuickPick(getTraces(), options)
        .then(tracePicked)
        .then((replay_parameters) => {
          if (replay_parameters) {
            try {
              config.program = parseProgram(replay_parameters.cmd);
            } catch (e) {
              showErrorPopup("Could not parse binary");
              return null;
            }
            config.replay = replay_parameters;
            return config;
          } else {
            showErrorPopup("You did not pick a trace.");
            return null;
          }
        });
    }
    vscode.commands.executeCommand("setContext", ContextKeys.RRSession, true);
    return config;
  }

  async resolveDebugConfiguration(folder, config, token) {
    try {
      await super.defaultInitialize(config, initializer);
    } catch (err) {
      await vscode.window.showErrorMessage(err.message);
      return null;
    }
    return await this.resolveReplayConfig(folder, config, token);
  }

  // for now, we do not substitute any variables in the launch config, but we will. this will be used then.
  async resolveDebugConfigurationWithSubstitutedVariables(folder, debugConfiguration, token) {
    return debugConfiguration;
  }
}

class RRDebugAdapterFactory {
  /**
   * @param { vscode.DebugSession } session
   * @returns ProviderResult<vscode.DebugAdapterDescriptor>
   */
  async createDebugAdapterDescriptor(session) {
    const config = session.configuration;
    const rrPath = config.rrPath;
    const pid = config.replay.pid;
    const traceWorkspace = config.replay.traceWorkspace;
    let [addr, port] = config.serverAddress.split(":");
    // turns out, gdb doesn't recognize "localhost" as a parameter, at least on my machine.
    addr = addr == "localhost" ? "127.0.0.1" : addr;
    const cmd_str = `${rrPath} replay -h ${addr} -s ${port} -p ${pid} -k ${traceWorkspace}`;
    vscode.commands.executeCommand("setContext", ContextKeys.DebugType, config.type);
    if (config.externalConsole) {
      const rrArgs = { path: rrPath, addr, port, pid, traceWorkspace };
      try {
        let terminalInterface = await spawnExternalRrConsole({ terminal: config.externalConsole.path }, rrArgs);
        let dbg_session = new MidasDebugSession(true, false, fs, new MidasRunMode(config), terminalInterface);
        return new vscode.DebugAdapterInlineImplementation(dbg_session);
      } catch (err) {
        showErrorPopup("Failed to spawn external console");
        return undefined;
      }
    } else {
      let term = vscode.window.createTerminal("rr terminal");
      term.sendText(cmd_str);
      term.show(true);
      let dbg_session = new MidasDebugSession(true, false, fs, new MidasRunMode(config), term);
      return new vscode.DebugAdapterInlineImplementation(dbg_session);
    }
  }
}

module.exports = {
  RRConfigurationProvider,
  RRDebugAdapterFactory,
};
