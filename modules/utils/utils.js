"use strict";

const { exec, spawn: _spawn, execSync } = require("child_process");
const vscode = require("vscode");
const fs = require("fs");
const Path = require("path");
const { TerminalInterface } = require("../terminalInterface");
const { initInstaller } = require("./installerProgress");
const { which, resolveCommand, getExtensionPathOf } = require("./sysutils");

/** @typedef { { major: number, minor: number, patch: number } } SemVer */

const REGEXES = {
  MajorMinorPatch: /(\d+)\.(\d+)\.*((\d+))?/,
  WhiteSpace: /\s/,
};

const ContextKeys = {
  AllStopModeSet: "midas.allStopModeSet",
  Running: "midas.Running",
  DebugType: "midas.debugType",
  RRSession: "midas.rrSession",
};

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
 * @param {{path: string, addr: string, port: string, pid: string, traceWorkspace: string}} rrArgs
 * @returns {Promise<TerminalInterface>}
 */
async function spawnExternalRrConsole(config, rrArgs) {
  const { path, addr, port, pid, traceWorkspace } = rrArgs;
  const cmd = `${path} replay -h ${addr} -s ${port} -p ${pid} -k ${traceWorkspace}`;
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
      `Version ${major}.${minor}.${patch} is required. You have ${version.major}.${version.minor}.${version.patch}`
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
  let m = REGEXES.MajorMinorPatch.exec(string);
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
  const input = await vscode.window.showInputBox({
    prompt: "Type PID or name of process to get a list to select from",
    placeHolder: "123 | foo",
    title: "Process to attach to",
  });
  if (input) {
    if (/[^\d]/.test(input)) {
      const cmd = `pidof ${input}`;
      try {
        const data = execSync(cmd).toString();
        const options = {
          canPickMany: false,
          ignoreFocusOut: true,
          title: `${input}: Select PID to attach to `,
        };
        let split = data.split(" ");
        if (split.length == 1) {
          return split[0].trim();
        }
        return await vscode.window.showQuickPick(
          split.map((e) => e.trim()),
          options
        );
      } catch (e) {
        vscode.window.showInformationMessage(`No process with that name: ${input}`);
        return null;
      }
    } else {
      return input;
    }
  } else {
    vscode.window.showInformationMessage("No PID (or process) selected");
    return null;
  }
}

const FEDORA_DEPS =
  // eslint-disable-next-line max-len
  "ccache cmake make gcc gcc-c++ gdb libgcc libgcc.i686 glibc-devel glibc-devel.i686 libstdc++-devel libstdc++-devel.i686 libstdc++-devel.x86_64 python3-pexpect man-pages ninja-build capnproto capnproto-libs capnproto-devel zlib-devel".split(
    " "
  );

const UBUNTU_DEPS =
  "ccache cmake make g++-multilib gdb pkg-config coreutils python3-pexpect manpages-dev git ninja-build capnproto libcapnp-dev zlib1g-dev".split(
    " "
  );

async function guessInstaller() {
  if ("" != (await which("dpkg"))) {
    return { name: "apt", pkg_manager: getExtensionPathOf("modules/python/apt_manager.py"), deps: UBUNTU_DEPS, cancellable: true };
  }

  if ("" != (await which("rpm"))) {
    return { name: "dnf", pkg_manager: getExtensionPathOf("modules/python/dnf_manager.py"), deps: FEDORA_DEPS, cancellable: true };
  }
  throw new Error("Package Manager installed on your system is unknown to Midas. You have to install manually");
}

async function installRRFromRepository() {
  try {
    // we can ignore deps. dpkg / apt will do that for us here.
    // eslint-disable-next-line no-unused-vars
    const { name, pkg_manager, deps, cancellable} = await guessInstaller();
    await initInstaller(pkg_manager, ["rr"], cancellable);
  } catch (err) {
    vscode.window.showErrorMessage("Failed to install RR from repository");
  }
}

async function installRRFromDownload() {
  // eslint-disable-next-line no-unused-vars
  const { name, pkg_manager, deps } = await guessInstaller();
  const uname = await which("uname");
  const arch = execSync(`${uname} -m`).toString().trim();
  if (name == "apt") {
    const { path, success } = await http_download(
      `https://github.com/rr-debugger/rr/releases/download/5.6.0/rr-5.6.0-Linux-${arch}.deb`,
      `rr-5.6.0-Linux-${arch}.deb`
    );
    if (success) {
      // todo(simon): implement installing of `file`
    }

  } else if (name == "dnf") {
    let { path, success } = await http_download(
      `https://github.com/rr-debugger/rr/releases/download/5.6.0/rr-5.6.0-Linux-${arch}.rpm`,
      `rr-5.6.0-Linux-${arch}.rpm`
    );
    if (success) {
      // todo(simon): implement installing of `file`
    }
  } else {
    throw new Error("Failed to guess repo manager");
  }
}

async function installRRFromSource() {
  // eslint-disable-next-line no-unused-vars
  const { name, pkg_manager, deps, cancellable} = await guessInstaller();
  await http_download("https://github.com/rr-debugger/rr/archive/refs/heads/master.zip", "rr-master.zip");
  await initInstaller(pkg_manager, deps, cancellable);
  // todo(simon): add build from source functionality, which requires downloading source + untar it + run build command
  vscode.window.showInformationMessage("Downlod, build and install from source");
}

async function getRR() {
  const { method } = await vscode.window.showQuickPick(
    [
      {
        label: "Install from repository",
        description: "Install rr from the OS package repository",
        method: installRRFromRepository,
      },
      {
        label: "Install from download",
        description: "Download the latest release and install it",
        method: installRRFromDownload,
      },
      {
        label: "Install from source",
        description: "Download, build, and install from source",
        method: installRRFromSource,
      },
    ],
    { placeHolder: "Choose method of installing rr" }
  );
  try {
    await method();
  } catch (err) {
    vscode.window.showErrorMessage(`Failed: ${err}`);
  }
}

/**
 * Downloads a file from `url` and saves it as `file_name` in the extension folder.
 * @param {string} url - The url of the file to download
 * @param {string} file_name - Desired file name of download. N.B: without path, Midas resolves its own path.
 * @returns {Promise<{path: string, success: boolean}>} `path` of saved file and `success` indicates if it downloaded fully
 */
 async function http_download(url, file_name) {
  const path = getExtensionPathOf(file_name);
  if (fs.existsSync(path)) {
    // remove old file. We're in extension folder, so we can freely remove stuff
    fs.unlinkSync(path);
  }
  let p = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      cancellable: true,
      title: "Downloading",
    },
    (progress, token) =>
      new Promise((resolve, reject) => {
        const output_stream = fs.createWriteStream(path, { flags: "wx" });
        const cleanup = (err) => {
          vscode.window.showErrorMessage(err);
          output_stream.close();
          fs.unlinkSync(path);
          reject(err);
        };

        const controller = new AbortController();
        const signal = controller.signal;
        signal.addEventListener(
          "abort",
          () => {
            cleanup("Download cancelled");
          },
          { once: true }
        );
        const handle_response = (request, response) => {
          if (response.statusCode != 200) {
            throw new Error(
              `Download error. Server responded with: ${response.statusCode} - ${response.statusMessage}`
            );
          }
          response.pipe(output_stream);
          const file_size = response.headers["content-length"];
          response.on("data", (chunk) => {
            const increment = (chunk.length / +file_size) * 100.0;
            progress.report({ increment: increment, message: `${url}` });
          });
          token.onCancellationRequested(() => {
            controller.abort();
            resolve({path: path, success: false})
          });
          request.on("error", (err) => {
            cleanup(err.message);
          });

          output_stream.on("error", (err) => {
            cleanup(err.message);
          });
          output_stream.on("close", () => {
            resolve({path: path, success: true});
          });
        };

        const request = require("https").get(url, { signal: signal }, (response) => {
          if (response.statusCode == 302) {
            let new_request = require("https").get(response.headers.location, { signal: signal }, (response) => {
              handle_response(new_request, response);
            });
          } else if (response.statusCode == 200) {
            handle_response(request, response);
          } else {
            cleanup(`Download error. Server responded with: ${response.statusCode} - ${response.statusMessage}`);
          }
        });
      })
  );
  return p;
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
  ContextKeys,
  toHexString,
  REGEXES,
  parseSemVer,
  getVersion,
  requiresMinimum,
  getPid,
  getRR,
};
