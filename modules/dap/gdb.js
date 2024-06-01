"use strict";
const net = require("node:net");
const { InitializedEvent } = require("@vscode/debugadapter");
const { getExtensionPathOf } = require("../utils/sysutils");
const { serializeRequest, MidasCommunicationChannel } = require("./dap-utils");
const { DebuggerProcessBase } = require("./base-process-handle");
const DAP = require("./dap-base");

const MAX_TRIES = 10;
function connect_socket(name, path, attempts, attempt_interval) {
  return new Promise((res, rej) => {
    const socket = new net.Socket();
    socket.connect({ path: path });

    socket.on("connect", () => {
      res(socket);
    });

    socket.on("error", (error) => {
      socket.destroy();

      if (attempts === 0) {
        rej(error);
      } else {
        setTimeout(() => {
          connect_socket(name, path, attempts - 1, attempt_interval + 50)
            .then(res)
            .catch(rej);
        }, attempt_interval);
      }
    });
  });
}

class GdbSocket extends MidasCommunicationChannel {
  constructor(name, path, type, emitter) {
    super(name, emitter);
    this.name = name;
    this.path = path;
    this.type = type;
  }

  /**
   * @returns { Promise<import("./dap-utils").DataChannel> }
  */
  async resolveInputDataChannel() {
    const sock = await connect_socket(this.name, this.path, MAX_TRIES, 50);
    return { recv: sock, send: sock };
  }
}

class GdbProcess extends DebuggerProcessBase {
  constructor(path, options) {
    super(path, options);

    this.commands_socket = new GdbSocket("commands", "/tmp/midas-commands", "response", this.messages);
    this.events_socket = new GdbSocket("events", "/tmp/midas-events", "event", this.messages);
  }

  async initialize() {
    await this.commands_socket.connect();
    await this.events_socket.connect();
  }

  requestChannel() {
    return this.commands_socket
  }

  /** overridden */
  spawnArgs() {
    const args = [
      ...this.options,
      "-q",
      "-ex",
      `source ${getExtensionPathOf("/modules/python/dap-wrapper/variables_reference.py")}`,
      "-ex",
      `source ${getExtensionPathOf("/modules/python/dap-wrapper/dap.py")}`,
    ];
    return args;
  }
}

class GdbDAPSession extends DAP.MidasSessionBase {
  constructor(spawnConfig, terminal, checkpointsUI) {
    super(GdbProcess, spawnConfig, terminal, checkpointsUI, null);
  }

  initializeRequest(response, args) {
    this.dbg.initialize().then(async () => {
      args["trace"] = this.spawnConfig.trace;
      args["rr-session"] = this.spawnConfig.isRRSession();
      args["rrinit"] = getExtensionPathOf("rrinit");
      const res = await this.dbg.waitableSendRequest({ seq: 1, command: "initialize", arguments: args, type: "request"}, args);
      this.sendResponse(res);
      this.sendEvent(new InitializedEvent());
    })
  }

  attachRequest(response, args, request) {
    args["setupCommands"] = this.spawnConfig.setupCommands;
    super.attachRequest(response, args, request);
  }
}

module.exports = {
  GdbDAPSession,
};
