const vscode = require("vscode");
const { MidasDebugSession } = require("./debugSession");
const path = require("path");
const subprocess = require("child_process");
const { isReplaySession } = require("./utils");

/**
 * @returns { Thenable<string[]> }
 */
function getTraces() {
  return new Promise((resolve, reject) => {
    subprocess.exec(`rr ls -l -t -r`, (err, stdout, stderr) => {
      if (err) {
        reject(stderr);
      } else {
        let lines = stdout.split("\n").splice(1);
        const traces = lines.map((line) => line.split(" ")[0].trim()).filter((trace) => trace.length > 0);
        resolve(traces);
      }
    });
  });
}
const WHITESPACE_REGEX = /\s/;
function* get_field(line) {
  let it = 0;
  let end = 0;
  let parts_generated = 0;
  while (it < line.length) {
    if (parts_generated < 3) {
      while (WHITESPACE_REGEX.test(line.charAt(it))) it++;
      end = it;
      while (!WHITESPACE_REGEX.test(line.charAt(end))) end++;
      const res = line.substring(it, end).trim();
      it = end;
      parts_generated++;
      yield res;
    } else {
      const r = line.substring(it).trim();
      it = line.length;
      yield r;
    }
  }
  return null;
}

function fallbackParseOfrrps(data) {
  return data
    .split("\n")
    .slice(1)
    .filter((line) => line.length > 2)
    .map((line) => {
      const [pid, ppid, exit, cmd] = [...get_field(line)];
      return { pid, ppid, exit, cmd };
    });
}

/** @type {(trace: string) => Thenable<readonly (vscode.QuickPickItem & {value: string})[]>} */
function getTraceInfo(trace) {
  const prefix = `'BEGIN { OFS = ","; printf "["; sep="" } NR!=1`;
  const suffix = `END { print "]" }`;

  const json = `\\"pid\\": %d,\\"ppid\\": \\"%s\\",\\"exit\\": \\"%d\\",\\"cmd\\": \\"%s\\"`;
  const rrps = `rr ps ${trace} | awk ${prefix} { printf "%s{ ${json} }",sep,$1,$2,$3,substr($0, index($0, $4));sep=","} ${suffix}'`;

  return new Promise((resolve, reject) => {
    subprocess.exec(`rr ps ${trace}`, (error, stdout, stderr) => {
      if (error) {
        reject(stderr);
      } else {
        const json = fallbackParseOfrrps(stdout);
        resolve(json);
      }
    });
  }).then((picks) =>
    picks.map(({ pid, ppid, exit, cmd }) => {
      return {
        value: pid,
        label: `${path.basename(cmd.split(" ")[0] ?? cmd)}`,
        description: `PID: ${pid}, PPID: ${ppid === "--" ? "--" : +ppid}, EXIT: ${exit}`,
        detail: cmd,
      };
    })
  );
}

function setDefaults(config) {
  if (!config.hasOwnProperty("stopOnEntry")) {
    config.stopOnEntry = false;
  }
  if (!config.hasOwnProperty("trace")) {
    config.trace = false;
  }
  if (!config.hasOwnProperty("allStopMode")) {
    config.allStopMode = true;
  }
  if (!config.hasOwnProperty("debuggerPath")) {
    config.debuggerPath = "gdb";
  }
}

class ConfigurationProvider {
  // eslint-disable-next-line no-unused-vars
  async resolveDebugConfiguration(folder, config, token) {
    // if launch.json is missing or empty
    if (!config || !config.type || config.type == undefined) {
      await vscode.window.showErrorMessage("Cannot start debugging because no launcdh configuration has been provided.");
      return null;
    }
    setDefaults(config);
    if (!config.program) {
      await vscode.window.showErrorMessage("A path to the binary to debug is missing in the launch settings");
      return null;
    }

    if(config.mode == "rr") {
      if(!config.replay) {
        await vscode.window.showErrorMessage("You need to set replay settings rrPath and rrServerAddress");
        return null;
      }
      const options = {
        canPickMany: false,
        ignoreFocusOut: true,
        title: "Select process to debug",
      };
      const tracePicked = async (traceWorkspace) => {
        return await vscode.window.showQuickPick(getTraceInfo(traceWorkspace), options).then((selection) => {
          if (selection) {
            const replay_parameters = { pid: selection.value, traceWorkspace: traceWorkspace, cmd: selection.detail };
            return replay_parameters;
          }
          return null;
        });
      };
      
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
        config = await vscode.window
          .showQuickPick(getTraces(), options)
          .then(tracePicked)
          .then((replay_parameters) => {
            if (replay_parameters) {
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
    } else if(config.mode == "gdb") {
    // without rr
      if (!config.program) {
        await vscode.window.showInformationMessage("Cannot find a program to debug");
        return null;
      }
      vscode.commands.executeCommand("setContext", "midas.allStopModeSet", config.allStopMode);
      vscode.commands.executeCommand("setContext", "midas.rrSession", false);
      return config;
    } else {
      vscode.window.showErrorMessage("You have not set mode. Supported values: 'rr' or 'gdb'");
      return null;
    }
  }

  // for now, we do not substitute any variables in the launch config, but we will. this will be used then.
  async resolveDebugConfigurationWithSubstitutedVariables(folder, debugConfiguration, token) {
    return debugConfiguration;
  }
}

class DebugAdapterFactory {
  /**
   * @param { vscode.DebugSession } session
   * @returns ProviderResult<vscode.DebugAdapterDescriptor>
   */
  async createDebugAdapterDescriptor(session) {
    if(session.configuration.mode == "rr") {
      let miServerAddress = session.configuration.replay.rrServerAddress;
      const rrPath = session.configuration.replay.rrPath;
      const pid = session.configuration.replay.parameters.pid;
      const traceWorkspace = session.configuration.replay.parameters.traceWorkspace;
      const inet_addr = miServerAddress.split(":");
      // turns out, gdb doesn't recognize "localhost" as a parameter, at least on my machine.
      const addr = inet_addr[0] == "localhost" ? "127.0.0.1" : inet_addr[0];
      const port = inet_addr[1];
      const cmd_str = `${rrPath} replay -h ${addr} -s ${port} -p ${pid} -k ${traceWorkspace}`;
      let term = vscode.window.createTerminal("rr terminal");
      term.sendText(cmd_str);
      term.show(true);
      let dbg_session = new MidasDebugSession(true);
      dbg_session.registerTerminal(term);
      return new vscode.DebugAdapterInlineImplementation(dbg_session);
    } else {
      let dbg_session = new MidasDebugSession(true);
      return new vscode.DebugAdapterInlineImplementation(dbg_session);
    }
  }
}

module.exports = {
  ConfigurationProvider,
  DebugAdapterFactory
};
