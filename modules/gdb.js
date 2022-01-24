/* eslint-disable max-len */
"use strict";
const gdbjs = require("gdb-js");
require("regenerator-runtime");
const vscode = require("vscode");
const { Source } = require("@vscode/debugadapter");
const path = require("path");
const {
  InitializedEvent,
  StoppedEvent,
  BreakpointEvent,
  TerminatedEvent,
  ThreadEvent,
  Variable,
  StackFrame,
} = require("@vscode/debugadapter");

const { GDBMixin } = require("./gdb-mixin");
const gdbTypes = require("./gdbtypes");
const { getFunctionName, spawn, isReplaySession } = require("./utils");
const { LocalsReference } = require("./variablesrequest/mod");
const { ExecutionState } = require("./executionState");

let trace = true;
function log(location, payload) {
  if (!trace) {
    return;
  }
  console.log(`Caught GDB ${location}. Payload: ${JSON.stringify(payload, null, " ")}`);
}
/**
 * Prepares a stopped event body
 * @param {string} reason
 * @param {string} description
 * @param {boolean} allThreadsStopped
 * @returns
 */
function stoppedEventBody(reason, description, allThreadsStopped) {
  return {
    reason,
    allThreadsStopped,
    description,
  };
}

/** @constructor */
let GDBBase = gdbjs.GDB;

// A bridge between GDB Variable Objects and VSCode "Variable" from the vscode-debugadapter module
class MidasVariable extends Variable {
  constructor(name, value, ref, variableObjectName, isStructureType, evaluateName) {
    super(name, value, ref);
    this.voName = variableObjectName;
    this.isStruct = isStructureType;
    if (isStructureType) {
      this.presentationHint = { kind: "class" };
      this.evaluateName = evaluateName;
    }
  }
}

class MidasStackFrame extends StackFrame {
  /**
   *
   * @param {number} variablesReference
   * @param {string} name
   * @param {import("@vscode/debugadapter").Source} src
   * @param {number} ln
   * @param {?number} col
   */
  constructor(variablesReference, name, src, ln, col, frameAddress) {
    super(variablesReference, name, src, ln, col);
  }
}

function spawnRRGDB(gdbPath, binary, address) {
  const args = [
    "-l",
    "10000",
    "-iex",
    "set tcp connect-timeout 180", // if rr is taking time to start up, we want to wait. We set it to 3 minutes.
    "-iex",
    "set mi-async on",
    "-iex",
    "set non-stop off",
    "-ex",
    "set sysroot /",
    "-ex",
    `target extended-remote ${address}`,
    "-i=mi3",
    binary,
  ];
  return spawn(gdbPath, args);
}

function spawnGDB(gdbPath, binary, ...args) {
  let gdb = spawn(gdbPath, !args ? ["-i=mi3", binary] : ["-i=mi3", "--args", binary, ...args]);
  return gdb;
}

let gdbProcess = null;
/** @typedef {number} ThreadId */
/** @typedef {number} VariablesReference */
/** @typedef { import("@vscode/debugadapter").DebugSession } DebugSession */
class GDB extends GDBMixin(GDBBase) {
  /** Maps file paths -> Breakpoints
   * @type { Map<string, gdbTypes.Breakpoint[]> } */
  #lineBreakpoints = new Map();
  /** Maps function name (original location) -> Function breakpoint id
   * @type { Map<string, number> } */
  #fnBreakpoints = new Map();

  registerFile = [];
  // loaded libraries
  #loadedLibraries;
  // variablesReferences bookkeeping
  #nextVarRef = 1000 * 1000;
  #nextFrameRef = 1000;

  /**
   * reference to the DebugSession that talks to VSCode
   * @type { DebugSession }
   */
  #target;
  // program name
  #program = "";
  // Are we debugging a normal session or an rr session
  #rrSession = false;

  /** @type { Map<ThreadId, ExecutionState> } */
  executionContexts = new Map();

  /** @type { Map<number, import("./variablesrequest/reference").VariablesReference >} */
  references = new Map();

  /** @type {Map<string, VariablesReference>} */
  evaluatable = new Map();

  /** @type {Map<number, { variableObjectName: string, memberVariables: MidasVariable[] }>} */
  evaluatableStructuredVars = new Map();

  #threads = new Map();
  userRequestedInterrupt = false;
  allStopMode;

  constructor(target, args) {
    super(
      (() => {
        if (isReplaySession(args)) {
          let gdb = spawnRRGDB(args.gdbPath, args.program, args.replay.rrServerAddress);
          gdbProcess = gdb;
          return gdb;
        } else {
          let gdb = spawnGDB(args.gdbPath, args.program, args.debugeeArgs);
          gdbProcess = gdb;
          return gdb;
        }
      })()
    );
    this.#target = target;
  }

  /**
   * @param {ThreadId} threadId
   * @returns { ExecutionState }
   */
  getExecutionContext(threadId) {
    return this.executionContexts.get(threadId);
  }

  get nextVarRef() {
    return this.#nextVarRef++;
  }

  get nextFrameRef() {
    return this.#nextFrameRef++;
  }

  async startWithRR(program, stopOnEntry, doTrace) {
    this.#program = path.basename(program);
    trace = doTrace;
    await this.init();
    await this.attachOnFork();
    this.registerAsAllStopMode();
    this.#rrSession = true;
    if (stopOnEntry) {
      // this recording might begin any time after main. But in that case, this breakpoint will just do nothing.
      this.setFunctionBreakpoint("main");
    }
    await this.#setUpRegistersInfo();
    await this.run();

    this.#target.sendEvent(new StoppedEvent("entry", 1));
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
    await this.#setUpRegistersInfo();
    if (stopOnEntry) {
      await this.execMI("-exec-run");
    } else {
      await this.run();
    }
  }

  async restart(program, stopOnEntry) {
    this.clear();
    await this.execMI("-exec-interrupt");
    if (stopOnEntry) {
      await this.execMI("-exec-run");
    } else {
      if (this.#rrSession) {
        await this.execMI("-exec-run");
        await this.execMI(`-exec-continue`);
      } else {
        await this.run();
      }
    }
  }

  sendEvent(event) {
    this.#target.sendEvent(event);
  }

  setupEventHandlers(stopOnEntry) {
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
      await this.reverseProceed(threadId);
    }
  }

  /**
   * @param {string} path
   * @param {number} line
   * @returns { Promise<gdbTypes.Breakpoint> }
   */
  async setBreakPointAtLine(path, line) {
    const breakpoint = await this.setPendingBreakpoint(path, line);
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
    const { bkpt } = await this.execMI(`-break-insert -f ${name}`);
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

  /**
   *
   * @param {number} levels
   * @param {number} [threadId]
   * @returns {Promise<{ addr: string, arch: string, file: string, fullname:string, func:string, level:string, line:string }[]>}
   */
  async getStack(startFrame, levels, threadId) {
    let command = `-stack-list-frames ${threadId != 0 ? `--thread ${threadId}` : ""} ${startFrame} ${startFrame + levels}`;
    let { stack } = await this.execMI(command);
    return stack.map((frame) => {
      return frame.value;
    });
  }

  /**
   * @param { ExecutionState } exec_ctx
   * @param { number } levels
   * @returns
   */
  async getTrackedStack(exec_ctx, startFrame, levels) {
    // todo(simon): clean up. This function returns something and also mutates exec_ctx.stack invisibly from the callee's side.
    // This is ugly and bad, this needs refactoring.
    let frames = await this.getStack(startFrame, levels, exec_ctx.threadId);
    const vscStackFrames = frames.map((frame) => {
      const stackFrameIdentifier = this.nextFrameRef;
      this.references.set(stackFrameIdentifier, new LocalsReference(stackFrameIdentifier, exec_ctx.threadId, +frame.level));
      exec_ctx.addTrackedVariableReference({ id: stackFrameIdentifier, shouldManuallyDelete: true });
      let src = null;
      if (frame.file && frame.line) {
        src = new Source(frame.file, frame.fullname);
      }
      let r = new StackFrame(stackFrameIdentifier, `${frame.func} @ 0x${frame.addr}`, src, +frame.line ?? 0, 0);
      r.frameAddress = +frame.addr;
      return r;
    });

    exec_ctx.stack.push(...vscStackFrames);

    let level = 0;
    for (let s of exec_ctx.stack) {
      const frameAddress = +(await this.readStackFrameStart(level++, exec_ctx.threadId));
      s.frameAddress = frameAddress;
    }
    // we must select top most stack frame again, since we've rolled through the stack, updating the stack frame addresses
    // or rather where they're origin address is, in memory
    await this.execMI(`-stack-select-frame 0`);
    return exec_ctx.stack.slice(startFrame, startFrame + levels);
  }

  threads() {
    return Array.from(this.#threads.values());
  }

  /**
   * @typedef {Object} Local
   * @property {string} name
   * @property {string} type
   * @property {string | null} value
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
    if (this.#rrSession) {
      if ((payload.data["signal-name"] ?? "") == "SIGKILL" && (payload.data.frame.func ?? "") == "syscall_traced") {
        // replayable binary has executed to it's finish; we're now in rr-land
        let evt = new StoppedEvent("pause", 1);
        this.#target.sendEvent(evt);
        return;
      }
      if (payload.data.reason == "exited-normally") {
        // rr has exited
        this.sendEvent(new StoppedEvent("replay ended"));
        return;
      }
    } else {
      if (payload.data.reason == "exited-normally") {
        // rr has exited
        this.sendEvent(new TerminatedEvent());
      }
    }
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
        break;
      }
      case "exited-normally": {
        if (!this.#rrSession) this.sendEvent(new TerminatedEvent());
        else {
          this.sendEvent(new StoppedEvent("replay ended"));
        }
        break;
      }
      case "signal-received": {
        this.#onSignalReceived(payload.thread, payload);
        break;
      }
      case "end-stepping-range": {
        this.executionContexts.get(payload.thread.id).stack[0].line = payload.thread.frame.line;
        let evt = new StoppedEvent("step", payload.thread.id);
        evt.body = {
          reason: "step",
          allThreadsStopped: this.allStopMode,
          description: "Stepping finished",
          threadId: payload.thread.id,
        };
        this.sendEvent(evt);
        break;
      }
      case "function-finished": // this is a little crazy. But some times, payload.reason == ["function-finished", "breakpoint-hit"]
      case "function-finished,breakpoint-hit": {
        let evt = new StoppedEvent("step", payload.thread.id);
        evt.body = {
          reason: "pause",
          allThreadsStopped: this.allStopMode,
          description: "Function finished",
          threadId: payload.thread.id,
        };
        this.#target.sendEvent(evt);
        break;
      }
      case "read-watchpoint-trigger": {
        let exec_ctx = this.executionContexts.get(payload.thread.id);
        let evt = new StoppedEvent("step", payload.thread.id);
        evt.body = stoppedEventBody("Watchpoint", "Hardware watchpoint hit", this.allStopMode);
        if (exec_ctx.stack.length > 0) {
          const frameAddress = this.readRBP(payload.thread.id);
          if (frameAddress == exec_ctx.stack[0].frameAddress) {
            exec_ctx.stack[0].line = payload.thread.frame.line;
          } else {
            exec_ctx.clear(this);
          }
        }
        this.#target.sendEvent(evt);
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
    this.executionContexts.set(thread.id, new ExecutionState(thread.id));
    this.#target.sendEvent(new ThreadEvent("started", thread.id));
  }

  #onThreadExited(payload) {
    this.#threads.delete(payload.id);
    if (!this.#rrSession) {
      let ec = this.executionContexts.get(payload.id);
      if (ec) ec.clear(this);
      this.executionContexts.delete(payload.id);
    } else {
      // just clear state - user might decide to rewind.
      let ec = this.executionContexts.get(payload.id);
      if (ec) ec.clear(this);
    }
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
   * @param { { bkpt: bkpt } } payload
   */
  async #onNotifyBreakpointCreated(payload) {
    const { number, addr, func, file, enabled, line } = payload.bkpt;
    let bp = {
      id: `${number}`,
      enabled: enabled == "y",
    };
    let dapbkpt = await vscode.debug.activeDebugSession.getDebugProtocolBreakpoint(bp);
    if (!dapbkpt) {
      let pos = new vscode.Position(+line - 1, 0);
      let uri = vscode.Uri.parse(file);
      let loc = new vscode.Location(uri, pos);
      let src_bp = new vscode.SourceBreakpoint(loc, bp.enabled);
      vscode.debug.addBreakpoints([src_bp]);
    }
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
    let exec_ctx = this.executionContexts.get(thread.id);
    if (exec_ctx.stack.length > 0) exec_ctx.stack[0].line = thread.frame.line;
    this.sendEvent(stopEvent);
  }

  // eslint-disable-next-line no-unused-vars
  #onSignalReceived(thread, code) {
    const THREADID = thread.id;
    // we do not pass thread id, because if the user hits pause, we want to interrupt _everything_
    let stopEvent = new StoppedEvent("pause", THREADID);
    let body = {
      reason: stopEvent.body.reason,
      allThreadsStopped: true,
      threadId: THREADID,
      description: "Interrupted by signal",
    };
    stopEvent.body = body;
    this.sendEvent(stopEvent);
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
    let miResult = await this.execMI(`-stack-info-frame`);
    return miResult.frame;
  }

  generateVariableReference() {
    let nextRef = this.nextVarRef;
    return nextRef;
  }

  generateEvalsVarRef() {
    let nextRef = this.nextVarRef;
    return nextRef;
  }

  selectStackFrame(frameLevel, threadId) {
    return this.execMI(`-stack-select-frame ${frameLevel}`, threadId);
  }

  async readRBP(threadId) {
    let r = await this.execMI(`-data-evaluate-expression $rbp`, threadId);
    return r.value;
  }

  async readProgramCounter(threadId) {
    let r = await this.execMI(`-data-evaluate-expression $pc`, threadId);
    return r.value;
  }

  async readStackFrameStart(frameLevel, threadId) {
    await this.execMI(`-stack-select-frame ${frameLevel}`, threadId);
    return this.readRBP(threadId);
  }

  async evaluateExpression(expr, frameId) {
    let ref = this.references.get(frameId);
    const threadId = ref.threadId;
    const voName = `${expr}.${frameId}`;
    if (this.evaluatable.has(voName)) {
      const res = await this.execMI(`-var-evaluate-expression ${voName}`, threadId);
      let ref = this.evaluatable.get(voName);
      return {
        variablesReference: ref,
        value: res.value,
      };
    } else {
      const res = await this.execMI(`-var-create ${voName} @ ${expr}`, threadId);
      if (res.numchild > 0) {
        let nextRef = this.nextVarRef;
        this.evaluatable.set(voName, nextRef);
        let result = {
          variablesReference: nextRef,
          value: res.type,
        };
        this.evaluatableStructuredVars.set(nextRef, {
          variableObjectName: voName,
          memberVariables: [],
        });
        return result;
      } else {
        this.evaluatable.set(voName, 0);
        return {
          variablesReference: 0,
          value: res.value,
        };
      }
    }
  }

  getReferenceContext(variablesReference) {
    return this.references.get(variablesReference);
  }

  kill() {
    gdbProcess.kill("SIGINT");
  }

  // tells the frontend that we're all stop mode, so we can read this value and disable non-stop UI elements for instance
  registerAsAllStopMode() {
    this.allStopMode = true;
    vscode.commands.executeCommand("setContext", "midas.allStopModeSet", true);
  }

  async #setUpRegistersInfo() {
    let miResult = await this.execMI(`-data-list-register-names`);
    let lastGPR = miResult["register-names"].findIndex((item) => item == "gs");
    this.registerFile = miResult["register-names"].splice(0, lastGPR + 1);
    this.generalPurposeRegCommandString = this.registerFile.map((v, index) => index).join(" ");
  }

  /**
   * Sets pending breakpoint
   */
  async setPendingBreakpoint(path, line, threadId = undefined) {
    const tParam = threadId ? `-p ${threadId}` : "";
    return await this.execMI(`-break-insert -f ${path}:${line} ${tParam}`).then((r) => r.bkpt);
  }

  /**
   * Sets conditional pending breakpoint
   */
  async setConditionalBreakpoint(path, line, condition, threadId = undefined) {
    if ((condition ?? "") == "") {
      let bp = await this.setPendingBreakpoint(path, line, threadId);
      this.registerBreakpoint(bp);
      return bp;
    }
    const tParam = threadId ? `-p ${threadId}` : "";
    const cParam = `-c "${condition}"`;
    let breakpoint = await this.execMI(`-break-insert -f ${cParam} ${tParam} ${path}:${line}`).then((r) => r.bkpt);
    this.registerBreakpoint(breakpoint);
    return breakpoint;
  }

  async deleteVariableObject(name) {
    this.execMI(`-var-delete ${name}`);
  }

  registerBreakpoint(bp) {
    let bps = this.#lineBreakpoints.get(bp.file) ?? [];
    if (!bps.some((b) => bp.number == b.id)) {
      bps.push(bp);
    }
    this.#lineBreakpoints.set(bp.file, bps);
  }

  interrupt() {}

  clear() {
    this.executionContexts.clear();
    this.references.clear();
  }
}

exports.GDB = GDB;
exports.MidasVariable = MidasVariable;
exports.MidasStackFrame = MidasStackFrame;
