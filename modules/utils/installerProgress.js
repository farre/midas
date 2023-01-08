const vscode = require("vscode");
var net = require("net");
const EventEmitter = require("events");
const { sudo, which, whereis } = require("./sysutils");
const os = require("os");

const comms_address = "/tmp/rr-build-progress";

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

/**
 * Run depedency/package installer
 * @param {string} repo_type - whether we're using apt or dnf
 * @param {string[]} pkgs - list of depedencies to install
 * @param {boolean} cancellable - Whether or not the install operation can be cancelled
 */
function run_install(repo_type, pkgs, cancellable) {
  return new Promise(async (iresolve, ireject) => {
    let logger = vscode.window.createOutputChannel("Installing RR dependencies", "Log");
    logger.show();
    // eslint-disable-next-line max-len
    let pass = await vscode.window.showInputBox({ prompt: "sudo password", password: true });
    // f*** me extension development for VSCode is buggy. I don't want to have to do this.
    if (!pass) {
      pass = await vscode.window.showInputBox({ prompt: "sudo password", password: true });
    }
    const cancel = async (pid) => {
      let kill = await which("kill");
      const args = [kill, "-s", "SIGUSR1", `${pid}`];
      await sudo(args, pass);
    };

    // starts python installer services application
    const run_installer_services = () => {
      if(!process.env.hasOwnProperty("VIRTUAL_ENV")) {
        return which("python")
          .then((python) => sudo([python, repo_type], pass))
      } else {
        // Means that $VIRTUAL_ENV is set
        // but we need the system-wide installed python to access DNF / APT
        return whereis("python")
          .then(pythons => {
            for(let python of pythons) {
              if(!python.includes(process.env.VIRTUAL_ENV)) {
                return python;
              }
            }
            ireject(`Could not find system install of python. whereis command returned ${pythons.join(" ")}`);
          }).then(python => sudo([python, repo_type], pass));
      }
    };
    let listeners = { download: new EventEmitter(), install: new EventEmitter() };
    const server = create_ipc_server(pkgs, listeners);
    server.listen(comms_address);
    const unlink_unix_socket = () => {
      try {
        if (require("fs").existsSync(comms_address)) {
          require("fs").unlinkSync(comms_address);
        }
      } catch (err) {
        console.log(`Exception: ${err}`);
      }
    };
    server.on("error", (err) => {
      unlink_unix_socket();
      ireject(`Installer services failed with error ${err}`);
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
      console.log(`Download started for ${packages}`);
      remaining_download = packages;
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          cancellable: cancellable,
          title: "Downloading dependencies",
        },
        (reporter, token) => {
          return new Promise((resolve) => {
            listeners.download.on("finish", resolve); // resolve this progress window, but not the installation progress (iresolve)

            token.onCancellationRequested(async () => {
              await cancel(processInfo.pid);
            });

            listeners.download.on("cancel", () => {
              console.log(`Download cancelled`);
              server.close((err) => {
                console.log("server closed.");
                if (err) {
                  logger.appendLine("Could not close InstallingManager connection.");
                }
              });
              ireject("Cancelled installing");
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
        }
      );
    });

    listeners.install.on("start", async () => {
      console.log(`Install started`);
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          cancellable: cancellable,
          title: "Installing dependencies",
        },
        (reporter, canceller) => {
          return new Promise((resolve) => {
            listeners.install.on("finish", () => {
              console.log(`Install finished`);
              server.close((err) => {
                if (err) {
                  logger.appendLine("Could not close InstallingManager connection. Remove ");
                }
              });
              iresolve("Finished installing");
              resolve();
            });
            canceller.onCancellationRequested(async () => {
              await cancel(processInfo.pid);
            });

            listeners.install.on("cancel", () => {
              console.log(`Install cancelled`);
              server.close((err) => {
                if (err) {
                  logger.appendLine("Could not close InstallingManager connection. Remove ");
                }
              });
              ireject("Cancelled installing"); // reject the installer
              resolve(); // resolve the progress window promise
            });

            listeners.install.on("update", (payload) => {
              console.log(`Install update: ${JSON.stringify(payload)}`);
              reporter.report({ message: `Installing ${payload.package}...`, increment: payload.increment });
            });
          });
        }
      );
    });
    await run_installer_services();
  });
}

module.exports = {
  run_install,
};
