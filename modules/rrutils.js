const vscode = require("vscode");
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
  if(!config.hasOwnProperty("setupCommands")) {
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
  let splits = rr_ps_output_cmd.split(" ");
  let prog = splits[splits.length-1];
  if(prog.includes("/")) {
    const tmp = prog.split("/");
    prog = tmp[tmp.length - 1];
    return prog;
  }
  return prog;
}
  
const tracePicked = async (traceWorkspace) => {
  const options = {
    canPickMany: false,
    ignoreFocusOut: true,
    title: "Select process to debug",
  };
  return await vscode.window.showQuickPick(getTraceInfo(traceWorkspace), options).then((selection) => {
    if (selection) {
      const replay_parameters = { pid: selection.value, traceWorkspace: traceWorkspace, cmd: selection.detail };
      return replay_parameters;
    }
    return null;
  });
};

module.exports = {
  tracePicked,
  getTraces,
  parseProgram,
  initDefaults
}