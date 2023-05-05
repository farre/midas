// @ts-check
"use strict";

const { exec, spawn: _spawn, execSync } = require("child_process");
const vscode = require("vscode");
const fs = require("fs");
const Path = require("path");
const { TerminalInterface } = require("../terminalInterface");
const { run_install, InstallerExceptions } = require("./installerProgress");
const { which, resolveCommand, getExtensionPathOf, sudo } = require("./sysutils");
const process = require("process");


const ToolList = {
  cmake : { variants: ["cmake"] },
  python : { variants: ["python", "python3", "py"] },
  unzip : { variants: ["unzip"], },
  ninja: { variants: ["ninja"] }
}

class Tool {
  /**
   * 
   * @param {string} name
   * @param {string} path
   * @param {{ variant: string, err: import("child_process").ExecException }[]} error
   */
  constructor(name, path, error = null) {
    /** @type {string} */
    this.name = name;

    /** @type {string} */
    this.path = path;

    /** @type {{ variant: string, err: import("child_process").ExecException }[]} */
    this.error = error;
  }

  /** @returns {boolean} */
  found() { return this.error === null; }

  /** @returns {{ variant: string, err: import("child_process").ExecException }[]} */
  errors() { return this.error; }

  errorMessage() {
    return `could not find any of '${this.error.map(v => v.variant).join(", ")}' on $PATH. One of these are required to be installed on your system`
  }
}

/**
 *
 * @param {string} name
 * @param {string[]} variants
 * @returns
 */
function ToolBuilder(name, variants) {
  const errors = [];
  for(const variant of variants) {
    try {
      const path = execSync(`which ${variant}`)
      if(!strEmpty(path)) {
        return new Tool(name, path.toString().trim(), null);
      }
    } catch(err) {
      errors.push(err);
    }
  }
  return new Tool(name, null, errors);
}

/**
 * @param {string[]} tools - what tools to check if they exist on system. `ToolList` contains all tools, but are not
 * required for all tool chain management functions.
 * @return { Object.<string, Tool> }
 */
function verifyPreRequistesExists(tools = ["cmake", "python", "unzip"]) {
  let result = {};
  for(const tool_name of tools) {
    let tool = ToolBuilder(tool_name, ToolList[tool_name].variants);
    result[tool_name] = tool;
  }

  // @ts-ignore
  return result;
}

/** @typedef { { major: number, minor: number, patch: number } } SemVer */

/** @returns { import("../activateDebuggerExtension").MidasAPI } */
function getAPI() {
  return global.API;
}

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
  if(strEmpty(str)) return other_str;
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
    }).once("exit", resolve)
  );

  await new Promise((resolve) => exec("cmake --build .", { cwd: buildPath }).once("exit", (exit_code) => resolve(exit_code)));
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

async function guessInstaller(python, logger) {
  const verify_py_imports = async (args) => {
    return new Promise(resolve => {
      _spawn(python, args).on("exit", (code) => {
        if(code == 0) {
          logger.appendLine(`${python} ${args.join(" ")} succeeded!`);
          resolve(true);
        } else {
          logger.appendLine(`${python} ${args.join(" ")} failed!`);
          resolve(false);
        }
      });
    })
  };

  if (!strEmpty((await which("dpkg")))) {
    if(!await verify_py_imports(["-c", "import apt"])) {
      throw { type: InstallerExceptions.ModuleImportFailed, message: `[Python Error]: Could not import APT module on a verified dpkg system.`};
    }
    return {
      name: "apt",
      pkg_manager: getExtensionPathOf("modules/python/apt_manager.py"),
      deps: UBUNTU_DEPS,
      cancellable: true,
    };
  }

  if (!strEmpty(await which("rpm"))) {
    if(!await verify_py_imports(["-c", `import dnf`])) {
      throw { type: InstallerExceptions.ModuleImportFailed, message: `[Python Error]: Could not import DNF module on a verified RPM system.`};
    }
    return {
      name: "dnf",
      pkg_manager: getExtensionPathOf("modules/python/dnf_manager.py"),
      deps: FEDORA_DEPS,
      cancellable: true,
    };
  }
  throw { type: InstallerExceptions.PackageManagerNotFound, message: "Could not resolve what package manager is used on your system"};
}

async function installFileUsingManager(args, logger) {
  let pass = await vscode.window.showInputBox({ prompt: "sudo password", password: true });
  // f*** me extension development for VSCode is buggy. I don't want to have to do this.
  if (!pass) {
    pass = await vscode.window.showInputBox({ prompt: "sudo password", password: true });
  }
  const pkg_manager = await sudo(args, pass);
  logger.show();
  pkg_manager.stdout.on("data", (data) => {
    logger.append(data.toString());
  });

  pkg_manager.stderr.on("data", (data) => {
    if (!data.includes("[sudo]")) logger.append(data.toString());
  });

  return new Promise((resolve, reject) => {
    pkg_manager.on("exit", (code) => {
      if (code == 0) {
        vscode.window.showInformationMessage("Successfully installed RR");
        resolve();
      } else {
        vscode.window.showInformationMessage("Failed to install RR. Try again or another method");
        reject({type: InstallerExceptions.PackageManagerError, message: `${code}`});
      }
    });
  });
}

async function installRRFromRepository({python}, logger) {
  // we can ignore deps. dpkg / apt will do that for us here.
  // eslint-disable-next-line no-unused-vars
  const { name, pkg_manager, deps, cancellable } = await guessInstaller(python, logger);
  let result = await run_install(python, pkg_manager, ["rr"], cancellable, logger);
  getAPI().write_rr({ path: "rr", version: "", managed: false});
  vscode.window.showInformationMessage(result);
}

async function installRRFromDownload({python}, logger) {
  // eslint-disable-next-line no-unused-vars
  const { name, pkg_manager, deps } = await guessInstaller(python, logger);
  const uname = await which("uname");
  const arch = execSync(`${uname} -m`).toString().trim();
  if (name == "apt") {
    const { version, url: url_without_fileext } = await resolveLatestVersion(arch);
    const { path, status } = await http_download(`${url_without_fileext}.deb`, `rr-${version}-Linux-${arch}.deb`);
    if (status == "success") {
      return await installFileUsingManager(["apt-get", "install", "-y", path], logger)
        .then(() => getAPI().write_rr({ path: "rr", version: version, managed: true }));
    }
  } else if (name == "dnf") {
    const { version, url } = await resolveLatestVersion(arch);
    const { path, status } = await http_download(`${url}.rpm`, `rr-${version}-Linux-${arch}.rpm`);
    if (status == "success") {
      return await installFileUsingManager(["dnf", "-y", "localinstall", path])
        .then(() => getAPI().write_rr({ path: "rr", version: version, managed: true }));
    }
  }
}

function spawn_cmake_cfg(cmake, build_path, has_ninja) {
  return _spawn(cmake,
    ["-S", `${build_path}/rr-master`, "-B", build_path, "-DCMAKE_BUILD_TYPE=Release", has_ninja ? "-G Ninja" : "",],
    { shell: true, stdio: "pipe", cwd: build_path }
  );
}

async function installRRFromSource(requiredTools, logger) {
  const { python, cmake, unzip } = requiredTools;
  const { pkg_manager, deps } = await guessInstaller(python, logger);
  const { path, status } = await http_download(
    "https://github.com/rr-debugger/rr/archive/refs/heads/master.zip",
    "rr-master.zip"
  );
  if (status == "success") {
    let result = await run_install(python, pkg_manager, deps, true, logger);
    vscode.window.showInformationMessage(`${result} dependencies`);
    const { version } = await resolveLatestVersion("we-don't-care-about-arch-here");
    const has_ninja = !strEmpty((await which("ninja")));
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, cancellable: true, title: "Building RR" },
      (progress, token) => {
        return new Promise((progress_resolve, reject) => {
          const build_path = getAPI().get_storage_path_of(`rr-${version}`);
          logger.show();
          logger.appendLine(`creating dir ${build_path}`);
          fs.mkdirSync(build_path);
          const unzip_cmd = `${unzip} ${path} -d ${build_path}`;
          logger.appendLine(unzip_cmd);
          execSync(unzip_cmd);
          const cmake_cfg = spawn_cmake_cfg(cmake, build_path, has_ninja);
          cmake_cfg.stdout.on("data", (data) => { logger.append(data.toString()); });
          cmake_cfg.stderr.on("data", (data) => { logger.append(data.toString()); });

          let last = 0;
          const matcher = /(\n)\[(?<current>\d+)\/(?<total>\d+)\]/g;

          cmake_cfg.on("exit", () => {
            const cmake_build = _spawn(cmake, ["--build", build_path, "-j"], {
              stdio: "pipe",
              detached: true,
              cwd: build_path,
            });
            cmake_build.stdout.on("data", (data) => {
              const str = data.toString();
              const matches = str.matchAll(matcher);
              for (const res of matches) {
                const { current, total } = res.groups;
                const inc = ((+current - last) / +total) * 100.0;
                last = +current;
                progress.report({ message: "Building...", increment: inc });
              }
              logger.append(str);
            });
            cmake_build.stderr.on("data", (data) => {
              logger.append(data.toString());
            });
            cmake_build.on("exit", async (code) => {
              if (code == 0) {
                logger.appendLine(
                  // eslint-disable-next-line max-len
                  `Build completed successfully... Adding path ${build_path}/bin/rr to MidasCache. Unless you specify a different RR path in launch.json, Midas will first attempt to use this.`
                );
                getAPI().write_rr({ path: `${build_path}/bin/rr`, version, managed: true });
                progress_resolve("Build completed successfully");
              } else {
                logger.appendLine(`Build failed - finished with exit code ${code}`);
                reject(`Build failed - finished with exit code ${code}`);
              }
            });
            cmake_build.on("error", (err) => {
              reject(`Build failed: ${err}`);
            });

            token.onCancellationRequested(() => {
              // -pid kills the process tree. We are a vengeful, hateful, spiteful god of the linux universe
              // (we do this, because "cmake --build" spawns new processes)
              process.kill(-cmake_build.pid, "SIGTERM");
              progress_resolve("Cancelled");
            });
          });
        });
      }
    );
  } else {
    return "Cancelled";
  }
}

async function getRR() {
  const answers = [
    { title: "No", isCloseAffordance: true },
    { title: "Yes", isCloseAffordance: false },
  ];
  let answer = await vscode.window.showInformationMessage(
    "To install RR (or it's depedencies), Midas requires you input your sudo password - are you ok with this?",
    { modal: true, detail: "Midas do not save or store any data about you." },
    ...answers
  );
  if (answer.title == answers[1].title) {
    const result = await vscode.window.showQuickPick(
      [
        {
          label: "Install from repository",
          description: "Install rr from the OS package repository",
          method: installRRFromRepository,
          op: "repo",
        },
        {
          label: "Install from download",
          description: "Download the latest release and install it",
          method: installRRFromDownload,
          op: "download"
        },
        {
          label: "Install from source",
          description: "Download, build, and install from source",
          method: installRRFromSource,
          op: "build"
        },
      ],
      { placeHolder: "Choose method of installing rr" }
    );
    if(result) {
      try {
        let requiredTools = [];
        if(result.op == "build") {
          requiredTools = ["python", "cmake", "unzip"];
        } else if(result.op == "download" || result.op == "repo") {
          requiredTools = ["python"]
        } else {
          throw { type: InstallerExceptions.Panic, message: "Toolchain management operation failed. A possible VSCode bug" };
        }
        const verifyPrerequisites = verifyPreRequistesExists(requiredTools);
        for(const tool of requiredTools) {
          if(!verifyPrerequisites.hasOwnProperty(tool)) {
            // eslint-disable-next-line max-len
            throw { type: InstallerExceptions.TerminalCommandNotFound, message: `Could not determine if you have one of the required tools installed on your system: ${requiredTools.join(", ")}` };
          }
          if(!verifyPrerequisites[tool].found()) {
            throw { type: InstallerExceptions.TerminalCommandNotFound, message: verifyPrerequisites[tool].errorMessage() }
          }
        }
        let args = {};
        for(const tool of requiredTools) {
          args[tool] = verifyPrerequisites[tool].path;
        }
        // @ts-ignore
        let logger = vscode.window.createOutputChannel("Installing RR dependencies", "Log");
        logger.show();
        let res = await result.method(args, logger);
        if(res)
          vscode.window.showInformationMessage(res);
      } catch(err) {
        console.log(`[Exception ${err.type}]: ${err.message}`);
        const show_modal_error = (msg) => {
          vscode.window.showErrorMessage(msg, {modal: true});
        };
        switch(err.type) {
          case InstallerExceptions.PackageManagerNotFound:
            show_modal_error(`Could not determine package manager on your system.`);
            break;
          case InstallerExceptions.ModuleImportFailed:
            // eslint-disable-next-line max-len
            if(process.env.hasOwnProperty("VIRTUAL_ENV")) {
              // eslint-disable-next-line max-len
              show_modal_error(`${err.message}. VIRTUAL_ENV was found: if you are running vscode in a python virtual environment this command will not work. Open VSCode in another folder without it and try this command again.`);
            } else {
              // eslint-disable-next-line max-len
              show_modal_error(`${err.message}. You might be running a python virtual environment? Open VSCode without it and run this command again.`);
            }
            break;
          case InstallerExceptions.HTTPDownloadError:
            show_modal_error(`Failed to download ${err.url}. ${err.message}`);
            break;
          case InstallerExceptions.FileWriteError:
            show_modal_error(`Failed to write file ${err.file}. Error: ${err.messsage}`);
            break;
          case InstallerExceptions.InstallServiceFailed:
            show_modal_error(`Installer service exception: ${err.message}`);
            break;
          case InstallerExceptions.UserCancelled:
            vscode.window.showInformationMessage(`You cancelled.`);
            break;
          case InstallerExceptions.PackageManagerError:
            show_modal_error(`Package manager reported failure during install. Exit code: ${err.message}`);
            break;
          case InstallerExceptions.TerminalCommandNotFound:
            show_modal_error(`Pre-requisites not installed on system: ${err.message}`);
          default:
            show_modal_error(`Failed to install RR: ${err.message}`);
            break;
        }
      }
    } else {
      console.log(`no choice picked`);
    }
  }
}

/**
 * Returns latest version and url to the package (without file extension). Append .deb or .rpm to get full url.
 * @param {string | "x86_64" | "i686"} arch
 * @returns {Promise<{version: string, url: string }>}
 */
function resolveLatestVersion(arch) {
  const tag = "/tag/";
  return new Promise((resolve) => {
    const latest_url = "https://github.com/rr-debugger/rr/releases/latest";
    try {
      require("https").get(latest_url, (response) => {
        if (response.statusCode !== 302) {
          throw { type: InstallerExceptions.CouldNotDetermineRRVersion, message: "Could not resolve latest version of RR" };
        } else {
          let redirected = response.headers.location;
          const idx = redirected.lastIndexOf(tag);
          if (idx != -1) {
            const version = redirected.slice(idx + tag.length).split("/")[0];
            resolve({
              version: version,
              url: `https://github.com/rr-debugger/rr/releases/download/${version}/rr-${version}-Linux-${arch}`,
            });
          } else {
            throw { type: InstallerExceptions.CouldNotDetermineRRVersion, message: "Could not resolve latest version of RR" };
          }
        }
      });
    } catch (err) {
      vscode.window.showInformationMessage(`${err.message} falling back on version 5.6`);
      resolve({ version: "5.6.0", url: "https://github.com/rr-debugger/rr/releases/download/5.6.0/" });
    }
  });
}

/**
 * Downloads a file from `url` and saves it as `file_name` in the extension folder.
 * @param {string} url - The url of the file to download
 * @param {string} file_name - Desired file name of download. N.B: without path, Midas resolves its own path.
 * @returns {Promise<{path: string, status: "success" | "cancelled" }>} `path` of saved file and `status` indicates if it
 */
async function http_download(url, file_name) {
  const path = getAPI().get_storage_path_of(file_name);
  if (fs.existsSync(path)) {
    fs.unlinkSync(path);
  }
  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      cancellable: true,
      title: "Downloading",
    },
    (progress, token) =>
      new Promise((resolve, reject) => {
        const output_stream = fs.createWriteStream(path, { flags: "wx" });
        const cleanup = (err, exception) => {
          console.log(`Exception: ${err}`);
          output_stream.close();
          fs.unlinkSync(path);
          return reject(exception);
        };

        const controller = new AbortController();
        const signal = controller.signal;
        signal.addEventListener("abort", () => {
          output_stream.close();
          fs.unlinkSync(path);
          resolve({ path: path, status: "cancelled" });
        });
        const handle_response = (request, response) => {
          if (response.statusCode != 200) {
            // eslint-disable-next-line max-len
            throw { type: InstallerExceptions.HTTPDownloadError, message: `Download error. Server responded with: ${response.statusCode} - ${response.statusMessage}`, url };
          }
          response.pipe(output_stream);
          const file_size = response.headers["content-length"] ?? 0;
          response.on("data", (chunk) => {
            // if github says "nopesies" to sending content-length, due to compression, we'll get no progress here.
            const increment = (chunk.length / +file_size) * 100.0;
            progress.report({ increment: increment, message: `${url}` });
          });
          token.onCancellationRequested(() => {
            controller.abort();
          });
          request.on("error", (err) => {
            cleanup(err, { type: InstallerExceptions.HTTPDownloadError, message: err.message, url });
          });
          output_stream.on("error", (err) => {
            cleanup(err, { type: InstallerExceptions.FileWriteError, message: err.message, file: path });
          });
          output_stream.on("close", () => {
            resolve({ path: path, status: "success" });
          });
        };

        const request = require("https").get(url, { signal: signal }, (response) => {
          if (response.statusCode == 302) {
            let new_request = require("https").get(response.headers.location, { signal: signal }, (res) => {
              handle_response(new_request, res);
            });
          } else if (response.statusCode == 200) {
            handle_response(request, response);
          } else {
            cleanup("Could not resolve redirection for rr source zip",
              { // exception thrown:
                type: InstallerExceptions.HTTPDownloadError,
                message: `Download error. Server responded with: ${response.statusCode} - ${response.statusMessage}`,
                url
              });
          }
        });
      })
  );
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
  strEmpty,
  strValueOr,
  getAPI
};
