// @ts-check
"use strict";
const { MidasCommunicationChannel, UnixSocketCommunication } = require("./dap-utils");
const { DebuggerProcessBase } = require("./base-process-handle");
const { MidasSessionBase } = require("./dap-base");
const { getAPI } = require("../utils/utils");
const { MdbSpawnConfig } = require("../spawn");

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
    return { recv: this.process.stdout, send: this.process.stdin };
  }
}

/**
 * @typedef {Object} DebugMdb
 * @property { boolean | null } recordSession
 * @property { number | null } globalThreadPoolSize
 */

class MdbProcess extends DebuggerProcessBase {
  constructor(options) {
    super(options);
    if (this.options?.debug?.recordSession) {
      const { path: rr } = getAPI().getToolchainConfiguration().rr;
      // Read MDB "documentation" (the source code): the -r CLI parameter, configures the wait system to use signals
      // (instead of waitpid syscall) to work (properly) while being recorded by RR.
      const newOptions = ["record", this.path(), "-r", ...this.options.options];
      try {
        const p = rr;
        this.spawnDebugger(p, newOptions);
      } catch (ex) {
        console.log(`Creating instance of ${this.path()} failed: ${ex}`);
        // re-throw exception - this must be a hard error
        throw ex;
      }
    } else {
      const spawnOptions = [...this.options.options];
      this.spawnDebugger(this.path(), spawnOptions);
    }
    this.socket = new MdbSocket("stdio", this.process, this.messages);
  }

  spawnArgs() {
    return this.options;
  }

  async initialize() {
    await this.socket.connect();
  }

  requestChannel() {
    return this.socket;
  }
}

class MdbChildConnection extends DebuggerProcessBase {
  constructor(options) {
    super(options);
    this.socket = new UnixSocketCommunication(this.path(), this.messages);
  }

  async initialize() {
    await this.socket.connect();
  }

  requestChannel() {
    return this.socket;
  }
}

class MdbSession extends MidasSessionBase {
  constructor(spawnConfig, terminal, checkpointsUI, cleanUp) {
    super(MdbProcess, spawnConfig, terminal, checkpointsUI, null, cleanUp);
    super.configureUserInterfaceFor({
      sessionType: "midas-native",
      singleThreadControl: true,
      nativeMode: true,
      isReplay: this.getConfiguration().isReplay,
    });
  }

  async initializeRequest(response, args) {
    args["RRSession"] = this.getConfiguration().isReplay;
    await this.dbg.initialize();
    super.initializeRequest(response, args);
  }

  attachRequest(response, args, request) {
    const attachArgs = args.attachArguments;
    this.dbg.sendRequest(request, attachArgs);
  }

  /** @returns { MdbSpawnConfig } */
  getConfiguration() {
    if(this.spawnConfig instanceof MdbSpawnConfig ) {
      return this.spawnConfig;
    }
    throw new Error(`Invalid configuration for MdbSession`);
  }
}

class MdbChildSession extends MidasSessionBase {
  constructor(spawnConfig, terminal, cpui) {
    super(MdbChildConnection, spawnConfig, terminal, cpui, null, null);
  }

  initializeRequest(response, args) {
    this.dbg.initialize().then(() => {
      this.dbg.sendRequest({ seq: response.request_seq, command: response.command }, args);
    });
  }

  attachRequest(response, args, request) {
    // we don't actually attach. We're already attached!
    this.sendResponse(response);
  }
}

module.exports = {
  MdbSession,
  MdbChildSession,
};
