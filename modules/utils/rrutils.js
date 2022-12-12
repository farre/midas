const vscode = require("vscode");
const path = require("path");
const subprocess = require("child_process");
const { REGEXES, getCacheManager } = require("./utils");

/**
 * @returns { Thenable<string[]> }
 */
async function getTraces() {
  let cacheManager = await getCacheManager();
  const { path } = cacheManager.rr;

  return new Promise((resolve, reject) => {
    subprocess.exec(`${path} ls -l -t -r`, (err, stdout, stderr) => {
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

function* get_field(line) {
  let it = 0;
  let end = 0;
  let parts_generated = 0;
  while (it < line.length) {
    if (parts_generated < 3) {
      while (REGEXES.WhiteSpace.test(line.charAt(it))) it++;
      end = it;
      while (!REGEXES.WhiteSpace.test(line.charAt(end))) end++;
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

/**
 * @param { string } data
 * @returns { { pid: string, ppid: string, exit: string, cmd: string }[] }
 */
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

/** @type {(trace: string) => Promise<readonly (vscode.QuickPickItem & {value: string})[]>} */
async function getTraceInfo(trace) {
  const cacheManager = await getCacheManager();
  return new Promise((resolve, reject) => {
    subprocess.exec(`${cacheManager.rr.path} ps ${trace}`, (error, stdout, stderr) => {
      if (error) {
        reject(stderr);
      } else {
        const json = fallbackParseOfrrps(stdout);
        resolve(json);
      }
    });
  }).then((picks) => {
    return picks.map(({ pid, ppid, exit, cmd }, index) => {
      let binary = cmd.trim();
      try {
        // if forked, RR doesn't provide us with a binary, scan backwards in list to find forked-from process
        if (cmd.includes("forked without exec")) {
          for (let findBinaryIndex = index - 1; findBinaryIndex >= 0; findBinaryIndex--) {
            if (!picks[findBinaryIndex].cmd.includes("forked without exec")) {
              binary = picks[findBinaryIndex].cmd;
            }
          }
        }
      } catch (ex) {
        console.log(`Failed to prepare RR replay parameters: ${ex}`);
        throw new Error(`Failed to prepare RR replay parameters`);
      }
      return {
        value: pid,
        label: `${path.basename(cmd.split(" ")[0] ?? cmd)}`,
        description: `PID: ${pid}, PPID: ${ppid === "--" ? "--" : +ppid}, EXIT: ${exit}`,
        detail: cmd.trim(),
        binary,
      };
    });
  });
}

function initDefaults(config) {
  if (!config.hasOwnProperty("stopOnEntry")) {
    config.stopOnEntry = false;
  }
  if (!config.hasOwnProperty("trace")) {
    config.trace = false;
  }
  if (!config.hasOwnProperty("allStopMode")) {
    config.allStopMode = true;
  }
  if (!config.hasOwnProperty("gdbPath")) {
    config.gdbPath = "gdb";
  }
  if (!config.hasOwnProperty("setupCommands")) {
    config.setupCommands = [];
  }
}

/**
 * Parse the required launch config `program` field from the field `cmd` of the `rr ps` result
 * @param {string} rr_ps_output_cmd - the `cmd` field returned from `tracePicked`
 * @returns {string} - path to binary to debug
 * @throws Throws an exception if a file can't be parsed from `rr_ps_output_cmd`
 */
function parseProgram(rr_ps_output_cmd) {
  return rr_ps_output_cmd.split(" ")[0];
}

const tracePicked = async (traceWorkspace) => {
  const options = {
    canPickMany: false,
    ignoreFocusOut: true,
    title: "Select process to debug",
  };
  return await vscode.window.showQuickPick(getTraceInfo(traceWorkspace), options).then((selection) => {
    if (selection) {
      const replay_parameters = { pid: selection.value, traceWorkspace: traceWorkspace, cmd: selection.binary };
      return replay_parameters;
    }
    return null;
  });
};

module.exports = {
  tracePicked,
  getTraces,
  parseProgram,
  initDefaults,
};
