const vscode = require("vscode");
const fs = require("fs");

const { getFreeRandomPort } = require("../utils/netutils");
const { tracePicked, getTraces, parseProgram, generateGdbInit } = require("../utils/rrutils");
const { ConfigurationProviderInitializer, InitExceptionTypes, gdbSettingsOk } = require("./initializer");
const { spawnExternalRrConsole, showErrorPopup, getAPI } = require("../utils/utils");
const krnl = require("../utils/kernelsettings");
const { RRSpawnConfig } = require("../spawn");
const { GdbDAPSession } = require("../dap/gdb");
const { getExtensionPathOf } = require("../utils/sysutils");

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
  config.tool = {};
  const API = await getAPI();
  if (!config.hasOwnProperty("trace")) {
    config.trace = "off";
  }
  if (!config.hasOwnProperty("gdbPath")) {
    const tool = await API.getDebuggerTool("gdb").catch(() => {
      throw { type: InitExceptionTypes.GdbNotFound };
    });
    config.gdbPath = tool.path;
    config.gdbOptions = tool.spawnArgs;
  }
  await gdbSettingsOk(config);
  if (!config.hasOwnProperty("rrPath")) {
    const tool = await API.getDebuggerTool("rr").catch(() => {
      throw { type: InitExceptionTypes.RRNotFound };
    });
    config.rrPath = tool.path;
  }

  if (!config.hasOwnProperty("setupCommands")) {
    config.setupCommands = [];
  }

  const perf_event_paranoid = krnl.readPerfEventParanoid();
  if (perf_event_paranoid > 1) {
    let choice = await showErrorPopup(
      "perf_event_paranoid not set to <= 1.",
      "rr needs it to be set to 1 to be performant.",
      initializerPopupChoices.perf_event_paranoid,
    );
    if (choice) await choice.action();
    throw new Error("Canceled");
  }
};

async function setServerAddress() {
  try {
    const port = await getFreeRandomPort();
    const serverAddress = `127.0.0.1:${port}`;
    return serverAddress;
  } catch (err) {
    throw new Error("No port available for rr to listen on");
  }
}

function getAddrSetting(config) {
  if (config.target === null) throw new Error("No RR server address was set or configured");
  const [addr, port] = config.target.parameter.split(":");
  return { address: addr == "localhost" ? "127.0.0.1" : addr, port: port };
}

class RRConfigurationProvider extends ConfigurationProviderInitializer {
  get type() {
    return "midas-rr";
  }

  async resolveReplayConfig(folder, config, token) {
    config.IsThisTheSubstituded = "Yes";
    if (!fs.existsSync(config.rrPath)) {
      throw new Error(`No RR found at ${config.rrPath}`);
    }
    config.target = {
      type: "extended-remote",
      parameter: await setServerAddress(),
    };

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
    return config;
  }

  async resolveDebugConfiguration(folder, config, token) {
    return config;
  }

  // for now, we do not substitute any variables in the launch config, but we will. this will be used then.
  async resolveDebugConfigurationWithSubstitutedVariables(folder, config, token) {
    getAPI().clearChannelOutputs();
    try {
      await super.defaultInitialize(config, initializer);
    } catch (err) {
      switch (err.type) {
        case InitExceptionTypes.GdbNotFound:
          vscode.window.showErrorMessage(
            "GDB not found in $PATH and no user setting found (Preferences->Settings->Midas->gdb).",
          );
          break;
        case InitExceptionTypes.RRNotFound:
          // eslint-disable-next-line max-len
          vscode.window.showErrorMessage(
            "RR not found in $PATH and no user setting found (Preferences->Settings->Midas->gdb). Use Midas:getRR command or install RR on your system",
          );
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

    if (config.remoteTargetConfig != null) {
      return config;
    } else {
      let result = await this.resolveReplayConfig(folder, config, token);
      return result;
    }
  }
}

class RRDebugAdapterFactory {
  #cp_ui;
  constructor(checkpointsUI) {
    this.#cp_ui = checkpointsUI;
  }
  /**
   * @param { vscode.DebugSession } session
   * @returns ProviderResult<vscode.DebugAdapterDescriptor>
   */
  async createDebugAdapterDescriptor(session) {
    const config = session.configuration;
    const pid = config.replay.pid;
    const traceWorkspace = config.replay.traceWorkspace;
    const { address, port } = getAddrSetting(config);
    const rrInitData = await generateGdbInit(config.rrPath);
    const rrInitFilePath = getExtensionPathOf("rrinit");
    fs.writeFileSync(rrInitFilePath, rrInitData);
    let cmd_str = null;
    const rrOptions = (config.rrOptions ?? []).join(" ");
    if (config.replay.noexec) {
      cmd_str = `${config.rrPath} replay -h ${address} -s ${port} -f ${pid} -k ${rrOptions} ${traceWorkspace}`;
    } else {
      cmd_str = `${config.rrPath} replay -h ${address} -s ${port} -p ${pid} -k ${rrOptions} ${traceWorkspace}`;
    }

    if (config.externalConsole) {
      const rrArgs = { path: config.rrPath, address, port, pid, traceWorkspace };
      try {
        let terminalInterface = await spawnExternalRrConsole(
          { terminal: config.externalConsole.path, closeOnExit: config.externalConsole.closeTerminalOnEndOfSession },
          rrArgs,
        );
        let session = new GdbDAPSession(new RRSpawnConfig(config), terminalInterface, this.#cp_ui);
        return new vscode.DebugAdapterInlineImplementation(session);
      } catch (err) {
        showErrorPopup("Failed to spawn external console");
        return undefined;
      }
    } else {
      let term = vscode.window.createTerminal("rr terminal");
      term.sendText(cmd_str);
      term.show(true);
      let dbg_session = new GdbDAPSession(new RRSpawnConfig(config), term, this.#cp_ui);
      return new vscode.DebugAdapterInlineImplementation(dbg_session);
    }
  }
}

module.exports = {
  RRConfigurationProvider,
  RRDebugAdapterFactory,
};
