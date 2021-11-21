"use strict";
const gdbjs = require("gdb-js");
require("regenerator-runtime");

const {
  InitializedEvent,
  StoppedEvent,
  BreakpointEvent,
  TerminatedEvent,
  ThreadEvent,
} = require("vscode-debugadapter");

const gdbTypes = require("./gdbtypes");
const { getFunctionName, spawn } = require("./utils");

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
  constructor(target, binary, gdbPath, args = undefined) {
    super(
      spawn(
        gdbPath,
        !args ? ["-i=mi3", binary] : ["-i=mi3", "--args", binary, ...args]
      )
    );
    this.#lineBreakpoints = new Map();
    this.#fnBreakpoints = new Map();
    this.#target = target;
  }

  async start(program, stopOnEntry, debug, doTrace, allStopMode) {
    trace = doTrace;
    this.allStopMode = allStopMode;
    await this.init();
    await this.execMI(`-gdb-set mi-async on`);
    if (!allStopMode) {
      await this.enableAsync();
    }

    if (stopOnEntry) {
      await this.execMI("-exec-run --start");
    } else {
      await this.run();
    }
  }

  async restart(program, stopOnEntry) {
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
    this.on("notify", this.#onNotify.bind(this));
    this.on("status", this.#onStatus.bind(this));
    this.on("exec", this.#onExec.bind(this));

    if (stopOnEntry) {
      this.once("stopped", this.#onStopOnEntry.bind(this));
    } else {
      this.on("stopped", this.#onStopped.bind(this));
    }

    this.on("running", this.#onRunning.bind(this));
    this.on("thread-created", this.#onThreadCreated.bind(this));
    this.on("thread-exited", this.#onThreadExited.bind(this));
    this.on("thread-group-started", this.#onThreadGroupStarted.bind(this));
    this.on("thread-group-exited", this.#onThreadGroupExited.bind(this));
    this.on("new-objfile", this.#onNewObjfile.bind(this));

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

  // todo(simon): calling this function with no threadId should in future releases fail
  //  if continue of all is desired, call continueAll() instead
  async continue(threadId, reverse = false) {
    if (!reverse) {
      if (threadId && !this.allStopMode) {
        await this.execMI(`-thread-select ${threadId}`);
        await this.execMI(`-exec-continue`);
      } else {
        await this.continueAll();
      }
    } else {
      // todo(simon): this needs a custom implementation, like in the above if branch
      //  especially when it comes to rr integration
      await this.reverseProceed(this.allStopMode ? undefined : threadId);
    }
  }

  async continueAll() {
    return this.execMI(`-exec-continue --all`);
  }
  // todo(simon): calling this function with no threadId should in future releases fail
  //  if pause of all is desired, call pauseAll() instead
  async pauseExecution(threadId) {
    this.userRequestedInterrupt = true;
    if (!threadId) {
      return await this.execMI(`-exec-interrupt --all`);
    } else {
      return await this.execMI(`-exec-interrupt --thread ${threadId}`);
    }
  }

  async pauseAll() {
    return await this.execMI(`-exec-interrupt --all`);
  }

  /**
   * @param {string} path
   * @param {number} line
   * @returns { Promise<gdbTypes.Breakpoint> }
   */
  async setBreakPointAtLine(path, line) {
    const breakpoint = await this.addBreak(path, line);
    let bp = new gdbTypes.Breakpoint(breakpoint.id, breakpoint.line);
    let ref = this.#lineBreakpoints.get(breakpoint.file) ?? [];
    ref.push(bp);
    this.#lineBreakpoints.set(breakpoint.file, ref);
    return bp;
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
    const { bkpt } = await this.execMI(`-break-insert ${name}`);
    this.#fnBreakpoints.set(name, bkpt.number);
    return bkpt.number;
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

  async stepIn(threadId) {
    if (!threadId) {
      await this.execMI(`-exec-step`);
    } else {
      await this.execMI(`-exec-step --thread ${threadId}`);
    }
  }

  async stepOver(threadId) {
    if (!threadId) {
      await this.execMI(`-exec-next`);
    } else {
      await this.execMI(`-exec-next --thread ${threadId}`);
    }
  }

  async stepInstruction(threadId) {
    if (!threadId) {
      await this.execMI(`-exec-next-instruction`);
    } else {
      await this.execMI(`-exec-next-instruction --thread ${threadId}`);
    }
  }

  async finishExecution(threadId) {
    if (!threadId) {
      await this.execMI(`-exec-finish`);
    } else {
      await this.execMI(`-exec-finish --thread ${threadId}`);
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
    let { stack } = await this.execMI(command);
    return stack.map((frame) => {
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
    const { threads } = await this.execMI(command);
    let result = threads.map(
      ({ core, frame, id, name, state, "target-id": target_id }) =>
        new gdbTypes.Thread(id, core, name, state, target_id, frame)
    );
    return result;
  }

  /**
   * @typedef {Object} Local
   * @property {string} name
   * @property {string} type
   * @property {string | null} value
   *
   * @returns {Promise<Local[]>}
   */
  async getStackLocals(threadId, frameLevel) {
    const command = `-stack-list-variables --thread ${threadId} --frame ${
      frameLevel ?? 0
    } --simple-values`;
    const { variables } = await this.execMI(command);
    return variables.map(({ name, type, value }) => ({ name, type, value }));
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
    const { variables } = this.execMI(
      `stack-list-variables --thread ${thread} --frame ${frame} --simple-values`
    );
    return variables.map(({ name, value, type }) => {
      return new gdbTypes.VariableCompact(name, value, type);
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
  getContext(thread) {
    return this.context(thread ? thread : undefined);
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
    const isVisibilityModifier = (expr) => {
      return expr === "public" || expr === "private" || expr === "protected";
    };
    let mods = await this.execMI(
      `-var-list-children --all-values "${variableObjectName}"`
    );

    let requests = [];
    for (const r of mods.children) {
      const membersCommands = `-var-list-children --all-values "${r.value.name}"`;
      let members = await this.execMI(membersCommands);
      /*
       * why members.children[0] here? Well, if *any* of the first
       * children of members, is either "protected", "private" or "public"
       * means we will see *no* other thing, we first must drill down into that sub scope of this
       * structure. Therefore we don't have to check [1] or [2] or any else. If *any* of them is
       * a visibility modifier, we have to drill down.
       */
      const expr = members.children[0].value.exp;
      if (expr) {
        if (isVisibilityModifier(expr)) {
          let sub = await this.execMI(
            `-var-list-children --all-values "${r.value.name}.${expr}"`
          );
          requests.push(sub);
        } else {
          requests.push(members);
        }
      }
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

    let res = [];
    for (let arr of requests) {
      for (let v of arr.children) {
        res.push(makeVarObjChild(v.value));
      }
    }
    return res;
  }

  // Async record handlers
  #onNotify(payload) {
    log("notify", payload);

    switch (payload.state) {
      case "running": {
        this.#onNotifyRunning(payload.data);
      }
      case "stopped": {
        this.#onNotifyStopped(payload.data);
      }
      case "thread-group-added": {
        this.#onNotifyThreadGroupAdded(payload.data);
        break;
      }
      case "thread-group-removed": {
        this.#onNotifyThreadGroupRemoved(payload.data);
        break;
      }
      case "thread-group-started": {
        this.#onNotifyThreadGroupStarted(payload.data);
        break;
      }
      case "thread-group-exited": {
        this.#onNotifyThreadGroupExited(payload.data);
        break;
      }
      case "thread-created": {
        this.#onNotifyThreadCreated(payload.data);
        break;
      }
      case "thread-exited": {
        this.#onNotifyThreadExited(payload.data);
        break;
      }
      case "thread-selected": {
        this.#onNotifyThreadSelected(payload.data);
        break;
      }
      case "library-loaded": {
        this.#onNotifyLibraryLoaded(payload.data);
        break;
      }
      case "library-unloaded": {
        this.#onNotifyLibraryUnloaded(payload.data);
        break;
      }
      case "breakpoint-created": {
        this.#onNotifyBreakpointCreated(payload.data);
        break;
      }
      case "breakpoint-modified": {
        this.#onNotifyBreakpointModified(payload.data);
        break;
      }
      case "breakpoint-deleted": {
        this.#onNotifyBreakpointDeleted(payload.data);
        break;
      }
    }
  }

  #onStatus(payload) {
    log(getFunctionName(), payload);
  }

  #onExec(payload) {
    log(getFunctionName(), payload);
  }

  #onStopped(payload) {
    log(getFunctionName(), payload);
    switch (payload.reason) {
      case "breakpoint-hit":
        this.#onBreakpointHit(payload.thread);
        break;
      case "exited-normally":
        this.sendEvent(new TerminatedEvent());
        break;
      case "signal-received":
        this.#onSignalReceived(payload.thread, payload);
        break;
      case "end-stepping-range":
        this.#target.sendEvent(new StoppedEvent("step", payload.thread.id));
        break;
      case "function-finished":
        this.#target.sendEvent(new StoppedEvent("step", payload.thread.id));
        break;
      default:
        console.log(`stopped for other reason: ${payload.reason}`);
    }
  }

  #onStopOnEntry(payload) {
    const THREADID = payload.thread.id;
    this.sendEvent(new StoppedEvent("entry", THREADID));
    this.on("stopped", this.#onStopped.bind(this));
  }

  #onRunning(payload) {
    log(getFunctionName(), payload);
    this.userRequestedInterrupt = false;
  }

  #onThreadCreated(payload) {
    this.threadsCreated.push(payload.id);
    this.#target.sendEvent(new ThreadEvent("started", payload.id));
  }

  #onThreadExited(payload) {
    this.threadsCreated.splice(this.threadsCreated.indexOf(payload.id), 1);
    this.#target.sendEvent(new ThreadEvent("exited", payload.id));
  }

  #onThreadGroupStarted(payload) {
    log(getFunctionName(), payload);
  }

  #onThreadGroupExited(payload) {
    log(getFunctionName(), payload);
  }

  #onNewObjfile(payload) {
    log(getFunctionName(), payload);
  }

  // Raw GDB handlers for #onNotify

  /**
   * The target is now running.
   *
   * @param {{threadId: number}} payload
   */
  #onNotifyRunning(payload) {
    log("running", payload);
  }

  /**
   * The target has stopped.
   *
   * The reason field can have one of the following values:
   * * breakpoint-hit
   * * watchpoint-trigger
   * * read-watchpoint-trigger
   * * access-watchpoint-trigger
   * * function-finished
   * * location-reached
   * * watchpoint-scope
   * * end-stepping-range
   * * exited-signalled
   * * exited
   * * exited-normally
   * * signal-received
   * * solib-event
   * * fork
   * * vfork
   * * syscall-entry
   * * syscall-entry
   * * exec.
   *
   * @param {{ reason: string,
   *           threadId: number,
   *           stoppedThreads: (string | number[]),
   *           core: number? }} payload
   */
  #onNotifyStopped(payload) {
    log(getFunctionName(), payload);
  }

  /**
   * A thread group was added.
   *
   * @param {{id: number}} payload
   */
  #onNotifyThreadGroupAdded(payload) {
    log(getFunctionName(), payload);
  }

  /**
   * A thread group was removed.
   *
   * @param {{id: number}} payload
   */
  #onNotifyThreadGroupRemoved(payload) {
    log(getFunctionName(), payload);
  }

  /**
   * A thread group became associated with a running program.
   *
   * @param {{id:number, pid: number}} payload
   */
  #onNotifyThreadGroupStarted(payload) {
    log(getFunctionName(), payload);
  }

  /**
   * A thread group is no longer associated with a running program.
   *
   * @param {{id: number, exitCode: number}} payload
   */
  #onNotifyThreadGroupExited(payload) {
    log(getFunctionName(), payload);
  }

  /**
   * A thread was created.
   *
   * @param { { id: number, groupId: number }} payload
   */
  #onNotifyThreadCreated(payload) {
    log(getFunctionName(), payload);
    this.#target.sendEvent(new ThreadEvent("started", payload.id));
  }

  /**
   * A thread has exited.
   *
   * @param {{id: number, groupId: number}} payload
   */
  #onNotifyThreadExited(payload) {
    log(getFunctionName(), payload);
  }

  /**
   * Informs that the selected thread was changed
   *
   * @param {{id: number}} payload
   */
  #onNotifyThreadSelected(payload) {
    log(getFunctionName(), payload);
  }

  /**
   * Reports that a new library file was loaded by the program.
   *
   * @param {*} payload
   */
  #onNotifyLibraryLoaded(payload) {
    log(getFunctionName(), payload);
  }

  /**
   * Reports that a library was unloaded by the program.
   *
   * @param {*} payload
   */
  #onNotifyLibraryUnloaded(payload) {
    log(getFunctionName(), payload);
  }

  /**
   * @typedef {{number: number,
   *            type: string,
   *            disp: string,
   *            enabled: string,
   *            addr: number,
   *            func: string,
   *            file: string,
   *            fullname: string,
   *            line: number
   *            thread?: number}} bkpt
   */

  /**
   * Reports that a breakpoint was created.
   *
   * @param {bkpt} payload
   */
  #onNotifyBreakpointCreated(payload) {
    log(getFunctionName(), payload);
  }

  /**
   * Reports that a breakpoint was modified.
   *
   * @param {bkpt} payload
   */
  #onNotifyBreakpointModified(payload) {
    log(getFunctionName(), payload);
  }

  /**
   * Reports that a breakpoint was deleted.
   *
   * @param {bkpt} payload
   */
  #onNotifyBreakpointDeleted(payload) {
    log(getFunctionName(), payload);
  }

  #onBreakpointHit(thread) {
    const THREADID = thread.id;
    let stopEvent = new StoppedEvent("breakpoint", THREADID);
    const body = {
      reason: stopEvent.body.reason,
      allThreadsStopped: this.allStopMode,
      threadId: THREADID,
    };
    stopEvent.body = body;
    this.sendEvent(stopEvent);
  }

  // eslint-disable-next-line no-unused-vars
  #onSignalReceived(thread, code) {
    const THREADID = thread.id;
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
  }
}

module.exports = {
  GDB,
};
