const vscode = require("vscode");
var net = require("net");
const EventEmitter = require("events");
const { sudo, which } = require("./sysutils");
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

/**
 *
 * @param {string} repo_type - whether we're using apt or dnf
 * @param {string[]} pkgs -
 */
async function initInstaller(repo_type, pkgs) {
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
    return await sudo(args, pass);
  };
  const installer = () => {
    return which("python")
      .then((python) => {
        return sudo([python, repo_type], pass);
      })
      .then((install) => {
        return install;
      });
  };
  let listeners = { download: new EventEmitter(), install: new EventEmitter() };
  let client_number = 0;
  let server = net.createServer((client) => {
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
          console.log(`Error: ${e}`);
          vscode.window.showErrorMessage(e);
          overlap_buffer = message_payload;
        }
      }
    });
  });
  server.listen(comms_address);
  const unlink_unix_socket = () => {
    console.log(`closing installer services...`);
    try {
      if (require("fs").existsSync(comms_address)) {
        require("fs").unlinkSync(comms_address);
      }
    } catch (err) {
      console.log(`Exception: ${err}`);
    }
  };
  server.on("error", unlink_unix_socket);
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
    remaining_download = packages;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        cancellable: true,
        title: "Downloading dependencies",
      },
      (reporter, token) => {
        let p = new Promise((resolve) => {
          const msg = (packages) => {
            if (packages.length > 1) return `${packages.join(", ")}`;
            else return `${packages[0] ?? "???"}`;
          };

          token.onCancellationRequested(async () => {
            // todo(simon): implement cancelling
            await cancel(processInfo.pid);
          });

          listeners.download.on("cancel", () => {
            vscode.window.showInformationMessage("Download cancelled - cleaned up");
            server.close((err) => {
              console.log("server closed.");
              if (err) {
                logger.appendLine("Could not close InstallingManager connection. Remove ");
              }
            });
            resolve();
          });

          listeners.download.on("done", ({ done }) => {
            installed_packages.push(done);
            logger.appendLine(`Downloading of ${done} - done`);
            remaining_download = remaining_download.filter((pkg_name) => pkg_name != done);
            reporter.report({ message: msg(remaining_download) });
          });

          // eslint-disable-next-line no-unused-vars
          listeners.download.on("update", ({ bytes, progress, increment }) => {
            reporter.report({
              increment: increment,
              message: msg(remaining_download),
            });
          });

          listeners.download.on("finish", (payload) => {
            vscode.window.showInformationMessage(`Downloaded ${payload.bytes}`);
            resolve();
          });
        });
        return p;
      }
    );
  });

  listeners.install.on("start", async () => {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        cancellable: true,
        title: "Installing dependencies",
      },
      (reporter, canceller) => {
        let p = new Promise((resolve) => {
          canceller.onCancellationRequested(async () => {
            // todo(simon): implement cancelling
            await cancel(processInfo.pid);
          });

          listeners.install.on("update", (payload) => {
            reporter.report({ message: `Installing ${payload.package}...`, increment: payload.increment });
          });

          listeners.install.on("cancel", () => {
            vscode.window.showInformationMessage("Installation cancelled... Removed installed packages");
            server.close((err) => {
              if (err) {
                logger.appendLine("Could not close InstallingManager connection. Remove ");
              }
            });
            resolve();
          });

          listeners.install.on("finish", () => {
            vscode.window.showInformationMessage(`Finished installing: ${installed_packages.join(" ")}`);
            server.close((err) => {
              if (err) {
                logger.appendLine("Could not close InstallingManager connection. Remove ");
              }
            });
            resolve();
          });
        });
        return p;
      }
    );
  });
  await installer();
}

function handle_payload(listeners, comms_payload) {
  listeners[comms_payload.action].emit(comms_payload.type, comms_payload.data);
}

module.exports = {
  initInstaller,
};
