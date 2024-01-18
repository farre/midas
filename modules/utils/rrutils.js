const vscode = require("vscode");
const path = require("path");
const subprocess = require("child_process");
const { REGEXES } = require("./utils");

/**
 * @param { string } rr - Path to rr
 * @returns { Promise<string[]> }
 */
async function getTraces(rr) {
  return new Promise((resolve, reject) => {
    subprocess.exec(`${rr} ls -l -t -r`, (err, stdout, stderr) => {
      if (err) {
        reject(stderr);
      } else {
        let lines = stdout.split("\n").splice(1);
        const traces = lines.map((line) => line.split(" ")[0].trim()).filter((trace) => trace.length > 0 && trace != "cpu_lock");
        if(traces.length == 1 && traces[0] == "latest-trace") {
          reject(`No traces found by rr ps command`);
        } else {
          resolve(traces);
        }
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
 * @returns { { pid: string, ppid: string, exit: string, cmd: string, noexec: boolean }[] }
 */
function fallbackParseOfrrps(data) {
  return data
    .split("\n")
    .slice(1)
    .filter((line) => line.length > 2)
    .map((line) => {
      const [pid, ppid, exit, cmd] = [...get_field(line)];
      return { pid, ppid, exit, cmd, noexec: REGEXES.ForkedNoExec.test(line) };
    });
}

/**
 * @param { string } rr - path to RR
 * @param { string } trace - trace directory
 * @returns { Promise<{ value: string, label: string, description: string, detail: string, binary: string, noexec: boolean }[]> }
 */
async function getTraceInfo(rr, trace) {
  return new Promise((resolve, reject) => {
    subprocess.exec(`${rr} ps ${trace}`, (error, stdout, stderr) => {
      if (error) {
        reject(stderr);
      } else {
        const json = fallbackParseOfrrps(stdout);
        resolve(json);
      }
    });
  }).then((picks) => {
    return picks.map(({ pid, ppid, exit, cmd, noexec }, index) => {
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
        label: `${path.basename(cmd.split(" ")[0] ?? cmd)} (${pid})`,
        description: `PID: ${pid}, PPID: ${ppid === "--" ? "--" : +ppid}, EXIT: ${exit}`,
        detail: cmd.trim(),
        binary,
        noexec,
      };
    });
  });
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

const tracePicked = async (rr, traceWorkspace) => {
  if(traceWorkspace == null || traceWorkspace == undefined) {
    throw new Error("You did not pick a trace");
  }
  const options = {
    canPickMany: false,
    ignoreFocusOut: true,
    title: "Select process to debug",
  };
  return await vscode.window.showQuickPick(getTraceInfo(rr, traceWorkspace), options).then((selection) => {
    if (selection) {
      const replay_parameters = { pid: selection.value, traceWorkspace: traceWorkspace, cmd: selection.binary, noexec: selection.noexec };
      return replay_parameters;
    }
    return null;
  });
};

/**
 * 
 * @param {*} rr
 * @returns { Promise<String> }
 */
function getGdbInit(rr) {
  return new Promise((res, rej) => {
    subprocess.exec(`${rr} gdbinit`, (error, stdout, stderr) => {
      if(error) rej(error);
      else res(stdout.toString())
    })
  });
}

async function generateGdbInit(rr) {
  return await getGdbInit(rr).then(data => {
    // this is ugly copying. But... I don't care. This is run once on each update & build of RR
    // and involves at most a kb or two.
    const lines = data.split("\n");
    let i = 0;
    for(; i < lines.length; ++i) {
      if(lines[i].includes("set prompt (rr)"))
        break;
    }
    const kept_lines = lines.splice(0, i);
    return kept_lines.join("\n");
  })
}

module.exports = {
  tracePicked,
  getTraces,
  parseProgram,
  generateGdbInit
};
