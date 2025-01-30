const vscode = require("vscode");
var net = require("net");
const EventEmitter = require("events");
const { sudo, which } = require("./sysutils");
const os = require("os");
const { existsSync, unlinkSync } = require("fs");
const { getAPI } = require("./utils");

const InstallerExceptions = {
  PackageManagerNotFound: "PkgManNotFound",
  ModuleImportFailed: "ModuleImportFailed",
  CouldNotDetermineRRVersion: "CouldNotDetermineRRVersion",
  HTTPDownloadError: "HTTPDownloadError",
  FileWriteError: "FileWriteError",
  InstallServiceFailed: "InstallServiceFailed",
  UserCancelled: "UserCancelled",
  PackageManagerError: "PackageManagerError",
  TerminalCommandNotFound: "TerminalCommandNotFound",
};

const INSTALLER_IPC_ADDRESS = "/tmp/rr-build-progress";

function prepare_request(deps) {
  const endinanness = os.endianness();
  const payload = deps.join(" ");
  const payload_length = new Int32Array(1);
  payload_length[0] = Buffer.byteLength(payload, "utf-8");
  const len = Buffer.alloc(4);
  if (endinanness == "BE") {
    len.writeUInt32BE(payload_length[0]);
  } else {
    len.writeUInt32LE(payload_length[0]);
  }
  const packet_size = new Uint8Array(4);
  packet_size[0] = len[0];
  packet_size[1] = len[1];
  packet_size[2] = len[2];
  packet_size[3] = len[3];
  return { packet_size: packet_size, payload: payload };
}

function handle_payload(listeners, comms_payload) {
  listeners[comms_payload.action].emit(comms_payload.type, comms_payload.data);
}

/**
 * Creates IPC server (unix socket) that communicates with Python scripts
 * @param { string[] } pkgs - list of packages to request install or check if dependencies are met
 * @param { { download: EventEmitter, install: EventEmitter } } listeners - listeners that handle the logic of processed IPC payloads
 * @returns
 */
function create_ipc_server(pkgs, listeners) {
  if (existsSync(INSTALLER_IPC_ADDRESS)) {
    unlinkSync(INSTALLER_IPC_ADDRESS);
  }
  let client_number = 0;
  return net.createServer((client) => {
    if (client_number == 1) {
      const { packet_size, payload } = prepare_request(pkgs);
      client.write(packet_size);
      client.setEncoding("utf8");
      client.write(payload);
    }
    client_number += 1;
    client.setEncoding("utf8");
    let overlap_buffer = "";
    client.on("data", (socket_payload) => {
      let str = socket_payload.toString();
      if (overlap_buffer.length > 0) {
        str = overlap_buffer.concat(str);
        overlap_buffer = "";
      }
      let payloads = str.split("\n");
      for (const message_payload of payloads) {
        try {
          const json = JSON.parse(message_payload);
          handle_payload(listeners, json);
        } catch (e) {
          overlap_buffer = message_payload;
        }
      }
    });
  });
}

async function getSudoPassword() {
  let pass = await vscode.window.showInputBox({ prompt: "input your sudo password", password: true });
  // f*** me extension development for VSCode is buggy. I don't want to have to do this.
  if (!pass) {
    pass = await vscode.window.showInputBox({ prompt: "input your sudo password", password: true });
  }
  return pass;
}

async function cancelInstaller(password, pid) {
  let kill = await which("kill");
  const args = [kill, "-s", "SIGUSR1", `${pid}`];
  await sudo(args, password);
}

/**
 * Run depedency/package installer. Installs `packages` on system using either DNF or APT
 * @param {string} repoType - whether we're using apt or dnf
 * @param {string[]} packages - list of depedencies to install
 * @param {boolean} cancellable - Whether or not the install operation can be cancelled
 * @param {import("vscode").OutputChannel} logger
 * @returns { Promise<boolean> } returns a promise of a boolean that says if we finished successfully
 */
function systemInstall(repoType, packages, cancellable, logger) {
  return new Promise(async (installResolve, installReject) => {
    // if some server logic fails, we don't want to actually run the python code
    let error_or_finished = false;
    // eslint-disable-next-line max-len
    let pass = await getSudoPassword();
    if (!pass) {
      installReject(`Installing dependencies require sudo`);
    }

    // starts python installer services application
    const run_installer_services = () => {
      getAPI().getPython().sudoExecute([repoType], pass);
    };
    let listeners = { download: new EventEmitter(), install: new EventEmitter() };
    const server = create_ipc_server(packages, listeners);
    if (existsSync(INSTALLER_IPC_ADDRESS)) {
      unlinkSync(INSTALLER_IPC_ADDRESS);
    }
    server.listen(INSTALLER_IPC_ADDRESS);
    const unlink_unix_socket = () => {
      error_or_finished = true;
      try {
        if (require("fs").existsSync(INSTALLER_IPC_ADDRESS)) {
          require("fs").unlinkSync(INSTALLER_IPC_ADDRESS);
        }
      } catch (err) {
        logger.appendLine(`Exception: ${err}`);
      }
    };
    server.on("error", (err) => {
      unlink_unix_socket();
      installReject(`Installer service failed: ${err}`);
    });
    server.on("close", unlink_unix_socket);
    server.on("drop", unlink_unix_socket);

    let remaining_download = [];
    let installed_packages = [];
    let processInfo = { pid: 0, ppid: 0 };
    listeners.install.on("setup", (payload) => {
      processInfo = payload;
    });

    listeners.download.on("setup", (payload) => {
      processInfo = payload;
    });
    // eslint-disable-next-line no-unused-vars
    listeners.download.on("start", async ({ packages, bytes }) => {
      logger.appendLine(`Download started for ${packages}`);
      remaining_download = packages;
      await vscode.window
        .withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            cancellable: cancellable,
            title: "Downloading dependencies",
          },
          (reporter, token) => {
            return new Promise((resolve) => {
              const wasCancelled = true;
              listeners.download.on("finish", () => {
                resolve(!wasCancelled); // download was not cancelled
              }); // resolve this progress window, but not the installation progress (iresolve)

              token.onCancellationRequested(async () => {
                await cancelInstaller(pass, processInfo.pid);
              });

              listeners.download.on("cancel", () => {
                logger.appendLine(`Download cancelled`);
                server.close((err) => {
                  logger.appendLine("server closed.");
                  if (err) {
                    logger.appendLine("Could not close InstallingManager connection.");
                  }
                });
                resolve(wasCancelled);
              });

              listeners.download.on("done", ({ done }) => {
                installed_packages.push(done);
                logger.appendLine(`Downloading of ${done} - done`);
                remaining_download = remaining_download.filter((pkg_name) => pkg_name != done);
                reporter.report({ message: remaining_download.join(", ") });
              });

              // eslint-disable-next-line no-unused-vars
              listeners.download.on("update", ({ bytes, progress, increment }) => {
                console.log(`Download update: ${bytes} bytes. Increment: ${increment}`);
                reporter.report({
                  increment: increment,
                  message: remaining_download.join(", "),
                });
              });
            });
          },
        )
        .then((wasCancelled) => {
          if (wasCancelled) {
            installResolve(false);
          }
        });
    });

    listeners.install.on("start", async () => {
      logger.appendLine(`Install started`);
      await vscode.window
        .withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            cancellable: cancellable,
            title: "Installing dependencies",
          },
          (reporter, canceller) => {
            return new Promise((resolve) => {
              listeners.install.on("finish", () => {
                logger.appendLine(`Install finished`);
                server.close((err) => {
                  if (err) {
                    logger.appendLine("Could not close InstallingManager connection. Remove ");
                  }
                });
                resolve(true);
              });
              canceller.onCancellationRequested(async () => {
                await cancelInstaller(pass, processInfo.pid);
              });

              listeners.install.on("cancel", () => {
                logger.appendLine(`Install cancelled`);
                server.close((err) => {
                  if (err) {
                    logger.appendLine("Could not close InstallingManager connection. Remove ");
                  }
                });
                resolve(false); // user cancelled
              });

              listeners.install.on("update", (payload) => {
                console.log(`Install update: ${JSON.stringify(payload)}`);
                reporter.report({ message: `Installing ${payload.package}...`, increment: payload.increment });
              });
            });
          },
        )
        .then((result) => {
          installResolve(result);
        });
    });
    if (!error_or_finished) await run_installer_services();
  });
}

module.exports = {
  systemInstall,
  InstallerExceptions,
};
