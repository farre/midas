/* eslint-disable max-len */
"use strict";
const gdbjs = require("gdb-js");
require("regenerator-runtime");

const path = require("path");
const {
  InitializedEvent,
  StoppedEvent,
  BreakpointEvent,
  TerminatedEvent,
  ThreadEvent,
  Variable,
  StackFrame,
} = require("vscode-debugadapter");

const { GDBMixin } = require("./gdb-mixin");
const gdbTypes = require("./gdbtypes");
const { getFunctionName, spawn } = require("./utils");

let trace = true;
function log(location, payload) {
  if (!trace) {
    return;
  }

  console.log(`Caught GDB ${location}. Payload: ${JSON.stringify(payload, null, " ")}`);
}

/** @constructor */
let GDBBase = gdbjs.GDB;

// A bridge between GDB Variable Objects and VSCode "Variable" from the vscode-debugadapter module
class MidasVariable extends Variable {
  constructor(name, value, ref, variableObjectName, isStructureType) {
    super(name, value, ref);
    this.voName = variableObjectName;
    this.isStruct = isStructureType;
    if (isStructureType) {
      this.presentationHint = { kind: "class" };
      this.evaluateName = this.voName;
    }
  }
}

class MidasStackFrame extends StackFrame {
  /**
   *
   * @param {number} variablesReference
   * @param {string} name
   * @param {import("vscode-debugadapter").Source} src
   * @param {number} ln
   * @param {?number} col
   */
  constructor(variablesReference, name, src, ln, col, frameAddress) {
    super(variablesReference, name, src, ln, col);
  }
}

const ContextType = {
  REGISTER: 0,
  STACKFRAME: 1,
  STRUCT: 2,
};

class ExecutionState {
  threadId;
  clearStateFn;

  constructor(threadId, clearState) {
    this.threadId = threadId;
    this.clearStateFn = clearState;
  }

  async clearState() {
    this.stack = [];
    await this.clearStateFn(this);
  }

  /** @type {MidasStackFrame[]} */
  stack = [];
  /** @type {Map<number, {frameLevel: number, variables: MidasVariable[] }>} */
  stackFrameLocals = new Map();
  /** @type {Map<number, {frameLevel: number, variables: MidasVariable[] }>} */
  stackFrameRegisterContents = new Map();
  // eslint-disable-next-line max-len
  /** @type {Map<number, {frameLevel: number, variableObjectName: string, memberVariables: MidasVariable[] }>} */
  structs = new Map();
}

/**
 * @constructor
 */
class GDB extends GDBMixin(GDBBase) {
  /** Maps file paths -> Breakpoints
   * @type { Map<string, gdbTypes.Breakpoint[]> } */
  #lineBreakpoints;
  /** Maps function name (original location) -> Function breakpoint id
   * @type { Map<string, number> } */
  #fnBreakpoints;

  registerFile = [];

  #loadedLibraries;

  #nextVarRef = 1000 * 1000;
  #nextFrameRef = 1000;

  #target;
  #program = "";

  /** @type { Map<number, ExecutionState> } */
  executionContexts = new Map();

  /** @type {Map<number, { threadId: number, frameLevel: number } >} */
  varRefContexts = new Map();

  #threads = new Map();
  userRequestedInterrupt = false;
  allStopMode;
  constructor(target, binary, gdbPath, args = undefined) {
    super(spawn(gdbPath, !args ? ["-i=mi3", binary] : ["-i=mi3", "--args", binary, ...args]));
    this.#lineBreakpoints = new Map();
    this.#fnBreakpoints = new Map();
    this.#target = target;
  }

  get nextVarRef() {
    return this.#nextFrameRef++;
  }

  get nextFrameRef() {
    return this.#nextFrameRef++;
  }

  async start(program, stopOnEntry, debug, doTrace, allStopMode) {
    this.#program = path.basename(program);
    trace = doTrace;
    this.allStopMode = allStopMode;
    await this.init();

    if (!allStopMode) {
      await this.enableAsync();
    } else {
      await this.execMI(`-gdb-set mi-async on`);
    }
    let miResult = await this.execMI(`-data-list-register-names`);
    let lastGPR = miResult["register-names"].findIndex((item) => item == "gs");
    this.registerFile = miResult["register-names"].splice(0, lastGPR + 1);
    this.generalPurposeRegCommandString = this.registerFile.map((v, index) => index).join(" ");
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
        await this.proceed(this.#threads.get(threadId));
      } else {
        await this.continueAll();
      }
    } else {
      // todo(simon): this needs a custom implementation, like in the above if branch
      //  especially when it comes to rr integration
      await this.reverseProceed(this.allStopMode ? undefined : threadId);
    }
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
    let breakpointIds = (this.#lineBreakpoints.get(path) ?? []).map((bkpt) => bkpt.id);
    if (breakpointIds.length > 0) {
      // we need this check. an "empty" param list to break-delete deletes all
      this.execMI(`-break-delete ${breakpointIds.join(" ")}`);
      this.#lineBreakpoints.set(path, []);
    }
  }

  // TODO(simon): List gdb functions we want / need to implement next

  // async listBreakpoints(location) {}

  /**
   *
   * @param {number} levels
   * @param {number} [threadId]
   * @returns {Promise<{ addr: string, arch: string, file: string, fullname:string, func:string, level:string, line:string }[]>}
   */
  async getStack(levels, threadId) {
    let command = `-stack-list-frames ${threadId != 0 ? `--thread ${threadId}` : ""} 0 ${levels}`;
    let { stack } = await this.execMI(command);
    return stack.map((frame) => {
      return frame.value;
    });
  }

  async getTrackedStack(exec_ctx, levels) {
    exec_ctx.stack = await this.getStack(levels, exec_ctx.threadId).then((r) =>
      r.map((frame, index) => {
        const stackFrameIdentifier = this.nextFrameRef;
        exec_ctx.stackFrameLocals.set(stackFrameIdentifier, {
          frameLevel: index,
          variables: [],
          registers: [],
        });

        this.varRefContexts.set(stackFrameIdentifier, {
          threadId: exec_ctx.threadId,
          frameLevel: index,
        });

        let r = new (require("vscode-debugadapter").StackFrame)(
          stackFrameIdentifier,
          `${frame.func} @ 0x${frame.addr}`,
          new (require("vscode-debugadapter").Source)(frame.file, frame.fullname),
          +frame.line,
          0
        );
        // we can't extend StackFrame for some reason. It is doing something magical behind the scenes. We have to brute-force
        // rape the type, and tack this on by ourselves. Embarrassing.
        r.frameAddress = +frame.addr;
        return r;
      })
    );
    let level = 0;
    for (let s of exec_ctx.stack) {
      const frameAddress = +(await this.readStackFrameStart(level++, exec_ctx.threadId));
      s.frameAddress = frameAddress;
    }
    // we must select top most stack frame again, since we've rolled through the stack, updating the stack frame addresses
    // or rather where they're origin address is, in memory
    await this.execMI(`-stack-select-frame 0`);
    return exec_ctx.stack;
  }

  threads() {
    return Array.from(this.#threads.values());
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
    const command = `-stack-list-variables --thread ${threadId} --frame ${frameLevel ?? 0} --simple-values`;
    const { variables } = await this.execMI(command);
    return variables.map(({ name, type, value }) => ({ name, type, value }));
  }

  /**
   *
   * @param {number} threadId
   * @param {number} frame
   * @returns {Promise<gdbTypes.VariableCompact[]>}
   */
  async getStackVariables(threadId, frame) {
    const { variables } = this.execMI(`stack-list-variables --frame ${frame} --simple-values`, threadId);
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
    let reason;
    try {
      reason = payload.reason.join(",");
    } catch {
      reason = payload.reason;
    }

    switch (reason) {
      case "breakpoint-hit": {
        this.#onBreakpointHit(payload.thread);
        let exec_ctx = this.executionContexts.get(payload.thread.id);
        if (exec_ctx.stack.length > 0) exec_ctx.stack[0].line = payload.thread.frame.line;
        break;
      }
      case "exited-normally": {
        this.sendEvent(new TerminatedEvent());
        break;
      }
      case "signal-received": {
        this.#onSignalReceived(payload.thread, payload);
        break;
      }
      case "end-stepping-range": {
        this.executionContexts.get(payload.thread.id).stack[0].line = payload.thread.frame.line;
        this.#target.sendEvent(new StoppedEvent("step", payload.thread.id));
        break;
      }
      case "function-finished": // this is a little crazy. But some times, payload.reason == ["function-finished", "breakpoint-hit"]
      case "function-finished,breakpoint-hit": {
        let exec_ctx = this.executionContexts.get(payload.thread.id);
        let top = exec_ctx.stack[0];
        let stackLocals = exec_ctx.stackFrameLocals.get(top.id);
        for (const v of stackLocals.variables) {
          this.execMI(`-var-delete ${v.voName}`, exec_ctx.threadId);
          this.varRefContexts.delete(v.variablesReference);
        }

        exec_ctx.stackFrameLocals.delete(top.id);
        this.varRefContexts.delete(top.id);
        exec_ctx.stack = exec_ctx.stack.splice(1);
        for (let s of exec_ctx.stack) {
          this.varRefContexts.get(s.id).frameLevel -= 1;
        }

        this.#target.sendEvent(new StoppedEvent("step", payload.thread.id));
        break;
      }
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

  #onThreadCreated(thread) {
    thread.name = this.#program;
    this.#threads.set(thread.id, thread);
    this.executionContexts.set(
      thread.id,
      new ExecutionState(thread.id, async (execstate) => {
        for (const frame of execstate.stackFrameLocals.values()) {
          for (const v of frame.variables) {
            await this.execMI(`-var-delete ${v.voName}`, execstate.threadId);
          }
        }
        execstate.stackFrameLocals.clear();
        execstate.structs.clear();
        execstate.stack = [];
      })
    );
    this.#target.sendEvent(new ThreadEvent("started", thread.id));
  }

  #onThreadExited(payload) {
    this.#threads.delete(payload.id);
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
  // eslint-disable-next-line no-unused-vars
  #onNotifyRunning(payload) {}

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
    // this does nothing, handled by onThreadCreated
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

  /**
   * @param {MidasVariable[]} variables - a reference to an array of variables that are to be changed
   */
  async updateMidasVariables(threadId, variables) {
    for (const v of variables) {
      if (!v.isStruct) {
        let r = (await this.execMI(`-var-evaluate-expression ${v.voName}`, threadId)).value;
        if (r) {
          v.value = r;
        }
      }
    }
  }

  /** Returns info about current stack frame.
   * @returns {Promise<{level: string, addr: string, func: string, file: string, fullname: string, line: string, arch: string}>}
   */
  async stackInfoFrame() {
    return this.execMI(`-stack-info-frame`)
      .then((r) => r.frame)
      .catch((e) => {
        console.log(`failed to get frame info: ${e}`);
        return null;
      });
  }

  generateVariableReference({ threadId, frameLevel }) {
    let nextRef = this.nextVarRef;
    this.varRefContexts.set(nextRef, { threadId, frameLevel });
    return nextRef;
  }

  selectStackFrame(frameLevel, threadId) {
    return this.execMI(`-stack-select-frame ${frameLevel}`, threadId);
  }

  readRBP(threadId) {
    return this.execMI(`-data-evaluate-expression $rbp`, threadId).then((r) => r.value);
  }

  async readStackFrameStart(frameLevel, threadId) {
    await this.execMI(`-stack-select-frame ${frameLevel}`, threadId);
    return this.readRBP(threadId);
  }
}

module.exports = {
  GDB,
  MidasVariable,
  MidasStackFrame,
};
