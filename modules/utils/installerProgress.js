const vscode = require("vscode");
var net = require("net");
const EventEmitter = require("events");
const { resolve } = require("path");

const comms_address = "/tmp/rr-build-progress";

class DependencyInstaller {
  packages = [];
  required_download = 0;
  installed = [];
  failed = [];
  download_progress = null;
  install_progress = null;
  server;
  completed = false;
  /** @type {{download: EventEmitter, install: EventEmitter} } */
  listeners = { download: null, install: null };
  /** @type {vscode.OutputChannel} */
  logger;
  getProgress() {
    return this.download_progress;
  }

  /**
   * @param {vscode.OutputChannel} logger
   */
  constructor(logger) {
    this.logger = logger;
    this.listeners["download"] = new EventEmitter();
    this.listeners["install"] = new EventEmitter();

    this.remaining_download = [];
    this.listeners.download.on("start", ({ packages, bytes }) => {
      console.log(`start downloading... ${packages.join(", ")}`);
      this.logger.appendLine(`start downloading... ${packages.join(", ")}`);
      this.download_progress = vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          cancellable: true,
          title: "Installing dependencies",
        },
        (reporter, token) => {
          let p = new Promise((resolve) => {
            let bytes_total = 0;
            let msg = (bytes, packages) => {
              if (packages.length > 1) return `Downloaded ${bytes} bytes\nRemaining pkgs: ${packages.join(", ")}`;
              else return `$Downloaded ${bytes} bytes\nRemaining: ${packages[0] ?? "None"}`;
            };

            token.onCancellationRequested((comms) => {
              if (!comms) {
                vscode.window.showInformationMessage("NOT YET IMPLEMENTED TO CANCEL INSTALL");
              } else {
                comms.send_cancel();
              }
            });

            this.listeners.download.on("done", ({ done }) => {
              logger.appendLine(`Downloading of package ${done} - done`);
              this.remaining_download = this.remaining_download.filter((pkg_name) => pkg_name != done);
              reporter.report({ message: msg(bytes_total, this.remaining_download) });
            });

            this.listeners.download.on("update", ({ bytes, progress, increment }) => {
              bytes_total = bytes;
              reporter.report({
                increment: increment,
                message: msg(bytes, this.remaining_download),
              });
            });

            this.listeners.download.on("finish", (payload) => {
              logger.appendLine(`Finished downloading packages ${this.packages}`);
              vscode.window.showInformationMessage(`Downloaded ${payload.bytes}`);
              this.completed = true;
              resolve();
            });
          });
          return p;
        }
      );
    });
    this.server = net.createServer((client) => {
      logger.appendLine("Creating server...");
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
            this.handle_payload(json);
          } catch (e) {
            console.log(`Error: ${e}`);
            vscode.window.showErrorMessage(e);
            overlap_buffer = message_payload;
          }
        }
      });
    });

    this.server.on("connection", () => {
      logger.appendLine("Client connected");
    });
    logger.appendLine("Listening on " + comms_address);
    this.server.listen(comms_address);
    this.server.on("close", () => {
      logger.appendLine("Closed server");
      require("fs").unlink(comms_address, (err) => {
        if (err) {
          vscode.window.showErrorMessage(
            `Failed to close Unix socket at path "${comms_address}" - be sure to delete it`
          );
        }
      });
    });
  }

  /**
   * @param {object} json
   */
  handle_payload(json) {
    switch (json["type"]) {
      case "conffile":
        break;
      case "error":
        break;
      case "processing":
        // ignore processing, we're just interested in progress, leave this if additional meta data want to be processed
        break;
      case "dpkg":
        break;
      case "start":
        if (json["action"] == "download") {
          this.packages = json.data.packages;
          this.remaining_download = this.packages;
          this.required_download = json.data.bytes;
          this.listeners.download.emit("start", json.data);
        } else if (json["action"] == "install") {
          this.listeners.install.emit("start");
        }
        break;
      case "finish":
        if (json["action"] == "download") {
          this.listeners.download.emit("finish", json["data"]);
        } else if (json["action"] == "install") {
          this.listeners.install.emit("finish");
        }
        break;
      case "done":
        this.listeners.download.emit("done", json["data"]);
        break;
      case "update":
        if (json["action"] == "download") {
          this.listeners.download.emit("update", json["data"]);
        } else if (json["action"] == "install") {
          this.listeners.install.emit("update", json["data"]);
        }
        break;
    }
  }
}

module.exports = {
  DependencyInstaller,
};
