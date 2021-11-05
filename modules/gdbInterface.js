"use strict";
// pull in EventEmitter, which DebugInterface extends
// it is through this, we dispatch communication between VSCode and GDB/MI
const { EventEmitter } = require("events");
const { GDB } = require("gdb-js");
const gdbNs = require("gdb-js");
const { spawn } = require("child_process");
const regeneratorRuntime = require("regenerator-runtime");
const gdbTypes = require("./gdbtypes");

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
  continue(reverse = false) {
    this.#gdb.execMI("-exec-continue").then(({ cmd, scope }) => {
      console.log(`executing: ${cmd}`);
    });
  }

  /**
   *
   * @param {string} path
   * @param {number} line
   * @returns { Thenable<gdbTypes.Breakpoint> }
   */
  async setBreakPointAtLine(path, line) {
    return this.#gdb.addBreak(path, line).then((breakpoint) => {
      console.log(
        `Breakpoint set at ${breakpoint.id}. ${breakpoint.func} @ ${
          breakpoint.file
        }:${breakpoint.line}. Thread: ${
          breakpoint.thread ? breakpoint.thread.id : "all threads"
        }`
      );
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
    let frames = await this.#gdb.callstack();
    console.log(`found ${result.length} results and ${frames.length}`);
    return result.stack.map((frame) => {
      const { addr, arch, file, fullname, func, level, line } = frame.value;
      return new gdbTypes.StackFrame(file, fullname, line, func, level, addr);
    });
  }
}

module.exports = {
  GDBInterface,
};
