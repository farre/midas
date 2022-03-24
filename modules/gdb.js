/* eslint-disable max-len */
"use strict";
const gdbjs = require("gdb-js");
require("regenerator-runtime");
const vscode = require("vscode");
const { Source, ContinuedEvent } = require("@vscode/debugadapter");
const path = require("path");
const {
  InitializedEvent,
  StoppedEvent,
  BreakpointEvent,
  TerminatedEvent,
  ThreadEvent
} = require("@vscode/debugadapter");

const { GDBMixin, printOption, PrintOptions } = require("./gdb-mixin");
const { getFunctionName, spawn, isReplaySession, ArrayMap, ExclusiveArray } = require("./utils");
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
    // @ts-ignore
    allThreadsStopped,
    description,
    threadId: threadId,
  };
  return stopevt;
}

/** @constructor */
let GDBBase = gdbjs.GDB;
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

function spawn_settings(traceSettings) {
  return [["-iex", "set pagination off"], ["-iex", `source ${dir}/setup.py`], traceSettings.getCommandParameters(), ["-iex", `source ${dir}/stdlib.py`]];
}

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
  const MidasSetupArgs = spawn_settings(traceSettings);
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
  const MidasSetupArgs = spawn_settings(traceSettings);
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
    this.#target.sendEvent(new ThreadEvent("started", thread.id));
    console.log(`Thread ${thread.id} started`);
  }

  #onThreadExited(thread) {
    this.#threads.delete(thread.id);
    this.#uninitializedThread.delete(thread.id);
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
  // eslint-disable-next-line no-unused-vars
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
      // @ts-ignore
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
    // eslint-disable-next-line no-unused-vars
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

  async evaluateExpression(expr, frameId) {
    // todo(simon): needs implementation in new backend
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

}

exports.GDB = GDB;
exports.trace = trace;