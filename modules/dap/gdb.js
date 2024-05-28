"use strict";
const net = require("node:net");
const { InitializedEvent } = require("@vscode/debugadapter");
const { getExtensionPathOf } = require("../utils/sysutils");
const { serializeRequest, MidasCommunicationChannel } = require("./dap-utils");
const { DebuggerProcessBase } = require("./base-process-handle");
const { MidasSessionBase } = require("./dap-base");

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

  resolveInputDataChannel() {
    return connect_socket(this.name, this.path, MAX_TRIES, 50);
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

  sendRequest(req, args) {
    this.commands_socket.write(serializeRequest(req.seq, req.command, args ?? req.arguments));
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

class GdbDAPSession extends MidasSessionBase {
  constructor(spawnConfig, terminal, checkpointsUI) {
    super(GdbProcess, spawnConfig, terminal, checkpointsUI, null);
  }

  /**
   * @param {import("@vscode/debugprotocol").DebugProtocol.Response} response
   * @param {import("@vscode/debugprotocol").DebugProtocol.InitializeRequestArguments} args
   */
  initializeRequest(response, args) {
    this.dbg
      .initialize()
      .then(() => {
        args["trace"] = this.spawnConfig.trace;
        args["rr-session"] = this.spawnConfig.isRRSession();
        args["rrinit"] = getExtensionPathOf("rrinit");
        super.initializeRequest(response, args);
      })
      .catch((err) => {
        this.sendErrorResponse(response, { id: 0, format: `Failed to connect to DAP server: ${err}` });
        throw err;
      })
      .then(() => {
        let init = new InitializedEvent();
        this.sendEvent(init);
      });
  }

  launchRequest(response, args, request) {
    super.launchRequest(response, request, args);
  }

  attachRequest(response, args, request) {
    args["setupCommands"] = this.spawnConfig.setupCommands;
    super.attachRequest(response, args, request);
  }
}

module.exports = {
  GdbDAPSession,
};
