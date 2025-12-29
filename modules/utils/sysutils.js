const vscode = require("vscode");
const { exec, spawn: _spawn, execSync } = require("child_process");
const fsp = require("fs/promises");
const fs = require("fs");
const Path = require("path");
const { consoleErr } = require("./log");

/**
 * Returns a full constructed path of `fileOrDir` inside the extension directory.
 * Data found in this directory is not persistent and is removed on updates. Do not rely on persistent storage here.
 * Use APIManager.getExtensionGlobalStorage instead.
 * @param {string} fileOrDir
 * @returns { string }
 */
function getExtensionPathOf(fileOrDir = null) {
  if (fileOrDir != null) {
    if (fileOrDir[0] == "/") {
      fileOrDir = fileOrDir.substring(1);
    }
    return vscode.extensions.getExtension("farrese.midas").extensionPath + `/${fileOrDir}`;
  } else {
    return vscode.extensions.getExtension("farrese.midas").extensionPath;
  }
}

/**
 * Resolves full path to binary by using shell `which` command.
 * @param {string} binary
 * @returns {Promise<string>}
 */
function which(binary) {
  return new Promise((resolve) =>
    exec(`which ${binary}`, (err, stdout) => {
      if (err) {
        resolve("");
      }
      if (stdout.charAt(stdout.length - 1) == "\n") {
        resolve(stdout.slice(0, stdout.length - 1));
      } else {
        resolve(stdout);
      }
    }),
  );
}

/**
 * Returns where `binary` exists. Can return items which are not executable binaries.
 * @param { string } binary
 * @returns { Promise<string[]> }
 */
function whereis(binary) {
  return new Promise((resolve, reject) => {
    exec(`whereis ${binary}`, (err, stdout) => {
      if (err) reject(err);
      try {
        // whereis returns
        // binary: /path/to/first/binary /path/to/second/binary ...
        // therefore, strip `binary:` from output
        const result = stdout
          .toString()
          .substring(binary.length + 1)
          .trim()
          .split(" ")
          .filter((s) => s != "");
        resolve(result);
      } catch (err) {
        consoleErr(`could not perform 'whereis': ${err}`);
        reject([]);
      }
    });
  });
}

/**
 * Executes `command` using sudo
 * @param {string[]} command - command to execute in sudo. Command and parameters passed as an array
 * @param {string} pass - password to sudo
 * @param {(...args: any[]) => void} exitCodeCallback - callback that runs on process exit
 * @returns
 */
async function sudo(command, pass, exitCodeCallback = null) {
  try {
    let _sudo = await which("sudo");
    const args = ["-S", ...command];
    let sudo = _spawn(_sudo, args, { stdio: "pipe", shell: true, env: sanitizeEnvVariables() });
    sudo.on("error", () => {
      throw new Error(`Sudo failed`);
    });
    if (exitCodeCallback != null) {
      sudo.on("exit", exitCodeCallback);
    }
    sudo.stderr.on("data", (data) => {
      if (data.includes("[sudo]")) {
        sudo.stdin.write(pass + "\n");
      }
    });
    return sudo;
  } catch (e) {
    vscode.window.showErrorMessage(`Failed to run sudo command ${command}`);
  }
}

/**
 * Resolve a symlink to where it points to. `fully` sets if
 * it should be resolved fully (i.e, if it's a symlink to a symlink etc
 * follow the entire chain to it's end).
 */
function resolveCommand(cmd) {
  if (fs.existsSync(cmd)) {
    return fs.realpathSync(cmd);
  }
  const whereis = execSync(`whereis ${cmd}`);
  const parts = whereis.toString().split(" ");
  if (parts.length < 2) {
    throw new Error(`${cmd} could not be resolved`);
  }
  for (const result of parts.slice(1)) {
    if (Path.basename(result) == cmd) {
      return result;
    }
  }
  throw new Error(`${cmd} could not properly be resolved. Try providing a fully qualified path`);
}

function sanitizeEnvVariables() {
  let ENV_VARS = { ...process.env };
  if (ENV_VARS.VIRTUAL_ENV != null) {
    ENV_VARS.PATH = ENV_VARS.PATH.replaceAll(ENV_VARS.VIRTUAL_ENV.toString(), "");
  }
  return ENV_VARS;
}

/**
 * @returns {Promise<{detail: string, label: string, alwaysShow: boolean, pid: string}[]>}
 */
async function getAllPidsForQuickPick() {
  const res = (await fsp.readdir("/proc", { withFileTypes: true }))
    .filter((dirent) => {
      try {
        if (!dirent.isDirectory()) return false;
        const number = Number.parseInt(dirent.name);
        return number.toString() == dirent.name;
      } catch (ex) {
        return false;
      }
    })
    .map(async (dirent) => {
      return await fsp.readFile(`/proc/${dirent.name}/cmdline`).then((buf) => {
        const label = buf.toString().replace("\u0000", " ");

        return {
          detail: dirent.name,
          label: `${label} (${dirent.name})`,
          alwaysShow: true,
          pid: dirent.name,
        };
      });
    });
  return Promise.all(res);
}

module.exports = {
  getExtensionPathOf,
  which,
  whereis,
  sudo,
  resolveCommand,
  sanitizeEnvVariables,
  getAllPidsForQuickPick,
};
