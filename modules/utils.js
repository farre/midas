"use strict";

const { exec, spawn: _spawn, execSync } = require("child_process");
const vscode = require("vscode");
const fs = require("fs");
const Path = require("path");
const { TerminalInterface } = require("./terminalInterface");

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
    }).once("exit", resolve)
  );

  await new Promise((resolve) => exec("cmake --build .", { cwd: buildPath }).once("exit", resolve));
}

function getFunctionName() {
  try {
    throw new Error();
  } catch (e) {
    // Get the name of the calling function.
    return e.stack.split("\n")[2].match(/^.+?[\.]([^ ]+)/)[1];
  }
}

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
    kill() {
      p.kill();
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
/**
 * Resolve a symlink to where it points to. `fully` sets if
 * it should be resolved fully (i.e, if it's a symlink to a symlink etc
 * follow the entire chain to it's end).
 * @param {boolean} fully
 */
function resolveCommand(cmd, fully = true) {
  if (fs.existsSync(cmd)) {
    return fs.realpathSync(cmd);
  }
  const whereis = execSync(`whereis ${cmd}`);
  const parts = whereis.toString().split(" ");
  if (parts.length < 2) {
    throw new Error(`Command ${cmd} could not be resolved`);
  }
  for (const result of parts.slice(1)) {
    if (Path.basename(result) == cmd) {
      return result;
    }
  }
  throw new Error(`Command ${cmd} could not properly be resolved. Try providing the fully qualified path`);
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
 * Spawns external console
 * @param {{ terminal: string }} config
 * @returns { Promise<TerminalInterface>}
 */
async function spawnExternalConsole(config, pid) {
  return new Promise((resolve, reject) => {
    // file which we write the newly spawned terminal's tty to
    const terminal_command = config.terminal ?? "x-terminal-emulator";
    const write_tty_to = randomTtyFile();
    const resolved = resolveCommand(terminal_command);
    const terminal_name = Path.basename(resolved);
    const newProcessParameter = LinuxTerminalSettings[terminal_name] ?? "";
    // why write the PPID here? Because, in some cases, multiple processes get spawned by the command
    // thus, we have to kill the parent to get rid of them all (and thus, closing the external console, if that's what the user wants)
    const param = `sh -c "clear && tty > ${write_tty_to} && echo $$ >> ${write_tty_to} && echo $PPID >> ${write_tty_to} && sleep 100000000000000"`;
    const terminal_spawn_parameters = [newProcessParameter, "-e", param];
    const process = _spawn(terminal_command, terminal_spawn_parameters);
    let tries = 0;
    const interval = setInterval(() => {
      if (fs.existsSync(write_tty_to)) {
        clearInterval(interval);
        const [tty_path, shpid, ppid] = fs.readFileSync(write_tty_to).toString("utf8").trim().split("\n");
        fs.unlinkSync(write_tty_to);
        const tty = { path: tty_path, config: write_tty_to };
        let termInterface = new TerminalInterface(process, tty, Number.parseInt(shpid), ppid);
        return resolve(termInterface);
      }
      tries++;
      if (tries > 500) reject();
    }, 10);
  });
}
/**
 *
 * @param {any} config
 * @param {{path: string, addr: string, port: string, pid: string, traceWorkspace: string}} rrArgs
 * @returns {Promise<TerminalInterface>}
 */
async function spawnExternalRrConsole(config, rrArgs) {
  return new Promise((resolve, reject) => {
    const { path, addr, port, pid, traceWorkspace } = rrArgs;
    const terminal_command = config.terminal ?? "x-terminal-emulator";
    const write_tty_to = randomTtyFile();
    const resolved = resolveCommand(terminal_command);
    const terminal_name = Path.basename(resolved);
    const newProcessParameter = LinuxTerminalSettings[terminal_name] ?? "";
    // why write the PPID here? Because, in some cases, multiple processes get spawned by the command
    // thus, we have to kill the parent to get rid of them all (and thus, closing the external console, if that's what the user wants)
    const cmd = `${path} replay -h ${addr} -s ${port} -p ${pid} -k ${traceWorkspace}`;
    // eslint-disable-next-line max-len
    const param = `sh -c "clear && tty > ${write_tty_to} && echo $$ >> ${write_tty_to} && echo $PPID >> ${write_tty_to} && ${cmd} && sleep 100000000000000"`;
    const terminal_spawn_parameters = [newProcessParameter, "-e", param];
    const process = _spawn(terminal_command, terminal_spawn_parameters);
    let tries = 0;
    const interval = setInterval(() => {
      if (fs.existsSync(write_tty_to)) {
        clearInterval(interval);
        const [tty_path, shpid, ppid] = fs.readFileSync(write_tty_to).toString("utf8").trim().split("\n");
        fs.unlinkSync(write_tty_to);
        const tty = { path: tty_path, config: write_tty_to };
        let termInterface = new TerminalInterface(process, tty, Number.parseInt(shpid), ppid);
        return resolve(termInterface);
      }
      tries++;
      if (tries > 500) reject();
    }, 10);
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
};
