const vscode = require("vscode");
const { exec, spawn: _spawn, execSync } = require("child_process");
const fs = require("fs");
const Path = require("path");

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
  return new Promise((resolve, reject) =>
    exec(`which ${binary}`, (err, stdout) => {
      if (err) {
        reject(err);
      }
      if (stdout.charAt(stdout.length - 1) == "\n") {
        resolve(stdout.slice(0, stdout.length - 1));
      } else {
        resolve(stdout);
      }
    })
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
      if(err) reject(err);
      try {
        // whereis returns
        // binary: /path/to/first/binary /path/to/second/binary ...
        // therefore, strip `binary:` from output
        const result =
          stdout.toString()
            .substring(binary.length+1)
            .trim()
            .split(" ")
            .filter(s => s != "");
        resolve(result);
      } catch(err) {
        console.log(`could not perform 'whereis': ${err}`);
        reject([]);
      }
    })
  });
}

/**
 * Executes `command` using sudo
 * @param {string[]} command - command to execute in sudo. Command and parameters passed as an array
 * @param {string} pass - password to sudo
 * @returns
 */
async function sudo(command, pass) {
  try {
    let _sudo = await which("sudo");
    const args = ["-S", ...command];
    let sudo = _spawn(_sudo, args, { stdio: "pipe", shell: true });
    sudo.stderr.on("data", (data) => {
      if (data.includes("[sudo]")) {
        sudo.stdin.write(pass + "\n");
      }
    });
    return sudo;
  } catch (e) {
    vscode.window.showErrorMessage("Failed to run install command");
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

module.exports = {
  getExtensionPathOf,
  which,
  whereis,
  sudo,
  resolveCommand,
};
