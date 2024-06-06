const { EventEmitter } = require("events");
const { serializeRequest } = require("./dap-utils");
const fs = require("fs")

/**
 * @typedef {import("@vscode/debugprotocol").DebugProtocol.Request } DAPRequest
 * @typedef {import("@vscode/debugprotocol").DebugProtocol.Response } DAPResponse
 */

// Represents the type that actually communicates with the debugger, e.g. via stdio or sockets
// Some derived types may spawn a debugger process, some may just connect to a socket. It's up to the derived type.
class DebuggerProcessBase {
  /** @type {EventEmitter} */
  messages;

  constructor(options) {
    this.options = options
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

  path() {
    if(this.options.path == null) {
      throw new Error(`No path to debugger process provided`);
    }
    if(!fs.existsSync(this.options.path)) {
      throw new Error(`${this.options.path} doesn't exist`);
    }
    return this.options.path;
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
}

module.exports = {
  DebuggerProcessBase,
};
