"use strict";
// pull in EventEmitter, which DebugInterface extends
// it is through this, we dispatch communication between VSCode and GDB/MI
const { EventEmitter } = require("events");
const { GDB } = require("gdb-js");
const gdbNs = require("gdb-js");
const regeneratorRuntime = require("regenerator-runtime");
const gdbTypes = require("./gdbtypes");
const { spawn } = require("./spawner");

const WatchPointType = {
  ACCESS: "-a",
  READ: "-r",
  WRITE: "",
};

/**
 * QueriedTypesMap stores types and their members, so if the user is trying to dive down into an object
 * instead of querying GDB every time for it's member, we memoize them and can thus request all member variables directly
 */
class QueriedTypesMap {
  /** @type { Map<string, string[]> } */
  static #types = new Map();

  /**
   * Returns the members of a C++ class or struct type
   * @param {string} type - type to get members for
   * @returns an array of all the members `type` contains
   */
  static get_members(type) {
    return QueriedTypesMap.#types.get(type);
  }

  /**
   * Returns the members of a C++ class or struct type
   * @param {string} type - type to get members for
   * @returns an array of all the members `type` contains
   */
  static record_type(type, members) {
    QueriedTypesMap.#types.set(type, members);
  }
}

class GDBInterface extends EventEmitter {
  #gdb;
  stoppedAtEntry;
  /** Maps file paths -> Breakpoints
   * @type { Map<number, gdbTypes.Breakpoint> } */
  #breakpoints;

  #loadedLibraries;

  constructor(binary) {
    super();
    this.stoppedAtEntry = false;
    this.#breakpoints = new Map();
  }

  /** Starts debugging of executable `program`
   * @param { string} program
   * @param { boolean } stopOnEntry
   * @param { boolean } debug
   */
  async start(program, stopOnEntry, debug) {
    let gdb_process = spawn("gdb", ["-i=mi3", program]);
    this.#gdb = new GDB(gdb_process);
    if (stopOnEntry) {
      this.stoppedAtEntry = true;
      this.#gdb.addBreak("main.cpp", "main").then((breakpoint) => {
        let bp = new gdbTypes.Breakpoint(
          breakpoint.id,
          breakpoint.file,
          breakpoint.line,
          breakpoint.func,
          breakpoint.thread
        );
        this.#breakpoints.set(breakpoint.id, bp);
      });
    }
    this.#gdb.on("running", (payload) => {});
    this.#gdb.on("exec", (payload) => {});

    this.#gdb.on("stopped", (/** @type {gdbNs.Breakpoint}*/ payload) => {
      if (this.stoppedAtEntry) {
        this.emit("stopOnEntry", payload);
        this.stoppedAtEntry = false;
      } else {
        if (payload.reason == "breakpoint-hit") {
          setImmediate(() => {
            this.emit("breakpoint-hit", payload.breakpoint.id);
          });
        } else {
          if (payload.reason == "exited-normally") {
            this.emit("exited-normally");
          } else {
            console.log(`stopped for other reason: ${payload.reason}`);
          }
        }
      }
    });

    this.#gdb.on("notify", (data) => {
      console.log(
        `Caught GDB notify. State: ${data.state}. Data: ${data.data}`
      );
      if (data.state == "breakpoint-modified") {
        for (let b of this.#breakpoints.values()) {
          if (b.id === Number.parseInt(data.data.bkpt.number)) {
            b.address = Number.parseInt(data.data.bkpt.addr);
          }
        }
      }
    });
    this.#gdb.on("status", (payload) => {
      console.log(
        `Caught GDB status.  State: ${payload.state}. Data: ${payload.data}`
      );
    });
    await this.#gdb.init();
    await this.#gdb.enableAsync();
    return this.#gdb.run();
  }

  /**
   *
   * @param { boolean } reverse
   */
  async continue(reverse = false) {
    return this.#gdb.execMI("-exec-continue");
  }

  /**
   *
   * @param {string} path
   * @param {number} line
   * @returns { Promise<gdbTypes.Breakpoint> }
   */
  async setBreakPointAtLine(path, line) {
    return this.#gdb.addBreak(path, line).then((breakpoint) => {
      let bp = new gdbTypes.Breakpoint(
        breakpoint.id,
        breakpoint.file,
        breakpoint.line,
        breakpoint.func,
        breakpoint.thread
      );
      if (!this.#breakpoints.has(bp.id)) {
        this.#breakpoints.set(bp.id, bp);
      }
      return bp;
    });
  }

  // TODO(simon): List gdb functions we want / need to implement next

  #setWatchPoint(location, wpType) {
    return this.#gdb.execMI(`-break-watch ${wpType} ${location}`);
  }
  setReadWatchPoint(location) {
    return this.#setWatchPoint(location, WatchPointType.READ);
  }
  setWriteWatchPoint(location) {
    return this.#setWatchPoint(location, WatchPointType.WRITE);
  }
  setAccessWatchPoint(location) {
    return this.#setWatchPoint(location, WatchPointType.ACCESS);
  }

  // async listBreakpoints(location) {}

  /**
   *
   * @param {number} levels
   * @param {number} [threadId]
   * @returns {Promise<gdbTypes.StackFrame[]>}
   */
  async getStack(levels, threadId) {
    let command = `-stack-list-frames ${
      threadId != 0 ? `--thread ${threadId}` : ""
    } 0 ${levels}`;
    let result = await this.#gdb.execMI(command);
    return result.stack.map((frame) => {
      const { addr, arch, file, fullname, func, level, line } = frame.value;
      return new gdbTypes.StackFrame(file, fullname, line, func, level, addr);
    });
  }

  async getThreads() {
    const command = "-thread-info";
    let cmd_result = await this.#gdb.execMI(command);
    return cmd_result.threads.map(
      ({ core, frame, id, name, state, "target-id": target_id }) => {
        return new gdbTypes.Thread(id, core, name, state, target_id, frame);
      }
    );
  }

  /**
   * @typedef {Object} Local
   * @property {string} name
   * @property {string} type
   * @property {string} value
   *
   * @returns {Promise<Local[]>}
   */
  async getStackLocals() {
    let stack_locals = await this.#gdb
      .execMI("-stack-list-locals --skip-unavailable --simple-values")
      .then((res) => {
        return res.locals.map((local) => {
          return {
            name: local.name,
            type: local.type,
            value: local.value,
          };
        });
      });

    for (const v of stack_locals) {
      if (v.value == undefined) {
        let r = await this.#gdb.execCLI(`ptype /tm ${v.type}`);
        console.log(`Result of CLI command "ptype ${v.type}":`);
        console.log(r);
      }
    }

    return stack_locals;
  }

  /**
   *
   * @param {number} thread
   * @param {number} frame
   * @returns {Promise<gdbTypes.VariableCompact[]>}
   */
  async getStackVariables(thread, frame) {
    return this.#gdb
      .execMI(
        `stack-list-variables --thread ${thread} --frame ${frame} --simple-values`
      )
      .then((cmd_result) => {
        cmd_result.variables.map((v) => {
          return new gdbTypes.VariableCompact(v.name, v.value, v.type);
        });
      });
  }

  /**
   * Returns the entire context of the application if `thread` is null.
   * Otherwise returns the context of that thread.
   * The "context", is here defined as all global, static and local variables.
   * N.B. This is a potentially costly operation.
   * @param { number } thread
   * @returns { Promise<object[]> }
   */
  async getContext(thread) {
    let a = await this.#gdb.context(thread ? thread : undefined);
    return a;
  }

  async getVariableListChildren(name) {
    const command = `-var-list-children ${name} 2`;
    return this.#gdb.execMI(command).then((res) => {
      return res.children;
    });
  }
}

module.exports = {
  GDBInterface,
};
