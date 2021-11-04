"use strict";
// pull in EventEmitter, which DebugInterface extends
// it is through this, we dispatch communication between VSCode and GDB/MI
const {EventEmitter} = require("events");
const { GDB } = require("gdb-js");
const { spawn } = require("child_process");

class GDBInterface extends EventEmitter {
  /** @type GDB */
  #gdb;

  constructor() {
    super();
  }
  /** Starts debugging of executable `program`
   * @param { string} program
   * @param { boolean } stopOnEntry
   * @param { boolean } debug
   */
  async start(program, stopOnEntry, debug) {
    let gdb_process = spawn("gdb", ["-i=mi3", program]);
    this.#gdb = new GDB(gdb_process);
  }

  /**
   *
   * @param { boolean } reverse
   */
  async continue(reverse = false) {
    this.#gdb.execMI("-e")
    return new Promise((resolve, reject) => {

    })
  }
}

module.exports = {
  GDBInterface
}