// @ts-check
"use strict";

const { exec, spawn: _spawn, spawnSync, execSync } = require("child_process");
const vscode = require("vscode");
const fs = require("fs");
const Path = require("path");
const { TerminalInterface } = require("../terminalInterface");
const { resolveCommand, sudo, sanitizeEnvVariables, getAllPidsForQuickPick } = require("./sysutils");
const { getReleaseNotes } = require("./releaseNotes");
const { Regexes } = require("../constants");
const { consoleLog } = require("./log");

/** @typedef { { sha: string, date: Date } } GitMetadata */
/** @typedef { { root_dir: string, path: string, version: string, managed: boolean, git: GitMetadata } } ManagedTool */
/** @typedef { { rr: ManagedTool, gdb: ManagedTool, mdb: ManagedTool } } Toolchain */
/** @typedef { { midas_version: string, toolchain: Toolchain } } MidasConfig */

/** @returns { MidasConfig } */
function createEmptyMidasConfig() {
  return {
    midas_version: "",
    toolchain: {
      rr: { root_dir: "", path: "", version: "", managed: false, git: { sha: null, date: null } },
      gdb: { root_dir: "", path: "", version: "", managed: false, git: { sha: null, date: null } },
      mdb: { root_dir: "", path: "", version: "", managed: false, git: { sha: null, date: null } },
    },
  };
}

class Tool {
  /** @type {string} */
  #path;

  #spawnArgs;

  /**
   * @param { string } name
   * @param { string } path
   * @param { string[] } spawnArgs
   */
  constructor(name, path, spawnArgs = null) {
    /** @type {string} */
    this.name = name;

    /** @type {string} */
    this.#path = path;

    this.#spawnArgs = spawnArgs ?? [];
  }

  get managed() {
    return false;
  }

  /**
   * @param {string[]} args
   * @param {string} password
   */
  async sudoExecute(args, password = null) {
    const pass = password ?? (await vscode.window.showInputBox({ prompt: "input your sudo password", password: true }));

    await sudo([this.path, ...args], pass, (code) => {
      if (code == 0) {
        consoleLog(`Application executed successfully`);
      } else {
        throw new Error(`${this.path} failed, returned exit code ${code}`);
      }
    });
  }

  execute(args, logger = null, spawnOptions = { stdio: "pipe", env: sanitizeEnvVariables() }) {
    try {
      return new Promise((resolve, reject) => {
        consoleLog(`executing ${this.path} ${args.map(s => `"${s}"`).join(" ")}`);
        let app = _spawn(this.path, args);
        app.stdout.on("data", (data) => {
          if (logger != null) {
            logger.appendLine(data.toString().trim());
          }
        });
        app.stderr.on("data", data => {
          if (logger != null) {
            logger?.appendLine(data.toString().trim());
          }
        });
        app.on("error", (err) => {
          reject(err);
        });
        app.on("exit", (code, signals) => {
          if (code != 0) {
            reject(`Application exited with code ${code}`);
          } else {
            resolve();
          }
        });
      });
    } catch (e) {
      vscode.window.showErrorMessage(`Failed to run command ${this.name} (path: ${this.path})`);
    }
  }

  /**
   * @returns {import("child_process").ChildProcessWithoutNullStreams}
   */
  spawn(args, spawnOptions) {
    const spawnWithArgs = this.spawnArgs.concat(args);
    try {
      consoleLog(`spawning ${this.path} ${spawnWithArgs.join(" ")} \n(options: ${JSON.stringify(spawnOptions)})`);
    } catch (ex) {
      consoleLog(`spawning ${this.path} ${spawnWithArgs.join(" ")}`);
    }

    return _spawn(this.path, spawnWithArgs, spawnOptions);
  }

  get path() {
    return this.#path;
  }

  get spawnArgs() {
    return this.#spawnArgs ?? [];
  }
}

/** @typedef { { major: number, minor: number, patch: number } } SemVer */

/** @returns { import("../activateDebuggerExtension").MidasAPI } */
function getAPI() {
  return global.API;
}

function strEmpty(str) {
  return str === undefined || str === null || str === "";
}

/**
 *
 * @param {*} str
 * @param {{or: string}} other_str
 * @returns
 */
function strValueOr(str, other_str) {
  if (strEmpty(str)) return other_str;
  else return str;
}

function isNothing(e) {
  return e == undefined || e == null;
}

async function kill_pid(pid) {
  return await exec(`kill -INT ${Number.parseInt(pid)}`);
}

async function buildTestFiles(testPath) {
  const buildPath = Path.join(testPath, "build");
  if (!fs.existsSync(buildPath)) {
    fs.mkdirSync(buildPath);
  }

  await new Promise((resolve) =>
    exec("cmake .. -DCMAKE_BUILD_TYPE=Debug", {
      cwd: buildPath,
    }).once("exit", resolve),
  );

  await new Promise((resolve) =>
    exec("cmake --build .", { cwd: buildPath }).once("exit", (exit_code) => resolve(exit_code)),
  );
}

function getFunctionName() {
  try {
    throw new Error();
  } catch (e) {
    // Get the name of the calling function.
    return e.stack.split("\n")[2].match(/^.+?[\.]([^ ]+)/)[1];
  }
}

// todo(simon): Make this function take a handle to the (possible) external terminal process
//  so that it can be killed in the returned object's kill method. This will make that code clearer and easier to reason about.
/**
 * Custom spawn-function that intercepts stdio so that we can control
 * encoding, and also have the ability to process commands typically sent over the command line
 * stdin/stdout.
 * @param {string} gdbPath
 */
function spawn(gdbPath, args) {
  let p = _spawn(gdbPath, args);

  return {
    stdin: {
      __proto__: p.stdin,
      /**
       * @param {string} data
       */
      write(data) {
        p.stdin.write(data);
      },
    },
    stdout: p.stdout,
    stderr: p.stderr,
    kill(signal) {
      p.kill(signal);
    },
    pid() {
      return p.pid;
    },
  };
}

/**
 * Stores arrays in a map
 */
class ArrayMap {
  #storage = new Map();
  constructor() {}
  /**
   * Adds `value` to the array keyed by `key`. If no array is referenced by key, one is created.
   * @param {any} key
   * @param {any} value
   */
  add_to(key, value) {
    let set = this.#storage.get(key) ?? [];
    set.push(value);
    this.#storage.set(key, set);
  }

  /**
   * Returns an array referenced by key or an empty iterable, to help
   * with not polluting code with .get(..) ?? [] everywhere.
   * @param {any} key
   * @returns { any[] }
   */
  safe_get(key) {
    return this.#storage.get(key) ?? [];
  }

  /**
   * @param {any} key
   * @param {any[]} array
   */
  set(key, array) {
    this.#storage.set(key, array);
  }

  clear() {
    this.#storage.clear();
  }

  delete(key) {
    this.#storage.delete(key);
  }
}

/** @template T */
class ExclusiveArray {
  /** @type { T[] } */
  #data = [];
  constructor() {}

  /**
   * Compares `items` with the elements in this array and returns what elements needs removing from this array
   * as well as the elements that are to be added from `items`
   * @param { T[] } items - the array for which we are comparing against
   * @param { (a: T, b: T) => boolean } comparator
   * @returns {{ removeIndices: number[], newIndices: number[] }} - `remove` contains the indices of which elements can be to be removed,
   * and `new` contains the indices of the elements in `items` that are not duplicates in this array.
   */
  unionIndices(items, comparator) {
    let removeIndices = [];
    let duplicateIndices = [];
    for (let i = 0; i < this.#data.length; i++) {
      let ith_should_keep = false;
      for (let j = 0; j < items.length; j++) {
        if (comparator(this.#data[i], items[j])) {
          ith_should_keep = true;
          duplicateIndices.push(j);
          break;
        }
      }
      if (!ith_should_keep) {
        removeIndices.push(i);
      }
    }
    let newIndices = [];
    for (let i = 0; i < items.length; i++) {
      if (!duplicateIndices.includes(i)) newIndices.push(i);
    }
    return { removeIndices, newIndices };
  }

  pop(indices) {
    let sorted = indices.sort((a, b) => a < b);
    let remove = [];
    let shift = 0;
    for (const idx of sorted) {
      remove.push(this.#data.splice(idx - shift, 1)[0]);
      shift += 1;
    }
    return remove;
  }

  push(...elements) {
    this.#data.push(...elements);
  }

  get(idx) {
    return this.data[idx];
  }

  get data() {
    return this.#data;
  }
}

// Due to the client/server architecture that has been introduced to
// many linux terminals, we need to *force* it to spawn a new process
// otherwise, when we spawn our new terminal, it will from Midas perspective
// exit immediately (with code = 0). We need the NodeJS child to stay alive, thus
// it is _required_ to be able to be spawned as a new process. Terminals that do not
// provide this functionality will *not* work for Midas - with the exception
// of if it is the _only_ terminal that you have alive/open as then
// it *most likely* will be the "server process" that gets spawned.
// Add more terminals to this object.
const LinuxTerminalSettings = {
  "gnome-terminal": "--disable-factory",
  tilix: "--new-process",
  xterm: "",
};

function randomTtyFile() {
  return `/tmp/midas-tty-for-gdb-${Math.ceil(Math.random() * 100000)}`;
}

/**
 * Spawns a child and wraps it in a `TerminalInterface`.
 * @param { string } command - command string that spawns terminal
 * @param { string } ttyInfoPath - Path where tty info will be written to & read from
 * @param { string[] } shellParameters - parameters to be passed to the shell to execute
 * @returns { Promise<TerminalInterface> }
 */
function spawnConsole(command, ttyInfoPath, closeOnExit, shellParameters = []) {
  const terminal_command = command ?? "x-terminal-emulator";
  // the shell basically needs to indefintely wait. There's no infinite wait I can use here,
  // so just set it to wait for 31000+ years.
  shellParameters.push("sleep 1000000000000");
  const shellParametersString = shellParameters.join(" && ");
  const shellCommand = !closeOnExit
    ? `sh -c "${shellParametersString}; sleep 1000000000"`
    : `sh -c "${shellParametersString}"`;

  const resolved = resolveCommand(terminal_command);
  const terminal_name = Path.basename(resolved);
  const newProcessParameter = LinuxTerminalSettings[terminal_name] ?? "";

  return new Promise((resolve, reject) => {
    const process = _spawn(command, [newProcessParameter, "-e", shellCommand]);
    let tries = 0;
    const interval = setInterval(() => {
      if (fs.existsSync(ttyInfoPath)) {
        clearInterval(interval);
        const [tty_path, shell_pid, ppid] = fs.readFileSync(ttyInfoPath).toString("utf8").trim().split("\n");
        // get the PID of the child process (rr) if there is one.
        const children = fs.readFileSync(`/proc/${shell_pid}/task/${shell_pid}/children`).toString().trim();
        fs.unlinkSync(ttyInfoPath);
        const tty = { path: tty_path };
        const termInterface = new TerminalInterface(process, tty, Number.parseInt(shell_pid), ppid, children);
        resolve(termInterface);
      }
      tries++;
      if (tries > 500) reject();
    }, 10);
  });
}

/**
 * Spawns external console
 * @param {{ terminal: string, closeOnExit: boolean }} config
 * @returns { Promise<TerminalInterface>}
 */
async function spawnExternalConsole(config) {
  const ttyInfoPath = randomTtyFile();
  return spawnConsole(config.terminal, ttyInfoPath, config.closeOnExit, [
    "clear",
    `tty > ${ttyInfoPath}`,
    `echo $$ >> ${ttyInfoPath}`,
    `echo $PPID >> ${ttyInfoPath}`,
  ]);
}
/**
 * Spawn external console that also launches rr in it.
 * @param { { terminal: string, closeOnExit: boolean } } config
 * @param {{path: string, address: string, port: string, pid: string, traceWorkspace: string}} rrArgs
 * @returns {Promise<TerminalInterface>}
 */
async function spawnExternalRrConsole(config, rrArgs) {
  const { path, address, port, pid, traceWorkspace } = rrArgs;
  const cmd = `${path} replay -h ${address} -s ${port} -p ${pid} -k ${traceWorkspace}`;
  const ttyInfoPath = randomTtyFile();
  return spawnConsole(config.terminal, ttyInfoPath, config.closeOnExit, [
    "clear",
    `tty > ${ttyInfoPath}`,
    `echo $$ >> ${ttyInfoPath}`,
    `echo $PPID >> ${ttyInfoPath}`,
    cmd,
  ]);
}

/**
 * @typedef {{title: string, action: () => Promise<any> }} Choice
 *
 * @param { string } message
 * @param { string } detail
 * @param { Choice[] } items
 * @returns { Promise<Choice> }
 */
async function showErrorPopup(message, detail = null, items = []) {
  const options = { detail, modal: true };
  return vscode.window.showErrorMessage(message, options, ...items);
}

function toHexString(numberString) {
  const n = Number(+numberString);
  return n.toString(16).padStart(18, "0x0000000000000000");
}

/**
 * Compare sem ver's and throw an exception if version < required_version
 * @param {SemVer} version - version to check against requirement
 * @param {SemVer} required_version - requirement version
 * @param {boolean} patch_required - if comparison should check patch version.
 */
function requiresMinimum(version, required_version, patch_required = false) {
  const throw_fn = () => {
    const { major, minor, patch } = required_version;
    throw new Error(
      `Version ${major}.${minor}.${patch} is required. You have ${version.major}.${version.minor}.${version.patch}`,
    );
  };
  if (version.major < required_version.major) {
    throw_fn();
  } else if (version.major == required_version.major) {
    if (version.minor < required_version.minor) {
      throw_fn();
    } else if (patch_required && version.minor == required_version.minor && version.patch < required_version.patch) {
      throw_fn();
    }
  }
}

/**
 * Parse string and find sem ver info.
 * @param {string} string - string to parse possible sem ver from.
 * @returns { SemVer }
 */
function parseSemVer(string) {
  let m = Regexes.MajorMinorPatch.exec(string);
  if (!isNothing(m)) {
    // remove first group. i.e. 1.2.3 is not interesting, only 1 2 and 3 is
    m.shift();
    let [major, minor, patch] = m;
    return {
      major: +major,
      minor: +minor,
      patch: +(patch ?? 0),
    };
  }
  return null;
}

/**
 * @param {SemVer} lhs
 * @param {SemVer} rhs
 * @returns {boolean}
 */
function semverIsNewer(lhs, rhs) {
  const bits = (lhs.major << 16) | (lhs.minor << 8) | lhs.patch;
  const cmp_bits = (rhs.major << 16) | (rhs.minor << 8) | rhs.patch;
  return bits > cmp_bits;
}

/**
 * Executes `pathToBinary` and passes the parameter `--version` and parses this output for a SemVer.
 * @param {string} pathToBinary - path to binary which we execute with parameter `--version` to retrieve it's version.
 * @returns {Promise<SemVer>}
 */
function getVersion(pathToBinary) {
  return new Promise((resolve, reject) => {
    exec(`${pathToBinary} --version`, (err, stdout, stderr) => {
      if (err) reject(stderr);
      else {
        const version = parseSemVer(stdout);
        if (!isNothing(version)) {
          resolve(version);
        } else {
          reject(`Could not parse semantic versioning from output: ${stdout}`);
        }
      }
    });
  });
}

async function getPid() {
  const allPids = await getAllPidsForQuickPick();
  return (await vscode.window.showQuickPick(allPids)).pid;
}

const scheme = "midas-notes";

async function showReleaseNotes() {
  const uri = vscode.Uri.parse(`${scheme}:Midas Release Notes`);
  await vscode.commands.executeCommand("markdown.showPreview", uri);
}

function releaseNotesProvider() {
  const eventEmitter = new vscode.EventEmitter();
  return vscode.workspace.registerTextDocumentContentProvider(scheme, {
    async provideTextDocumentContent(uri) {
      const textDoc = `# ${uri.path}
${await getReleaseNotes()}`;
      return textDoc;
    },

    onDidChange: eventEmitter.event,
  });
}

module.exports = {
  buildTestFiles,
  getFunctionName,
  spawn,
  ArrayMap,
  ExclusiveArray,
  spawnExternalConsole,
  spawnExternalRrConsole,
  isNothing,
  kill_pid,
  showErrorPopup,
  resolveCommand,
  toHexString,
  parseSemVer,
  semverIsNewer,
  getVersion,
  requiresMinimum,
  getPid,
  showReleaseNotes,
  releaseNotesProvider,
  strEmpty,
  strValueOr,
  getAPI,
  createEmptyMidasConfig,
  Tool,
};
