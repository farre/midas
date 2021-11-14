"use strict";
// pull in EventEmitter, which DebugInterface extends
// it is through this, we dispatch communication between VSCode and GDB/MI
const gdbjs = require("gdb-js");
// eslint-disable-next-line no-unused-vars
const regeneratorRuntime = require("regenerator-runtime");
const gdbTypes = require("./gdbtypes");
const { spawn } = require("./spawner");
// eslint-disable-next-line no-unused-vars
const { EventEmitter } = require("events");
// eslint-disable-next-line no-unused-vars
const { DebugProtocol } = require("vscode-debugprotocol");
const {
  InitializedEvent,
  StoppedEvent,
  BreakpointEvent,
  TerminatedEvent,
  ThreadEvent,
} = require("vscode-debugadapter");

const WatchPointType = {
  ACCESS: "-a",
  READ: "-r",
  WRITE: "",
};

let trace = true;
function log(location, payload) {
  if (!trace) {
    return;
  }

  console.log(
    `Caught GDB ${location}. Payload: ${JSON.stringify(payload, null, " ")}`
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
   * @type { Map<string, gdbTypes.Breakpoint[]> } */
  #lineBreakpoints;
  /** Maps function name (original location) -> Function breakpoint id
   * @type { Map<string, number> } */
  #fnBreakpoints;

  #loadedLibraries;

  variableObjectsRecorded = [];

  #target;
  threadsCreated = [];
  userRequestedInterrupt = false;
  allStopMode;
  constructor(target, binary, args = undefined) {
    super(
      spawn(
        "gdb",
        !args ? ["-i=mi3", binary] : ["-i=mi3", "--args", binary, ...args]
      )
    );
    this.stoppedAtEntry = false;
    this.#lineBreakpoints = new Map();
    this.#fnBreakpoints = new Map();
    this.#target = target;
  }

  async start(program, stopOnEntry, debug, doTrace, allStopMode) {
    trace = doTrace;
    this.allStopMode = allStopMode;
    await this.init();
    if (!allStopMode) await this.enableAsync();

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
      this.userRequestedInterrupt = false;
      log("running", payload);
    });

    this.once("stopped", (payload) => {
      this.on("stopped", (payload) => {
        log(`stopped(stopOnEntry = ${!!stopOnEntry})`, payload);
        if (payload.reason === "breakpoint-hit") {
          const THREADID = payload.thread.id;
          this.userRequestedInterrupt = false;
          let stopEvent = new StoppedEvent("breakpoint", THREADID);
          let body = {
            reason: stopEvent.body.reason,
            allThreadsStopped: this.allStopMode,
            threadId: THREADID,
          };
          stopEvent.body = body;
          this.sendEvent(stopEvent);
        } else if (payload.reason === "exited-normally") {
          this.sendEvent(new TerminatedEvent());
        } else if (payload.reason === "signal-received") {
          const THREADID = payload.thread.id;
          // we do not pass thread id, because if the user hits pause, we want to interrupt _everything_
          if (this.userRequestedInterrupt) {
            let stopEvent = new StoppedEvent("pause", THREADID);
            let body = {
              reason: stopEvent.body.reason,
              allThreadsStopped: true,
              threadId: THREADID,
            };
            stopEvent.body = body;
            this.sendEvent(stopEvent);
          }
        } else {
          console.log(`stopped for other reason: ${payload.reason}`);
        }
      });
      if (stopOnEntry) {
        const THREADID = payload.thread.id;
        stopOnEntry = false;
        this.sendEvent(new StoppedEvent("entry", THREADID));
      } else {
        this.emit("stopped", payload);
      }
    });

    this.on("user-interrupt", () => {});

    this.on("thread-created", (payload) => {
      this.threadsCreated.push(payload.id);
      this.#target.sendEvent(new ThreadEvent("started", payload.id));
    });

    this.on("thread-exited", async (pl) => {
      this.threadsCreated.splice(this.threadsCreated.indexOf(pl.id), 1);
      this.#target.sendEvent(new ThreadEvent("exited", pl.id));
    });

    this.on("status", (payload) => {
      log("status", payload);
    });

    this.on("notify", (payload) => {
      log("notify", payload);
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

  async continue(threadId, reverse = false) {
    if (!reverse) return this.proceed(this.allStopMode ? undefined : threadId);
    else return this.reverseProceed(this.allStopMode ? undefined : threadId);
  }

  async pauseExecution(threads) {
    this.userRequestedInterrupt = true;
    return await this.interrupt(threads);
  }

  /**
   * @param {string} path
   * @param {number} line
   * @returns { Promise<gdbTypes.Breakpoint> }
   */
  async setBreakPointAtLine(path, line) {
    return this.addBreak(path, line).then((breakpoint) => {
      let bp = new gdbTypes.Breakpoint(breakpoint.id, breakpoint.line);
      let ref = this.#lineBreakpoints.get(breakpoint.file) ?? [];
      ref.push(bp);
      this.#lineBreakpoints.set(breakpoint.file, ref);
      return bp;
    });
  }

  clearFunctionBreakpoints() {
    let ids = [];
    for (let id of this.#fnBreakpoints.values()) {
      ids.push(id);
    }
    if (ids.length > 0) {
      this.execMI(`-break-delete ${ids.join(" ")}`);
      this.#fnBreakpoints.clear();
    }
  }

  // eslint-disable-next-line no-unused-vars
  async setFunctionBreakpoint(name, condition, hitCondition) {
    return this.execMI(`-break-insert ${name}`).then((res) => {
      this.#fnBreakpoints.set(name, res.bkpt.number);
      return res.bkpt.number;
    });
  }

  async clearBreakPointsInFile(path) {
    let breakpointIds = (this.#lineBreakpoints.get(path) ?? []).map(
      (bkpt) => bkpt.id
    );
    if (breakpointIds.length > 0) {
      // we need this check. an "empty" param list to break-delete deletes all
      this.execMI(`-break-delete ${breakpointIds.join(" ")}`);
      this.#lineBreakpoints.set(path, []);
    }
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
      // eslint-disable-next-line no-unused-vars
      const { addr, arch, file, fullname, func, level, line } = frame.value;
      return new gdbTypes.StackFrame(file, fullname, line, func, level, addr);
    });
  }

  /**
   *
   * @returns {Promise<gdbTypes.Thread[]>}
   */
  async getThreads() {
    const command = "-thread-info";
    return await this.execMI(command)
      .then((res) => {
        let result = res.threads.map((threadInfo) => {
          const {
            core,
            frame,
            id,
            name,
            state,
            "target-id": target_id,
          } = threadInfo;
          return new gdbTypes.Thread(id, core, name, state, target_id, frame);
        });
        return result;
      })
      .catch((err) => {
        console.log(err);
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
