const vscode = require("vscode");
var net = require("net");
const EventEmitter = require("events");
const { sudo, which, getExtensionPathOf } = require("./sysutils");

const comms_address = "/tmp/rr-build-progress";

async function initInstaller() {
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
    console.log(`interrupt cmd: ${args.join(" ")}`);
    return await sudo(args, pass);
  };
  const installer = () => {
    return which("python")
      .then((python) => {
        return sudo([python, getExtensionPathOf("modules/python/apt_manager.py")], pass);
      })
      .then((install) => {
        return install;
      });
  };
  let listeners = { download: new EventEmitter(), install: new EventEmitter() };
  let server = net
    .createServer((client) => {
      console.log("creating server...");
      client.setEncoding("utf8");
      client.on("end", () => {});
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
    })
    .listen(comms_address);

  server.on("close", () => {
    console.log(`closing installer services...`);
    try {
      if (require("fs").existsSync(comms_address)) {
        require("fs").unlinkSync(comms_address);
      }
    } catch (err) {
      console.log(`Exception: ${err}`);
    }
  });
  let remaining_download = [];
  let installed_packages = [];
  let processInfo = { pid: 0, ppid: 0 };
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

          listeners.download.on("cancel", (data) => {
            if (data == "start") {
              console.log(`Cancel start begun for download service... waiting for clean up OK`);
            } else if (data == "done") {
              vscode.window.showInformationMessage("Download cancelled - cleaned up");
              server.close((err) => {
                console.log("server closed.");
                if (err) {
                  logger.appendLine("Could not close InstallingManager connection. Remove ");
                }
              });
              resolve();
            }
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

          listeners.install.on("cancel", (data) => {
            if (data == "start") {
              console.log(`Cancel start begun for install service... waiting for clean up OK`);
            } else {
              vscode.window.showInformationMessage("Installation cancelled... Removed installed packages");
              server.close((err) => {
                if (err) {
                  logger.appendLine("Could not close InstallingManager connection. Remove ");
                }
              });
              resolve();
            }
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
