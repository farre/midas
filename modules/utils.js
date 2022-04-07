"use strict";

const { exec, spawn: _spawn } = require("child_process");
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const { TerminalInterface } = require("./terminalInterface");

function isNothing(e) {
  return e == undefined || e == null;
}

async function kill_pid(pid) {
  return await exec(`kill -INT ${Number.parseInt(pid)}`);
}

async function buildTestFiles(testPath) {
  const buildPath = path.join(testPath, "build");
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
    }
  };
}

/**
 * Stores arrays in a map
 */
class ArrayMap {
  #storage = new Map();
  constructor() { }
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
  constructor() {  }

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
    for(let i = 0; i < this.#data.length; i++) {
      let ith_should_keep = false;
      for(let j = 0; j < items.length; j++) {
        if(comparator(this.#data[i], items[j])) {
          ith_should_keep = true;
          duplicateIndices.push(j);
          break;
        }
      }
      if(!ith_should_keep) {
        removeIndices.push(i);
      }
    }
    let newIndices = [];
    for(let i = 0; i < items.length; i++) {
      if(!duplicateIndices.includes(i)) newIndices.push(i);
    }
    return { removeIndices, newIndices };
  }

  pop(indices) {
    let sorted = indices.sort((a, b) => a < b);
    let remove = [];
    let shift = 0;
    for(const idx of sorted) {
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
 * 
 * @param {{ terminal: string }} config 
 * @returns { Promise<TerminalInterface>}
 */
async function spawnExternalConsole(config, pid) {
  return new Promise((resolve, reject) => {
    // file which we write the newly spawned terminal's tty to
    const write_tty_to = `/tmp/midas-tty-for-gdb-${Math.ceil(Math.random() * 100000)}`;
    const terminal = config.terminal ?? "x-terminal-emulator";
    const param = `sh -c "clear && tty > ${write_tty_to} && echo $$ >> ${write_tty_to} && sleep 100000000000000"`;
    const terminal_spawn_parameters = ["-e", param];
    const process = _spawn(terminal, terminal_spawn_parameters);
    let tries = 0;
    const interval = setInterval(() => {
      if (fs.existsSync(write_tty_to)) {
        clearInterval(interval);
        const [tty_path, shpid] = fs.readFileSync(write_tty_to).toString("utf8").trim().split("\n");
        fs.unlinkSync(write_tty_to);
        const tty = { path: tty_path, config: write_tty_to }
        let termInterface = new TerminalInterface(process, tty, Number.parseInt(shpid));
        return resolve(termInterface);
      }
      tries++;
      if (tries > 500)
        reject();
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
    const {path, addr, port, pid, traceWorkspace} = rrArgs;
    const write_tty_to = `/tmp/midas-tty-for-gdb-${Math.ceil(Math.random() * 100000)}`;
    const terminal = config.terminal ?? "x-terminal-emulator";
    const cmd = `${path} replay -h ${addr} -s ${port} -p ${pid} -k ${traceWorkspace}`;
    const param = `sh -c "clear && ${cmd} && sleep 1000000000000000000"`;
    const child = _spawn(terminal, ["-e", param]);
    resolve(new TerminalInterface(child, null, child.pid));
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
  kill_pid
};
