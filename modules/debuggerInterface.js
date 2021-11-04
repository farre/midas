"use strict";
// pull in EventEmitter, which DebugInterface extends
// it is through this, we dispatch communication between VSCode and GDB/MI
const { EventEmitter } = require("events");
const { GDB } = require("gdb-js");
const { spawn } = require("child_process");
const regeneratorRuntime = require("regenerator-runtime");
const gdbTypes = require("./gdbtypes");

/**
 *
 * @param {string} program
 * @param {boolean} stopOnEntry
 * @returns EventEmitter
 */
function initGDB(program, stopOnEntry) {
  let gdb_process = spawn("gdb", ["-i=mi3", program]);
  let gdb = new GDB(gdb_process);
  return gdb;
}

class GDBInterface extends EventEmitter {
  #gdb;
  stoppedAtEntry;

  #breakpoints;

  constructor(binary) {
    super();
    this.stoppedAtEntry = false;
  }

  /** Starts debugging of executable `program`
   * @param { string} program
   * @param { boolean } stopOnEntry
   * @param { boolean } debug
   */
  async start(program, stopOnEntry, debug) {
    let gdb_process = spawn("gdb", ["-i=mi3", program]);
    this.#gdb = new GDB(gdb_process);
    this.#gdb = initGDB(program, true);
    this.#gdb.addBreak("main.cpp", "main").then((breakpoint) => {
      console.log(
        `Breakpoint set at ${breakpoint.id}. ${breakpoint.func} @ ${breakpoint.file}:${breakpoint.line}`
      );
      this.#breakpoints[breakpoint.id] = new gdbTypes.Breakpoint(
        breakpoint.id,
        breakpoint.file,
        breakpoint.line,
        breakpoint.func,
        breakpoint.thread
      );
    });
    this.#gdb.on("running", (payload) => {
      console.log("we are running");
    });
    this.#gdb.on("exec", (payload) => {
      console.log("gdb is executing");
    });
    this.#gdb.on("stopped", (payload) => {
      if (!this.stoppedAtEntry) {
        console.log(`We hit the entry. breakpoint: ${payload.breakpoint.id}`);
        // we reset the handler
        this.#gdb.on("stopped", (pl) => {
          if (pl.reason == "breakpoint-hit") {
            console.log(`hit breakpoint: ${pl.id}`);
          }
        });
        setImmediate(() => {
          this.emit("stopOnEntry", payload);
        });
        this.stoppedAtEntry = true;
      }
    });
    this.#gdb.on("notify", (payload) => {
      console.log(`Caught GDB notify`);
    });
    this.#gdb.on("status", (payload) => {
      console.log(`Caught GDB status`);
    });
    return this.#gdb.run();
  }

  /**
   *
   * @param { boolean } reverse
   */
  async continue(reverse = false) {
    this.#gdb.execMI("-e");
    return new Promise((resolve, reject) => {});
  }
}

module.exports = {
  GDBInterface,
};
