const vscode = require("vscode");
const { DebugSession } = require("./debugSession");
const path = require("path");
const subprocess = require("child_process");

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

    if (config.hasOwnProperty("rrServerAddress")) {
      // midas with rr
      if (!(config.allStopMode ?? true)) {
        vscode.window.showErrorMessage(
          "rr can not run in non-stop mode. Remove the setting from the launch config (defaults it) or set it to true"
        );
        return null;
      }
      if (!config.rrPath) {
        config.rrPath = "rr";
      }
    } else {
      // midas without rr
    }

    setDefaults(config);

    if (!config.program) {
      await vscode.window.showInformationMessage("Cannot find a program to debug");
      return null;
    }

    vscode.commands.executeCommand("setContext", "midas.allStopModeSet", config.allStopMode);
    return config;
  }

  // for now, we do not substitute any variables in the launch config, but we will. this will be used then.
  async resolveDebugConfigurationWithSubstitutedVariables(folder, debugConfiguration, token) {
    return debugConfiguration;
  }
}

class DebugAdapterFactory {
  /**
   *
   * @param { vscode.DebugSession } session
   * @returns ProviderResult<vscode.DebugAdapterDescriptor>
   */
  async createDebugAdapterDescriptor(session) {
    if (session.configuration.hasOwnProperty("rrServerAddress")) {
      let miServerAddress = session.configuration.rrServerAddress;
      let rrPath = session.configuration.rrPath;
      let term;
      const options = {
        canPickMany: false,
        ignoreFocusOut: true,
        title: "Select process to debug",
      };

      const tracePicked = async (tracePath) => {
        return await vscode.window.showQuickPick(getTraceInfo(tracePath), options).then((selection) => {
          if (selection) {
            const addr = miServerAddress.split(":");
            const port = addr[1];
            const cmd_str = `${rrPath} replay -s ${port} -p ${selection.value} -k ${tracePath}`;
            term = vscode.window.createTerminal("rr terminal");
            vscode.window.createTerminal();
            term.sendText(cmd_str);
            term.show(true);
            return true;
          }
          return false;
        });
      };
      return await vscode.window
        .showQuickPick(getTraces(), options)
        .then(tracePicked)
        .then((success) => {
          if (success) {
            let dbg_session = new DebugSession(true);
            dbg_session.registerTerminal(term);
            return new vscode.DebugAdapterInlineImplementation(dbg_session);
          } else {
            vscode.window.showErrorMessage("You did not pick a trace.");
            return null;
          }
        });
    } else {
      let dbg_session = new DebugSession(true);
      return new vscode.DebugAdapterInlineImplementation(dbg_session);
    }
  }
}

module.exports = {
  ConfigurationProvider,
  DebugAdapterFactory,
};
