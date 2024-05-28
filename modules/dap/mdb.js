"use strict";
const { serializeRequest, MidasCommunicationChannel } = require("./dap-utils");
const { DebuggerProcessBase } = require("./base-process-handle");
const { MidasSessionBase } = require("./dap-base");

class MdbSocket extends MidasCommunicationChannel {
  constructor(name, process, emitter) {
    super(name, emitter);
    this.name = name;
    this.emitter = emitter;
    this.process = process;
  }

  async resolveInputDataChannel() {
    return this.process.stdout;
  }
}

class MdbProcess extends DebuggerProcessBase {
  constructor(path, options) {
    super(path, options);
  }

  async initialize() {
    // no-op
  }

  dataChannel() {
    return this.process.stdout;
  }

  sendRequest(req, args) {
    this.process.stdin.write(serializeRequest(req.seq, req.command, args ?? req.arguments));
  }
}

class MdbSession extends MidasSessionBase {
  constructor(spawnConfig, terminal, checkpointsUI) {
    super(MdbProcess, spawnConfig, terminal, checkpointsUI, null);
  }
}

module.exports = {
  MdbSession,
};
