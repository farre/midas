/* eslint-disable max-len */
"use strict";
const gdbjs = require("gdb-js");
require("regenerator-runtime");
const vscode = require("vscode");
const { Source, ContinuedEvent } = require("@vscode/debugadapter");
const { performance } = require('perf_hooks');
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

const { GDBMixin, printOption, PrintOptions } = require("./gdb-mixin");
const gdbTypes = require("./gdbtypes");
const { getFunctionName, spawn, isReplaySession, ArrayMap, ExclusiveArray } = require("./utils");
const { LocalsReference } = require("./variablesrequest/locals");
const { ExecutionContextState } = require("./executionContextState");
const { RegistersReference } = require("./variablesrequest/registers");
const {StackFrameState} = require("./variablesrequest/stackFramestate");
const {ArgsReference} = require("./variablesrequest/args");
let trace = false;
let LOG_ID = 0;
function log(location, payload) {
  if (!trace) {
    return;
  }
  console.log(`[LOG #${LOG_ID++}] - Caught GDB ${location}. Payload: ${JSON.stringify(payload, null, " ")}`);
}

/** @typedef { { addr: string, disp: string, enabled: string, file: string, fullname: string, func: string, line: string, number: string, "original-location": string, "thread-groups": string[], times: string, type: string } } GDBBreakpoint */
/**
 * @param {string} reason
 * @param {string} description
 * @param {boolean} allThreadsStopped
 * @param {number} threadId
 * @returns
 */
function newStoppedEvent(reason, description, allThreadsStopped, threadId = undefined) {
  let stopevt = new StoppedEvent(reason, threadId);
  stopevt.body = {
    reason,
    allThreadsStopped,
    description,
    threadId: threadId,
  };
  return stopevt;
}

/** @constructor */
let GDBBase = gdbjs.GDB;

// A bridge between GDB Variable Objects and VSCode "Variable" from the vscode-debugadapter module
class VSCodeVariable extends Variable {
  constructor(name, value, ref, variableObjectName, isStructureType, evaluateName) {
    super(name, value, ref);
    this.variableObjectName = variableObjectName;
    this.isStruct = isStructureType;
    if (isStructureType) {
      this.presentationHint = { kind: "class" };
    }
    this.evaluateName = evaluateName;
  }
}

class VSCodeStackFrame extends StackFrame {
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

  /** @type {number} */
  stackAddressStart;
  /** @type {string} */
  func;
}
const ext = vscode.extensions.getExtension("farrese.midas");
const dir = `${ext.extensionPath}/modules/python`;


const DefaultRRSpawnArgs = [
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
];

/**
 * @param {string} gdbPath - path to GDB
 * @param {import("./buildMode").MidasRunMode } traceSettings - trace settings
 * @param {string[]} setupCommands - GDB commands to execute before loading binary symbols
 * @param {string} binary - binary to debug
  * @param {string} serverAddress - server address rr is listening on
 * @param {string} cwd - current working directory to set GDB to
 * @returns
 */
function spawnRRGDB(gdbPath, traceSettings, setupCommands, binary, serverAddress, cwd) {
  const MidasSetupArgs = [["-iex", `source ${dir}/setup.py`], traceSettings.getCommandParameters(), ["-iex", `source ${dir}/stdlib.py`]];
  const spawnParameters =
    setupCommands
      .flatMap(c => ["-iex", `${c}`])
      .concat(MidasSetupArgs.flatMap(i => i))
      .concat([...DefaultRRSpawnArgs, "-ex", `target extended-remote ${serverAddress}`, "-i=mi3", binary, "-ex", `"set cwd ${cwd}"`])
  return spawn(gdbPath, spawnParameters);
}

/**
 * @param {string} gdbPath - path to GDB
 * @param {import("./buildMode").MidasRunMode } traceSettings - trace settings
 * @param {string[]} setupCommands - GDB commands to execute before loading binary symbols
 * @param {string} binary - binary to debug
 * @param {...string} args - arguments to pass to debuggee
 * @returns
 */
function spawnGDB(gdbPath, traceSettings, setupCommands, binary, ...args) {
  const MidasSetupArgs = [["-iex", `source ${dir}/setup.py`], traceSettings.getCommandParameters(), ["-iex", `source ${dir}/stdlib.py`]];
  const spawnParameters =
    setupCommands
      .flatMap(command => ["-iex", `${command}`])
      .concat(MidasSetupArgs.flatMap(i => i))
      .concat(!args ? ["-i=mi3", binary] : ["-i=mi3", "--args", binary, ...args]);
  let gdb = spawn(gdbPath, spawnParameters);
  return gdb;
}

let gdbProcess = null;
/** @typedef {number} ThreadId */
/** @typedef {number} VariablesReference */
/** @typedef { import("@vscode/debugadapter").DebugSession } DebugSession */
class GDB extends GDBMixin(GDBBase) {
  #lineBreakpoints = new ArrayMap();
  /** Maps function name (original location) -> Function breakpoint id
   * @type { Map<string, number> } */
  #fnBreakpoints = new Map();
  #watchpoints = new ExclusiveArray();
  vscodeBreakpoints = new Map();
  registerFile = [];
  // loaded libraries
  #loadedLibraries;
  // variablesReferences bookkeeping
  #nextVarRef = 1;
  /** @type {import("./debugSession").MidasDebugSession } */
  #target;
  // program name
  #program = "";
  // Are we debugging a normal session or an rr session
  #rrSession = false;

  /** @type { Map<ThreadId, ExecutionContextState> } */
  executionContexts = new Map();
  /** @typedef {import("./variablesrequest/registers").RegistersReference | import("./variablesrequest/args").ArgsReference | import("./variablesrequest/locals").LocalsReference | import("./variablesrequest/structs").StructsReference } VariablesReferenceHandler*/
  /** @type { Map<number, VariablesReferenceHandler >} */
  references = new Map();

  /** @type {Map<string, VariablesReference>} */
  evaluatable = new Map();

  /** @type {Map<number, { variableObjectName: string, memberVariables: VSCodeVariable[] }>} */
  evaluatableStructuredVars = new Map();

  #threads = new Map();
  // threads which we haven't been able to get systag for, yet
  #uninitializedThread = new Map();

  userRequestedInterrupt = false;
  allStopMode;

  constructor(target, args) {
    super(
      (() => {
        if (isReplaySession(args)) {
          let gdb = spawnRRGDB(args.gdbPath, target.buildSettings, args.setupCommands, args.program, args.serverAddress, args.cwd);
          gdbProcess = gdb;
          return gdb;
        } else {
          let gdb = spawnGDB(args.gdbPath, target.buildSettings, args.setupCommands, args.program, ...(args.args ?? []));
          gdbProcess = gdb;
          return gdb;
        }
      })()
    );
    this.#target = target;
  }

  /**
   * @param {ThreadId} threadId
   * @returns { ExecutionContextState }
   */
  getExecutionContext(threadId) {
    return this.executionContexts.get(threadId);
  }

  get nextVarRef() {
    return this.#nextVarRef++;
  }

  async setup() {
    /** @type {import("./buildMode").MidasRunMode } */
    let runModeSettings = this.#target.buildSettings;
    await runModeSettings.setProductionMode(this);
  }

  async reload_scripts() {
    let runModeSettings = this.#target.buildSettings;
    await runModeSettings.reloadStdLib(this);
  }

  async startWithRR(program, stopOnEntry) {
    this.#program = path.basename(program);
    trace = this.#target.buildSettings.trace;
    await this.init();
    // await this.attachOnFork();
    this.registerAsAllStopMode();
    // const { getVar, midasPy } = require("./scripts");
    await this.setup();
    this.#rrSession = true;
    await this.#setUpRegistersInfo();
    if (stopOnEntry) {
      // this recording might begin any time after main. But in that case, this breakpoint will just do nothing.
      await this.execMI("-exec-run --start");
    } else {
      await this.run();
    }
  }

  async start(program, stopOnEntry, allStopMode) {
    this.#program = path.basename(program);
    trace = this.#target.buildSettings.trace;
    this.allStopMode = allStopMode;
    vscode.commands.executeCommand("setContext", "midas.allStopModeSet", this.allStopMode);
    await this.init();
    // await this.setup();
    if (!allStopMode) {
      await this.enableAsync();
    } else {
      await this.execMI(`-gdb-set mi-async on`);
    }

    await this.#setUpRegistersInfo();
    const printOptions = [
      printOption(PrintOptions.HideStaticMembers),
      // printOption(PrintOptions.SetDepthMinimum),
      // printOption(PrintOptions.AddressOff),
      printOption(PrintOptions.PrettyStruct)
    ];
    await this.setPrintOptions(printOptions);
    if (stopOnEntry) {
      await this.execMI("-exec-run --start");
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
      await this.execCLI("reverse-continue");
    }
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
    const breakpointIds = this.#lineBreakpoints.safe_get(path).map((bkpt) => bkpt.id);
    if (breakpointIds.length > 0) {
      // we need this check. an "empty" param list to break-delete deletes all
      this.execMI(`-break-delete ${breakpointIds.join(" ")}`);
      this.#lineBreakpoints.delete(path);
    }
  }

  /** Removes all breakpoints set for `file` and adds the ones defined in `bpRequest`
   * @param { string } file
   * @param { { line: number, condition: string | undefined, hitCondition: number | undefined, threadId: number | undefined }[] } bpRequest
   * @returns { Promise<{ line: any; id: number; verified: boolean; enabled: boolean }[]> } res
   */
  async setBreakpointsInFile(file, bpRequest) {
    const breakpointIds = this.#lineBreakpoints.safe_get(file).map((bkpt) => bkpt.number);
    // clear previously set breakpoints
    if (breakpointIds.length > 0) {
      // we need this check. an "empty" param list to break-delete deletes all
      this.execMI(`-break-delete ${breakpointIds.join(" ")}`);
    }
    let res = [];
    // set new breakpoints
    let bps = [];
    for (const { line, condition, hitCondition, threadId } of bpRequest) {
      let breakpoint = await this.setConditionalBreakpoint(file, line, condition, threadId);
      if (hitCondition) await this.execMI(`-break-after ${breakpoint.number} ${hitCondition}`);
      if (breakpoint) {
        bps.push(breakpoint);
        res.push({
          line: breakpoint.line,
          id: +breakpoint.number,
          verified: breakpoint.addr != "<PENDING>",
          enabled: breakpoint.enabled == "y",
        });
      }
    }
    this.#lineBreakpoints.set(file, bps);
    return res;
  }

  async updateWatchpoints(wpRequest) {
    const { removeIndices, newIndices } = this.#watchpoints.unionIndices(wpRequest, (a, b) => a.id == b.id);
    if(removeIndices.length > 0) {
      const bpNumbers = removeIndices.map(idx => this.#watchpoints.get(idx).id);
      const cmdParameter = bpNumbers.join(" ");
      this.execMI(`-break-delete ${cmdParameter}`);
    }
    this.#watchpoints.pop(removeIndices);
    for(const idx of newIndices) {
      let item = wpRequest[idx];
      let wp;
      switch(item.accessType) {
        case "write": {
          wp = await this.setWatchPoint(item.dataId, "write");
        } break;
        case "read": {
          wp = await this.setWatchPoint(item.dataId, "read");
        } break;
        case "readWrite": {
          wp = await this.setWatchPoint(item.dataId, "access");
        } break;
      }
      item.id = wp.number;
      item.message = item.dataId;
      item.verified = true;
      this.#watchpoints.push(item);
    }
    const result = this.#watchpoints.data;
    return result;
  }

  /**
   *
   * @param {number} levels
   * @param {number} [threadId]
   * @returns {Promise<{ addr: string, arch: string, file: string, fullname:string, func:string, level:string, line:string }[]>}
   */
  async getStack(startFrame, levels, threadId) {
    const depth = await this.getStackDepth(threadId, startFrame + levels);
    if(depth <= startFrame) return [];
    const command = `-stack-list-frames ${startFrame} ${startFrame + levels}`;
    let { stack } = await this.execMI(command, threadId);
    return stack.map((frame) => {
      return frame.value;
    });
  }

  async getStackDepth(threadId, maxDepth) {
    const cmd = `-stack-info-depth ${maxDepth}`;
    const depth = await this.execMI(cmd, threadId);
    return +depth.depth;
  }

  async getCurrentFrameInfo(threadId) {
    const cmd = `-stack-info-frame`;
    const frame = await this.execMI(cmd, threadId);
    return frame.frame;
  }

  async threads() {
    let unit_threads = [...this.#uninitializedThread.values()];
    for(let t of unit_threads) {
      try {
        let r = await this.execMI(`-thread-info ${t.id}`)
        if(r.threads.length > 0) {
          let details = r.threads[0]["details"] ? ` (${r.threads[0]["details"]})` : "";
          this.#threads.get(t.id).name = `${r.threads[0]["target-id"]}${details}`;
          this.#uninitializedThread.delete(t.id);
        }
      } catch(err) {
        console.log("Thread is running...");
      }
    }
    let res = [];
    for(const t of this.#threads.values()) {
      res.push(t);
    }
    return res;
  }

  /**
   * @typedef {Object} Local
   * @property {string} name
   * @property {string} type
   * @property {string | null} value
   * @property {string | null} [arg]
   * @returns {Promise<Local[]>}
   */
  async getStackLocals(threadId, frameLevel) {
    const command = `-stack-list-variables --thread ${threadId} --frame ${frameLevel ?? 0} --simple-values`;
    const { variables } = await this.execMI(command);
    return variables;
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
      if ((payload.state ?? "") == "running") {
        // rr is all stop, it's all or nothing
        this.sendEvent(new ContinuedEvent(1, true));
      }
    } else {
      if (payload.data.reason == "exited-normally") {
        // rr has exited
        this.sendEvent(new TerminatedEvent());
      }
    }
  }

  async buildExecutionState(threadId, levels) {
    let ec = this.getExecutionContext(threadId);
    let frame = await this.getTopFrame(threadId);
    if(frame) {
      if (!ec.isSameContextAsCurrent(frame.stackAddressStart, frame.name)) {
        const start = await ec.setNewContext(frame.stackAddressStart, frame.name, this);
        // means we've not cleared state; add remaining frames to state (which for VSCode tend to be 20)
        if(start >= 0 && start < levels) {
          const remainder = levels - start;
          await this.newBuildExecutionState(threadId, start, remainder);
        }
      }
      if(ec.stack[0]) ec.stack[0].line = +frame.line;
    } else {
      // if we have no top frame, we're screwed any how
      await ec.clear(this);
    }
  }

  async newBuildExecutionState(threadId, start, levels)  {
    let ec = this.getExecutionContext(threadId);
    let frames  = await this.getStackTrace(threadId, start, levels);
    for(let f of frames) {
      const argsVarRef = this.nextVarRef;
      const frameIdVarRef = this.nextVarRef;
      const registerVarRef = this.nextVarRef;
      let state = new StackFrameState(frameIdVarRef, argsVarRef, threadId);
      this.references.set(registerVarRef, new RegistersReference(frameIdVarRef, threadId));
      this.references.set(frameIdVarRef, new LocalsReference(frameIdVarRef, threadId, argsVarRef, registerVarRef, state));
      this.references.set(argsVarRef, new ArgsReference(argsVarRef, threadId, state));
      ec.addTrackedVariableReference(registerVarRef, frameIdVarRef);
      ec.addTrackedVariableReference(argsVarRef, frameIdVarRef);
      f.id = frameIdVarRef;
      ec.pushStackFrame(f, state)
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
        let ec = this.executionContexts.get(payload.thread.id);
        ec.updateTopFrame(payload.thread.frame, this);
        this.sendEvent(newStoppedEvent("step", "Stepping finished", this.allStopMode, payload.thread.id));
        break;
      }
      case "function-finished": // this is a little crazy. But some times, payload.reason == ["function-finished", "breakpoint-hit"]
      case "function-finished,breakpoint-hit": {
        this.#target.sendEvent(newStoppedEvent("pause", "Function finished", this.allStopMode, payload.thread.id));
        break;
      }
      case "watchpoint-trigger":
      case "read-watchpoint-trigger": {
        let ec = this.executionContexts.get(payload.thread.id);
        ec.updateTopFrame(payload.thread.frame, this);
        this.sendEvent(newStoppedEvent("Watchpoint trigger", "Hardware watchpoint hit", this.allStopMode, payload.thread.id));
        break;
      }
      default:
        console.log(`stopped for other reason: ${payload.reason}`);
        this.sendEvent(new StoppedEvent("Unknown reason", payload.thread.id));
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
    thread.name = `${this.#program}`
    this.#uninitializedThread.set(thread.id, thread);
    this.#threads.set(thread.id, thread);
    this.executionContexts.set(thread.id, new ExecutionContextState(thread.id));
    this.#target.sendEvent(new ThreadEvent("started", thread.id));
    console.log(`Thread ${thread.id} started`);
  }

  #onThreadExited(thread) {
    this.#threads.delete(thread.id);
    this.#uninitializedThread.delete(thread.id);
    let ec = this.executionContexts.get(thread.id);
    if (ec) {
      // ec.releaseVariableReferences(this);
    }
    this.executionContexts.delete(thread.id);
    this.#target.sendEvent(new ThreadEvent("exited", thread.id));
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
  #onNotifyRunning(payload) { }

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
   *            addr: string | number,
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
  #onNotifyBreakpointCreated(payload) {
    try {
      let { number, addr, func, file, enabled, line } = payload.bkpt;
      let bp = {
        id: number,
        enabled: enabled == "y",
        verified: addr != "<PENDING>"
      };
      vscode.debug.activeDebugSession.getDebugProtocolBreakpoint(bp).then(dapbkpt => {
        if (!dapbkpt) {
          if(!file && !line) {
            if(payload.bkpt["original-location"].includes("::")) { // function breakpoint
              // todo(simon): implement. VSCode screws up breakpoints because of how it handles them.
            } else if(payload.bkpt["original-location"].includes(":")) { // source breakpoint
              const split = payload.bkpt["original-location"].split(":");
              const file = split[0];
              const line = split[1];
              const newBreakpoint = {
                id: +bp.id,
                enabled: bp.enabled,
                verified: bp.verified,
                source: new Source(file),
                line: +line
              };
              this.#lineBreakpoints.add_to(file, newBreakpoint);
              this.#target.sendEvent(new BreakpointEvent("new", newBreakpoint));
            }
          } else {
            if(func) {
              // see above todo
            } else {
              let pos = new vscode.Position(+line ?? 1 - 1, 0);
              let uri = vscode.Uri.parse(file);
              let loc = new vscode.Location(uri, pos);
              let newBreakpoint = new vscode.SourceBreakpoint(loc, bp.enabled);
              vscode.debug.addBreakpoints([newBreakpoint]);
              this.#lineBreakpoints.add_to(file, bp);
            }
          }
        }
        log(getFunctionName(), payload);
      });
    } catch(err) {
      console.log(`Failed to get VScode & DAP breakpoints`);
    }
  }

  /**
   * Reports that a breakpoint was modified.
   *
   * @param {{ bkpt: bkpt }} payload
   */
  #onNotifyBreakpointModified(payload) {
    const { number, type, disp, enabled, addr, func, file, fullname, line } = payload.bkpt;
    const num = payload.bkpt.number;
    const bp = {
      line: line,
      id: +num,
      verified: true,
      enabled: enabled == "y",
      source: new Source(file, fullname)
    };
    this.#target.sendEvent(new BreakpointEvent("changed", bp));
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
    return +(r.value);
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
   * Set a pending breakpoint, that might not resolve immediately.
   * @param {string} path - `path` to source code file
   * @param {number} line - `line` in file to break on
   * @param {number | undefined } threadId - thread this breakpoint belongs to; all threads if undefined
   * @returns { Promise<GDBBreakpoint> } bp
   */
  async setPendingBreakpoint(path, line, threadId = undefined) {
    const tParam = threadId ? ` -p ${threadId}` : "";
    const command = `-break-insert -f ${path}:${line}${tParam}`;
    try {
      let res = await this.execMI(command, threadId);
      let bp = res.bkpt;
      return bp;
    } catch (err) {
      console.log(`failed to execute set breakpoint command: ${command}:\n\t: ${err}`);
      return null;
    }
  }

  /**
   * Sets a software conditional pending breakpoint. These kinds of breakpoints incur a very large overhead.
   * @param {string} path
   * @param {number} line
   * @param {string} condition
   * @param {number} threadId
   * @returns { Promise<GDBBreakpoint> }
   */
  async setConditionalBreakpoint(path, line, condition, threadId = undefined) {
    if ((condition ?? "") == "") {
      let bp = await this.setPendingBreakpoint(path, line, threadId);
      if (bp) {
        this.registerBreakpoint(bp);
        return bp;
      } else {
        return null;
      }
    }
    const tParam = threadId ? `-p ${threadId}` : "";
    const cParam = `-c "${condition}"`;
    const breakpoint = await (this.execMI(`-break-insert -f ${cParam} ${tParam} ${path}:${line}`)).bkpt;
    this.registerBreakpoint(breakpoint);
    return breakpoint;
  }

  async deleteVariableObject(name) {
    this.execMI(`-var-delete ${name}`);
  }

  async createVariableObjectForPointerType(name, threadId) {
    const nextRef = this.generateVariableReference();
    const varObjectName = `vr_${nextRef}`;
    // notice the extra * -> we are dereferencing a this pointer
    const cmd = `-var-create ${varObjectName} * *${name}`;
    const result = await this.execMI(cmd, threadId);
    return { nextRef, varObjectName, result };
  }

  async createVariableObject(name, threadId) {
    const nextRef = this.generateVariableReference();
    const varObjectName = `vr_${nextRef}`;
    const cmd = `-var-create ${varObjectName} * ${name}`;
    const result = await this.execMI(cmd, threadId);
    return { nextRef, varObjectName, result };
  }

  registerBreakpoint(bp) {
    this.#lineBreakpoints.add_to(bp.file, bp);
  }

  clear() {
    this.executionContexts.clear();
    this.references.clear();
  }

  async replInput(expression) {
    if (expression.charAt(0) == "-") {
      // assume MI command, for now
      try {
        let r = await this.execMI(`${expression}`);
        return r;
      } catch (err) {
        console.log(`failed to run MI command: ${err}`);
        throw err;
      }
    } else {
      // assume CLI command, for now
      return await this.execCLI(`${expression}`);
    }
  }

  async requestMoreFrames(threadId, levels) {
    let res = await this.newRequestMoreFrames(threadId, levels);
    return res;
  }

  async oldRequestMoreFrames(threadId, levels) {
    let ec = this.getExecutionContext(threadId);
    try {
      // getStack throws if we're trying to request frames that do not exist.
      let frames = await this.getStack(ec.stack.length, levels, threadId);
      let result = [];
      let states = [];
      for (let frame of frames) {
        const stackFrameArgsIdentifier = this.nextVarRef;
        const stackFrameIdentifier = this.nextVarRef;
        const registerScopeVariablesReference = this.nextVarRef;
        this.references.set(registerScopeVariablesReference, new RegistersReference(stackFrameIdentifier, threadId));
        let state = new StackFrameState(stackFrameIdentifier, stackFrameArgsIdentifier, threadId);
        this.references.set(stackFrameIdentifier, new LocalsReference(stackFrameIdentifier, threadId, stackFrameArgsIdentifier, registerScopeVariablesReference, state));
        this.references.set(stackFrameArgsIdentifier, new ArgsReference(stackFrameArgsIdentifier, threadId, state));
        ec.addTrackedVariableReference(registerScopeVariablesReference, stackFrameArgsIdentifier);
        ec.addTrackedVariableReference(stackFrameArgsIdentifier, stackFrameArgsIdentifier);
        let src = null;
        if (frame.file && frame.line) {
          src = new Source(frame.file, frame.fullname);
        }
        let r = new StackFrame(stackFrameIdentifier, `${frame.func} @ 0x${frame.addr}`, src, +frame.line ?? 0, 0);
        r.func = frame.func;
        result.push(r);
        states.push(state);
      }

      let level = ec.stack.length;
      for (let i = 0; i < result.length; i++) {
        const stackAddressStart = +(await this.readStackFrameStart(level++, ec.threadId));
        result[i].stackAddressStart = stackAddressStart;
        ec.pushStackFrame(result[i], states[i]);
      }
      await this.selectStackFrame(0, ec.threadId);
      return result;
    } catch (e) {
      console.log(e);
      return [];
    }
  }

  async newRequestMoreFrames(threadId, levels) {
    let ec = this.getExecutionContext(threadId);
    let frames = await this.getStackTrace(threadId, ec.stack.length, levels);
    for (let frame of frames) {
      const stackFrameArgsIdentifier = this.nextVarRef;
      const stackFrameIdentifier = this.nextVarRef;
      const registerScopeVariablesReference = this.nextVarRef;
      this.references.set(registerScopeVariablesReference, new RegistersReference(stackFrameIdentifier, threadId));
      let state = new StackFrameState(stackFrameIdentifier, stackFrameArgsIdentifier, threadId);
      this.references.set(stackFrameIdentifier, new LocalsReference(stackFrameIdentifier, threadId, stackFrameArgsIdentifier, registerScopeVariablesReference, state));
      this.references.set(stackFrameArgsIdentifier, new ArgsReference(stackFrameArgsIdentifier, threadId, state));
      ec.addTrackedVariableReference(registerScopeVariablesReference, stackFrameArgsIdentifier);
      ec.addTrackedVariableReference(stackFrameArgsIdentifier, stackFrameArgsIdentifier);
      frame.id = stackFrameIdentifier
      ec.pushStackFrame(frame, state);
    }
    return frames;
  }

  newExecutionContext(threadId) {
    this.executionContexts.set(threadId, new ExecutionContextState(threadId));
    return this.gdb.getExecutionContext(threadId);
  }
}

exports.GDB = GDB;
exports.VSCodeVariable = VSCodeVariable;
exports.VSCodeStackFrame = VSCodeStackFrame;
exports.trace = trace;