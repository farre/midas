const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const { serializeRequest } = require("./dap-utils");

/**
 * @typedef {import("@vscode/debugprotocol").DebugProtocol.Request } DAPRequest
 * @typedef {import("@vscode/debugprotocol").DebugProtocol.Response } DAPResponse
 */

class DebuggerProcessBase {
  /** @type {EventEmitter} */
  messages;
  /** @type {string} path - the (by config) provided path to the debugger executable. */
  #path;
  /** @type { import("child_process").ChildProcessWithoutNullStreams } */
  #process = null;

  constructor(path, spawnOptions, debug) {
    // save it. For debug purposes, really.
    this.#path = path;
    this.options = spawnOptions;
    this.debug = debug;
    try {
      const p = this.path();
      const args = this.spawnArgs();
      this.#process = spawn(p, args);
    } catch (ex) {
      console.log(`Creating instance of ${path} failed: ${ex}`);
      // re-throw exception - this must be a hard error
      throw ex;
    }

    // @ts-ignore
    if (this.requestChannel === undefined) {
      throw new Error(`Derived type haven't provided 'comms' channel for which we send requests/recv responses over`);
    }

    this.messages = new EventEmitter();
  }

  // Override by derived type.
  async initialize() {
    throw new Error("initialize must be overriden by derived type");
  }

  /**
   * Overridden by derived types when needed
   * @returns {string} - (possibly processed) path to debugger executable.
   */
  path() {
    return this.#path;
  }

  /**
   * Overridden by derived types when needed
   * @returns { string[] }
   */
  spawnArgs() {
    return this.options;
  }
  /**
   * @param {(response: import("./dap-base").Response) => void} cb
   */
  connectResponse(cb) {
    this.messages.on("response", cb);
  }

  /**
   * @param {(response: import("./dap-base").Event) => void} cb
   */
  connectEvents(cb) {
    this.messages.on("event", cb);
  }

  sendRequest(req, args) {
    const output = serializeRequest(req.seq, req.command, args ?? req.arguments);
    this.requestChannel().write(output);
  }

  /**
   * Callee can `await` on .waitableSendRequest(...)  for the response
   * @param { import("./base-process-handle").DAPRequest } req
   * @param {*} args
   * @returns { Promise<import("./base-process-handle").DAPResponse> }
   */
  waitableSendRequest(req, args) {
    return new Promise((resolve, reject) => {
      this.messages.once(`${req.seq}`, (response) => {
        resolve(response);
      });
      try {
        this.sendRequest(req, args);
      } catch (ex) {
        reject(ex);
      }
    });
  }

  get process() {
    return this.#process;
  }
}

module.exports = {
  DebuggerProcessBase,
};
