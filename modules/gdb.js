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

  variableObjectsRecorded = [];

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

    if (true) {
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
          this.sendEvent(new StoppedEvent("breakpoint", 1));
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
    return this.execMI(command).then((res) => {
      return res.threads.map(
        ({ core, frame, id, name, state, "target-id": target_id }) => {
          return new gdbTypes.Thread(id, core, name, state, target_id, frame);
        }
      );
    });
  }

  /**
   * @typedef {Object} Local
   * @property {string} name
   * @property {string} type
   * @property {string | null} value
   *
   * @returns {Promise<Local[]>}
   */
  async getStackLocals() {
    const command = `-stack-list-variables --simple-values`;
    return this.execMI(command).then((res) => {
      return res.variables.map((variable) => {
        return {
          name: variable.name,
          type: variable.type,
          value: variable.value ? variable.value : null,
        };
      });
    });
  }

  /**
   *
   * @param {string} sourceCodeVariableName
   * @param {string} variableObjectName
   */
  async createVarObject(sourceCodeVariableName, variableObjectName) {
    const cmd = `-var-create ${variableObjectName} * ${sourceCodeVariableName}`;
    let v = await this.execMI(cmd);
    // we only ever keep track of parent variable objects; GDB deletes children for us
    this.variableObjectsRecorded.push(v.name);
    return v;
  }

  async clearVariableObjects() {
    return this.variableObjectsRecorded.map(async (name) => {
      this.execMI(`-var-delete ${name}`);
    });
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

  /**
   * @typedef { {
   *  variableObjectName: string,
   *  expression: string,
   *  value: string,
   *  type: string,
   *  threadID: string
   *  numChild: string }
   * } VariableObjectChild
   * @param {string} variableObjectName
   * @returns {Promise<VariableObjectChild[]>}
   */
  async getVariableListChildren(variableObjectName) {
    let mods = await this.execMI(
      `-var-list-children --all-values ${variableObjectName}`
    );

    let requests = [];
    for (const r of mods.children) {
      const membersCommands = `-var-list-children --all-values ${r.value.name}`;
      requests.push(this.execMI(membersCommands));
    }

    const makeVarObjChild = (res) => {
      return {
        variableObjectName: res.name,
        expression: res.exp,
        value: res.value,
        type: res.type,
        threadID: res["thread-id"],
        numChild: res.numchild,
      };
    };

    return Promise.all([
      ...requests,
      //p_privateMembers_res,
      //p_publicMembers_,
      //p_protectedMembers,
    ]).then((values) => {
      let res = [];
      for (let arr of values) {
        for (let v of arr.children) {
          res.push(makeVarObjChild(v.value));
        }
      }
      return res;
    });
  }
}

module.exports = {
  GDB,
};
