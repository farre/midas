const vscode = require("vscode");
const { MidasDebugSession } = require("../debugSession");
const fs = require("fs");

const { getFreeRandomPort } = require("../utils/netutils");
const { tracePicked, getTraces, parseProgram } = require("../utils/rrutils");
const { ConfigurationProviderInitializer, InitExceptionTypes } = require("./initializer");
const {
  spawnExternalRrConsole,
  showErrorPopup,
  ContextKeys,
  getAPI
} = require("../utils/utils");
const krnl = require("../utils/kernelsettings");
const { RRSpawnConfig } = require("../spawn");

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
    config.gdbPath = await getAPI().resolve_tool_path("gdb");
    if(config.gdbPath == undefined) {
      throw { type: InitExceptionTypes.GdbNotFound };
    }
  }
  if (!config.hasOwnProperty("rrPath")) {
    config.rrPath = await getAPI().resolve_tool_path("rr");
    if(config.rrPath == undefined) {
      throw { type: InitExceptionTypes.RRNotFound }
    }
  }
  if (!config.hasOwnProperty("setupCommands")) {
    config.setupCommands = [];
  }
  const perf_event_paranoid = krnl.readPerfEventParanoid();
  if (perf_event_paranoid > 1) {
    let choice = await showErrorPopup(
      "perf_event_paranoid not set to <= 1.",
      "rr needs it to be set to 1 to be performant.",
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
    config.IsThisTheSubstituded = "Yes";
    if (!fs.existsSync(config.rrPath)) {
      throw new Error(`No RR found at ${config.rrPath}`);
    }
    if (!config.serverAddress) {
      try {
        let port = await getFreeRandomPort();
        config.serverAddress = `127.0.0.1:${port}`;
      } catch (err) {
        throw new Error("No port available for rr to listen on");
      }
    }

    if (config.traceWorkspace && !config.replay.pid) {
      config = await tracePicked(config.rrPath, config.traceWorkspace).then((replay_parameters) => {
        if (replay_parameters) {
          config.replay.parameters = replay_parameters;
          return config;
        } else {
          throw new Error("You did not pick a trace.");
        }
      });
    } else if (!config.traceWorkspace && !config.replay) {
      const options = {
        canPickMany: false,
        ignoreFocusOut: true,
        title: "Select process to debug",
      };
      const traces = await getTraces(config.rrPath);
      const ws = await vscode.window.showQuickPick(traces, options);
      const replay_parameters = await tracePicked(config.rrPath, ws);
      if (replay_parameters) {
        try {
          config.program = parseProgram(replay_parameters.cmd);
        } catch (e) {
          throw new Error("Could not parse binary");
        }
        config.replay = replay_parameters;
        return config;
      } else {
        throw new Error("You did not pick a trace.");
      }
    }
    vscode.commands.executeCommand("setContext", ContextKeys.RRSession, true);
    return config;
  }

  async resolveDebugConfiguration(folder, config, token) {
    try {
      await super.defaultInitialize(config, initializer);
    } catch (err) {
      switch(err.type) {
        case InitExceptionTypes.GdbNotFound:
          vscode.window.showErrorMessage("GDB not found in $PATH and no user setting found (Preferences->Settings->Midas->gdb).");
          break;
        case InitExceptionTypes.RRNotFound:
          // eslint-disable-next-line max-len
          vscode.window.showErrorMessage("RR not found in $PATH and no user setting found (Preferences->Settings->Midas->gdb). Use Midas:getRR command or install RR on your system");
          break;
        case InitExceptionTypes.GdbVersionUnknown:
          showErrorPopup("Incompatible GDB version", err.message, [
            {
              title: "Download GDB source",
              action: async () => {
                await vscode.env.openExternal(vscode.Uri.parse("https://www.sourceware.org/gdb/current/"));
              },
            },
          ]).then((choice) => {
            if (choice) choice.action();
          });
          break;
        default:
          break;
      }
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
  #checkpointsUI;
  constructor(checkpointsUI) {
    this.#checkpointsUI = checkpointsUI;
  }
  /**
   * @param { vscode.DebugSession } session
   * @returns ProviderResult<vscode.DebugAdapterDescriptor>
   */
  async createDebugAdapterDescriptor(session) {
    const config = session.configuration;
    const pid = config.replay.pid;
    const traceWorkspace = config.replay.traceWorkspace;
    let [addr, port] = config.serverAddress.split(":");
    // turns out, gdb doesn't recognize "localhost" as a parameter, at least on my machine.
    addr = addr == "localhost" ? "127.0.0.1" : addr;
    const cmd_str = `${config.rrPath} replay -h ${addr} -s ${port} -p ${pid} -k ${traceWorkspace}`;
    vscode.commands.executeCommand("setContext", ContextKeys.DebugType, config.type);
    if (config.externalConsole) {
      const rrArgs = { path: config.rrPath, addr, port, pid, traceWorkspace };
      try {
        let terminalInterface = await spawnExternalRrConsole(
          { terminal: config.externalConsole.path, closeOnExit: config.externalConsole.closeTerminalOnEndOfSession },
          rrArgs
        );
        let dbg_session = new MidasDebugSession(
          true,
          false,
          fs,
          new RRSpawnConfig(config),
          terminalInterface,
          this.#checkpointsUI
        );
        return new vscode.DebugAdapterInlineImplementation(dbg_session);
      } catch (err) {
        showErrorPopup("Failed to spawn external console");
        return undefined;
      }
    } else {
      let terminalInterface = vscode.window.createTerminal("rr terminal");
      terminalInterface.sendText(cmd_str);
      terminalInterface.show(true);
      let dbg_session = new MidasDebugSession(
        true,
        false,
        fs,
        new RRSpawnConfig(config),
        terminalInterface,
        this.#checkpointsUI
      );
      return new vscode.DebugAdapterInlineImplementation(dbg_session);
    }
  }
}

module.exports = {
  RRConfigurationProvider,
  RRDebugAdapterFactory,
};