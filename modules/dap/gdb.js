"use strict";
const { InitializedEvent } = require("@vscode/debugadapter");
const { getExtensionPathOf } = require("../utils/sysutils");
const { UnixSocketCommunication } = require("./dap-utils");
const { DebuggerProcessBase } = require("./base-process-handle");
const { MidasSessionBase } = require("./dap-base");
const { spawn } = require("child_process");

class GdbProcess extends DebuggerProcessBase {

  /** @type { import("child_process").ChildProcessWithoutNullStreams } */
  #process = null;
  constructor(options) {
    super(options);

    try {
      const p = this.path();
      const args = this.spawnArgs();
      this.#process = spawn(p, args);
    } catch (ex) {
      console.log(`Creating instance of GdbProcess failed: ${ex}`);
      // re-throw exception - this must be a hard error
      throw ex;
    }

    this.commands_socket = new UnixSocketCommunication("/tmp/midas-commands", this.messages)
    this.events_socket = new UnixSocketCommunication("/tmp/midas-events", this.messages);
  }

  async initialize() {
    await this.commands_socket.connect();
    await this.events_socket.connect();
  }

  requestChannel() {
    return this.commands_socket;
  }

  /** overridden */
  spawnArgs() {
    const args = [
      ...this.options.options,
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
    const cleanUpEmitter = null
    super(GdbProcess, spawnConfig, terminal, checkpointsUI, null, cleanUpEmitter);
  }

  initializeRequest(response, args) {
    this.dbg.initialize().then(async () => {
      args["trace"] = this.spawnConfig.trace;
      args["rr-session"] = this.spawnConfig.isRRSession();
      args["rrinit"] = getExtensionPathOf("rrinit");
      const res = await this.dbg.waitableSendRequest(
        { seq: 1, command: "initialize", arguments: args, type: "request" },
        args,
      );
      this.sendResponse(res);
      this.sendEvent(new InitializedEvent());
    });
  }

  attachRequest(response, args, request) {
    args["setupCommands"] = this.spawnConfig.setupCommands;
    super.attachRequest(response, args, request);
  }
}

module.exports = {
  GdbDAPSession,
};
