const { EventEmitter } = require("events");
const { spawn } = require("child_process");

class DebuggerProcessBase {
  /** @type {EventEmitter} */
  messages;
  /** @type {string} path - the (by config) provided path to the debugger executable. */
  #path;
  /** @type { import("child_process").ChildProcessWithoutNullStreams } */
  #process = null;

  constructor(path, spawnOptions) {
    // save it. For debug purposes, really.
    this.#path = path;
    this.options = spawnOptions;
    try {
      this.#process = spawn(this.path(), this.spawnArgs());
    } catch (ex) {
      console.log(`Creating instance of ${path} failed: ${ex}`);
      // re-throw exception - this must be a hard error
      throw ex;
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
    throw new Error("Derived must implement sendRequest");
  }

  get process() {
    return this.#process;
  }
}

module.exports = {
  DebuggerProcessBase,
};
