const vscode = require("vscode");
const { MidasDebugSession } = require("../debugSession");
const fs = require("fs");

const {getFreeRandomPort} = require("../netutils");
const {tracePicked, getTraces, parseProgram } = require("../rrutils");
const { ConfigurationProviderInitializer } = require("./initializer");
const { MidasRunMode } = require("../buildMode");

const initializer = (config) => {
  if (!config.hasOwnProperty("trace")) {
    config.trace = "off";
  }
  if (!config.hasOwnProperty("gdbPath")) {
    config.gdbPath = "gdb";
  }
  if(!config.hasOwnProperty("rrPath")) {
    config.rrPath = "rr";
  }
  if(!config.hasOwnProperty("setupCommands")) {
    config.setupCommands = [];
  }
}

class RRConfigurationProvider extends ConfigurationProviderInitializer {

  get type() {
    return "midas-rr";
  }

  async resolveReplayConfig(folder, config, token) {
    if(!config.serverAddress) {
      try {
        let port = await getFreeRandomPort();
        config.serverAddress = `127.0.0.1:${port}`;
      } catch(err) {
        vscode.window.showErrorMessage("No port available for rr to listen on");
        return null;
      }
    }
  
    if (config.replay.traceWorkspace && !config.replay.pid) {
      config = await tracePicked(config.replay.traceWorkspace).then((replay_parameters) => {
        if (replay_parameters) {
          config.replay.parameters = replay_parameters;
          return config;
        } else {
          vscode.window.showErrorMessage("You did not pick a trace.");
          return null;
        }
      });
    } else if (!config.replay.traceWorkspace && !config.replay.pid) {
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
              config.program = parseProgram(replay_parameters.cmd)
            } catch(e) {
              vscode.window.showErrorMessage("Could not parse binary");
              return null;
            }
            config.replay.parameters = replay_parameters;
            return config;
          } else {
            vscode.window.showErrorMessage("You did not pick a trace.");
            return null;
          }
        });
    }
    vscode.commands.executeCommand("setContext", "midas.rrSession", true);
    return config;
  }

  async resolveDebugConfiguration(folder, config, token) {
    try {
      super.defaultInitialize(config, initializer);
    } catch(err) {
      await vscode.window.showErrorMessage(err.message);
    }
    return this.resolveReplayConfig(folder, config, token);
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
    const rrPath = config.replay.rrPath;
    const pid = config.replay.parameters.pid;
    const traceWorkspace = config.replay.parameters.traceWorkspace;
    const inet_addr = config.serverAddress;
    // turns out, gdb doesn't recognize "localhost" as a parameter, at least on my machine.
    const addr = inet_addr[0] == "localhost" ? "127.0.0.1" : inet_addr[0];
    const port = inet_addr[1];
    const cmd_str = `${rrPath} replay -h ${addr} -s ${port} -p ${pid} -k ${traceWorkspace}`;
    let term = vscode.window.createTerminal("rr terminal");
    term.sendText(cmd_str);
    term.show(true);
    let dbg_session = new MidasDebugSession(true, false, fs, new MidasRunMode(config));
    dbg_session.registerTerminal(term);
    return new vscode.DebugAdapterInlineImplementation(dbg_session);
  }
}

module.exports = {
  RRConfigurationProvider,
  RRDebugAdapterFactory
}