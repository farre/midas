"use strict";
// pull in EventEmitter, which DebugInterface extends
// it is through this, we dispatch communication between VSCode and GDB/MI
const gdbjs = require("gdb-js");
const regeneratorRuntime = require("regenerator-runtime");
const gdbTypes = require("./gdbtypes");
const { spawn } = require("./spawner");
const { EventEmitter } = require("events");
const {
  InitializedEvent,
  StoppedEvent,
  BreakpointEvent,
  TerminatedEvent,
} = require("vscode-debugadapter");

const WatchPointType = {
  ACCESS: "-a",
  READ: "-r",
  WRITE: "",
};

// gdb MI functions that we don't pass params to
const getCurrentFunctionArgs = `-stack-list-arguments --skip-unavailable 1 0 0`;

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

let trace = true;

function log(location, payload) {
  if (!trace) {
    return;
  }

  console.log(
    `Caught GDB ${location}. State: ${payload.state}. Data: ${JSON.stringify(
      payload.data,
      null,
      " "
    )}`
  );
}

/** @constructor */
let GDBBase = gdbjs.GDB;

/**
 * @constructor
 */
class GDB extends GDBBase {
  stoppedAtEntry;
  /** Maps file paths -> Breakpoints
   * @type { Map<number, gdbTypes.Breakpoint> } */
  #breakpoints;

  #loadedLibraries;

  #target;

  constructor(target, binary) {
    super(spawn("gdb", ["-i=mi3", binary]));
    this.stoppedAtEntry = false;
    this.#breakpoints = new Map();
    this.#target = target;
  }

  /** Starts debugging of executable `program`
   * @param { string} program
   * @param { boolean } stopOnEntry
   * @param { boolean } debug
   */
  async start(program, stopOnEntry, debug) {
    await this.init();
    await this.enableAsync();

    if (stopOnEntry) {
      await this.execMI("-exec-run --start");
    } else {
      await this.run();
    }
  }

  sendEvent(event) {
    this.#target.sendEvent(event);
  }

  initialize(stopOnEntry) {
    this.on("exec", (payload) => {
      log("exec", payload);
    });

    this.on("running", (payload) => {
      log("running", payload);
    });

    this.on("stopped", (payload) => {
      log(`stopped(stopOnEntry = ${!!stopOnEntry})`, payload);

      if (stopOnEntry) {
        stopOnEntry = false;
        this.sendEvent(new StoppedEvent("entry", 1));
      } else {
        if (payload.reason == "breakpoint-hit") {
          this.getStackLocals()
            .then((locals) => {
              return locals;
            })
            .catch((err) => {
              console.log("Error trying to get locals");
            })
            .then((locals) => {
              this.sendEvent(new StoppedEvent("breakpoint", this.threadId));
            });
        } else {
          if (payload.reason == "exited-normally") {
            this.sendEvent(new TerminatedEvent());
          } else {
            console.log(`stopped for other reason: ${payload.reason}`);
          }
        }
      }
    });

    this.on("status", (payload) => {
      log("status", payload);
    });

    this.on("notify", (payload) => {
      log("notify", payload);
      if (payload.state == "breakpoint-modified") {
        for (let b of this.#breakpoints.values()) {
          if (b.id === Number.parseInt(payload.data.bkpt.number)) {
            b.address = Number.parseInt(payload.data.bkpt.addr);
          }
        }
      }
    });

    this.on("breakPointValidated", (bp) => {
      this.sendEvent(
        new BreakpointEvent("changed", {
          id: bp.id,
          verified: true,
          line: bp.line,
        })
      );
    });

    this.sendEvent(new InitializedEvent());
  }

  /**
   *
   * @param { boolean } reverse
   */
  async continue(reverse = false) {
    return this.execMI("-exec-continue");
  }

  /**
   *
   * @param {string} path
   * @param {number} line
   * @returns { Promise<gdbTypes.Breakpoint> }
   */
  async setBreakPointAtLine(path, line) {
    return this.addBreak(path, line).then((breakpoint) => {
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
    return this.execMI(`-break-watch ${wpType} ${location}`);
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
    let result = await this.execMI(command);
    return result.stack.map((frame) => {
      const { addr, arch, file, fullname, func, level, line } = frame.value;
      return new gdbTypes.StackFrame(file, fullname, line, func, level, addr);
    });
  }

  async getThreads() {
    const command = "-thread-info";
    let cmd_result = await this.execMI(command);
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
    // TODO(simon): we need to create var objects in GDB
    //  to manage and keep track of things. This function is not done
    const frame_arguments = this.execMI(getCurrentFunctionArgs);
    const stack_locals = await this.execMI(
      "-stack-list-locals --skip-unavailable --simple-values"
    ).then((res) => {
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
        let r = await this.execCLI(`ptype /tm ${v.type}`);
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
    return this.execMI(
      `stack-list-variables --thread ${thread} --frame ${frame} --simple-values`
    ).then((cmd_result) => {
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
    let a = await this.context(thread ? thread : undefined);
    return a;
  }

  async getVariableListChildren(name) {
    const command = `-var-list-children ${name} 2`;
    return this.execMI(command).then((res) => {
      return res.children;
    });
  }
}

module.exports = {
  GDB,
};
