"use strict";
// pull in EventEmitter, which DebugInterface extends
// it is through this, we dispatch communication between VSCode and GDB/MI
const { EventEmitter } = require("events");
const { GDB } = require("gdb-js");
const { spawn } = require("child_process");
const regeneratorRuntime = require("regenerator-runtime");
const gdbTypes = require("./gdbtypes");

class GDBInterface extends EventEmitter {
  #gdb;
  stoppedAtEntry;
  /** Maps file paths -> Breakpoints
   * @type { Map<string, gdbTypes.Breakpoint[]> } */
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
    if(stopOnEntry) {
      this.stoppedAtEntry = true;
      this.#gdb.addBreak("main.cpp", "main").then((breakpoint) => {
        console.log(
          `Breakpoint set at ${breakpoint.id}. ${breakpoint.func} @ ${breakpoint.file}:${breakpoint.line}`
        );

        let bp = new gdbTypes.Breakpoint(
          breakpoint.id,
          breakpoint.file,
          breakpoint.line,
          breakpoint.func,
          breakpoint.thread
        );
        this.#breakpoints.set(breakpoint.file, [bp]);
      });
    }
    this.#gdb.on("running", (payload) => {
      console.log("we are running");
    });
    this.#gdb.on("exec", (payload) => {
      console.log("gdb is executing");
    });
    this.#gdb.on("stopped", (payload) => {
      console.log(`gdb stopped: ${payload.reason}`);
      if (this.stoppedAtEntry) {
        console.log(`We hit the entry. breakpoint: ${payload.breakpoint.id}`);
        // we reset the handler
        setImmediate(() => {
          this.emit("stopOnEntry", payload);
        });
        this.stoppedAtEntry = false;
        this.#gdb.on("stopped", (pl) => {
          console.log(`gdb stopped: ${pl.reason}`);
          if (pl.reason == "breakpoint-hit") {
            console.log(`hit breakpoint: ${pl.id}`);
          } else {
            console.log(`stopped for other reason: ${pl.reason}`);
          }
          setImmediate(() => {
            this.emit("stopOnBreakpoint", pl);
          });
        });
      }
    });
    this.#gdb.on("notify", (payload) => {
      console.log(`Caught GDB notify. State: ${payload.state}. Data: ${payload.data}`);
    });
    this.#gdb.on("status", (payload) => {
      console.log(`Caught GDB status.  State: ${payload.state}. Data: ${payload.data}`);
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

  /**
   * 
   * @param {string} path
   * @param {number} line
   * @returns { Thenable<gdbTypes.Breakpoint> }
   */
  async setBreakPointAtLine(path, line) {
    /*
    let bpsInFile = this.#breakpoints.get(path);
    if(bpsInFile) {
      let result = bpsInFile.find(bp => bp.line == line);
      if(result) {
        return new Promise((resolve, reject) => resolve(result));
      }
    }
*/
    return this.#gdb.addBreak(path, line).then(breakpoint => {
      console.log(
        `Breakpoint set at ${breakpoint.id}. ${breakpoint.func} @ ${breakpoint.file}:${breakpoint.line}. Thread: ${breakpoint.thread ? breakpoint.thread.id : "all threads"}`
      );
      let bp = new gdbTypes.Breakpoint(
        breakpoint.id,
        breakpoint.file,
        breakpoint.line,
        breakpoint.func,
        breakpoint.thread
      );
      let bpsInFile = this.#breakpoints.get(breakpoint.file);
      let existAlready = false;
      if(bpsInFile) {
        for(let brkp of bpsInFile) {
          if(brkp.id == bp.id) {
            console.log("we already have that breakpoint set");
            existAlready = true;
          }
        }
        if(!existAlready) {
          bpsInFile.push(bp);
        }
      }
      this.#breakpoints.set(breakpoint.file, bpsInFile);
      return bp;
    });
  }
}

module.exports = {
  GDBInterface,
};
