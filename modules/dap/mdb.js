// @ts-check
"use strict";
const { serializeRequest, MidasCommunicationChannel } = require("./dap-utils");
const { DebuggerProcessBase } = require("./base-process-handle");
const DAP = require("./dap-base");
const { CustomRequests } = require("../debugSessionCustomRequests");
const { getAPI } = require("../utils/utils");

class MdbSocket extends MidasCommunicationChannel {
  /** @type {import("child_process").ChildProcessWithoutNullStreams} */
  process;

  constructor(name, process, emitter) {
    super(name, emitter);
    this.name = name;
    this.emitter = emitter;
    this.process = process;
  }

  /**
   * @returns { Promise<import("./dap-utils").DataChannel> }
   */
  async resolveInputDataChannel() {
    return {recv: this.process.stdout, send: this.process.stdin }
  }
}

/**
 * @typedef {Object} DebugMdb
 * @property { boolean | null } recordSession
 * @property { number | null } globalThreadPoolSize
 */

class MdbProcess extends DebuggerProcessBase {
  /**
   * Constructs a MdbProcess of DebuggerProcessBase which is used to execute the actual debugger binary and communicate with it
   * using the `sendRequest` interface.
   * @param { string } path
   * @param { string[] } options
   * @param { DebugMdb | null } debug
   */
  constructor(path, options, debug) {
    if (debug?.recordSession) {
      const { path: rr } = getAPI().getToolchain().rr;
      // Read MDB "documentation" (the source code): the -r CLI parameter, configures the wait system to use signals
      // (instead of waitpid syscall) to work (properly) while being recorded by RR.
      const newOptions = [ "record", path, "-r", ...options ];
      super(rr, newOptions, debug);
    } else {
      super(path, options, debug);
    }
    this.socket = new MdbSocket("stdio", this.process, this.messages);
  }

  async initialize() {
    await this.socket.connect();
  }

  requestChannel() {
    return this.socket;
  }
}

class MdbSession extends DAP.MidasSessionBase {
  constructor(spawnConfig, terminal, checkpointsUI) {
    super(MdbProcess, spawnConfig, terminal, checkpointsUI, {
      // callbacks
      response: (res) => {
        console.log(`response from debugger: ${JSON.stringify(res, null, 2)}`)
        if (!res.success) {
          const err = (res.body.error ?? { stacktrace: "No stack trace info" }).stacktrace;
          console.log(`[request error]: ${res.command} failed\n${err}`);
        }
        switch (res.command) {
          case CustomRequests.DeleteCheckpoint:
          case CustomRequests.SetCheckpoint:
            this.updateCheckpointsView(res.body.checkpoints);
            break;
          case "initialize":
            this.sendResponse(res);
            return;
          default:
            break;
        }
        this.sendResponse(res);
      },
      events: null,
    });
  }

  setFunctionBreakPointsRequest(response, args, request) {
    if(this.spawnConfig)
      this.sendResponse(response);
  }

  async initializeRequest(response, args) {
    await this.dbg.initialize();
    super.initializeRequest(response, args);
  }
}

module.exports = {
  MdbSession,
};
