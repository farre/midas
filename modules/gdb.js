/* eslint-disable max-len */
"use strict";
const gdbjs = require("gdb-js");
require("regenerator-runtime");
const vscode = require("vscode");
const { Source, ContinuedEvent, OutputEvent } = require("@vscode/debugadapter");
const path = require("path");
const {
  InitializedEvent,
  StoppedEvent,
  BreakpointEvent,
  TerminatedEvent,
  ThreadEvent,
} = require("@vscode/debugadapter");

// POSIX signals and their descriptions
const SIGNALS = {
  SIGHUP: { code: 1, description: "Hangup" },
  SIGINT: { code: 2, description: "Terminal interrupt" },
  SIGQUIT: { code: 3, description: "Terminal quit" },
  SIGILL: { code: 4, description: "Illegal instruction" },
  SIGTRAP: { code: 5, description: "Trace trap" },
  SIGABRT: { code: 6, description: "Aborted" },
  SIGIOT: { code: 6, description: "IOT Trap" },
  SIGBUS: { code: 7, description: "BUS error" },
  SIGFPE: { code: 8, description: "Floating point exception" },
  SIGKILL: { code: 9, description: "Kill" },
  SIGUSR1: { code: 10, description: "User defined signal 1" },
  SIGSEGV: { code: 11, description: "Invalid memory reference" },
  SIGUSR2: { code: 12, description: "User defined signal 2 (POSIX)" },
  SIGPIPE: { code: 13, description: "Broken pipe" },
  SIGALRM: { code: 14, description: "Alarm clock" },
  SIGTERM: { code: 15, description: "Terminated" },
  SIGSTKFLT: { code: 16, description: "Stack fault" },
  SIGCHLD: { code: 17, description: "Child Signal" },
  SIGCONTv: { code: 18, description: "Continue executing, if stopped" },
  SIGSTOP: { code: 19, description: "Stopped process" },
  SIGTSTP: { code: 20, description: "Terminal stop signal" },
  SIGTTIN: { code: 21, description: "Background process trying to read, from TTY" },
  SIGTTOU: { code: 22, description: "Background process trying to write, to TTY" },
  SIGURG: { code: 23, description: "Urgent condition on socket" },
  SIGXCPU: { code: 24, description: "CPU limit exceeded" },
  SIGXFSZ: { code: 25, description: "File size limit exceeded" },
  SIGVTALRM: { code: 26, description: "Virtual alarm clock" },
  SIGPROF: { code: 27, description: "Profiling alarm clock" },
  SIGWINCH: { code: 28, description: "Window size change" },
  SIGIO: { code: 29, description: "I/O now possible" },
  SIGPWR: { code: 30, description: "Power failure restart" },
};

function ui_prepare_signal_display(sig_desc, message) {
  if (message) return `Signal caught [ ${sig_desc} ]: ${message}`;
  else return `Signal caught [${sig_desc}]`;
}

const { GDBMixin, printOption, PrintOptions } = require("./gdb-mixin");
const {
  getFunctionName,
  spawnExternalConsole,
  ArrayMap,
  ExclusiveArray,
  showErrorPopup,
  strEmpty,
  strValueOr
} = require("./utils/utils");
const { spawnGdb } = require("./spawn");
const { CustomRequests, ContextKeys } = require("./constants");
const { getExtensionPathOf } = require("./utils/sysutils");
let trace = false;
let LOG_ID = 0;

/** @typedef { { addr: string, disp: string, enabled: string, file: string, fullname: string, func: string, line: string, number: string, "original-location": string, "thread-groups": string[], times: string, type: string } } GDBBreakpoint */

/** @constructor */
let GDBBase = gdbjs.GDB;

let gdbProcess = null;
/** @typedef {number} ThreadId */
/** @typedef {number} VariablesReference */
/** @typedef { import("@vscode/debugadapter").DebugSession } DebugSession */
class GDB extends GDBMixin(GDBBase) {
  #lineBreakpoints = new ArrayMap();
  #fnBreakpoints = new Map();
  #watchpoints = new ExclusiveArray();
  vscodeBreakpoints = new Map();
  // loaded libraries
  #loadedLibraries;
  /** @type {import("./debugSession").MidasDebugSession } */
  #target;
  // program name
  #program = "";

  #threads = new Map();
  // threads which we haven't been able to get systag for, yet
  #uninitializedThread = new Map();

  userRequestedInterrupt = false;

  noSingleThreadControl;

  // we push exception-info related data onto this, so that we can reach it from `exceptionInfoRequest` when needed.
  threadExceptionInfos = new Map();

  /**
   * @param { import("./debugSession").MidasDebugSession } target
   * @param { import("./spawn").SpawnConfig } config
   */
  constructor(target, config) {
    super(
      (() => {
        const gdb = spawnGdb(config, target);
        gdbProcess = gdb;
        return gdb;
      })()
    );
    this.#target = target;
    this.config = config;
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

  async startWithRR(program, stopOnEntry, isRemote) {
    try {
      this.#program = path.basename(program);
    } catch (ex) {
      this.#program = "unknown";
    }

    trace = this.#target.buildSettings.trace;
    await this.init();
    this.#target.customRequest(CustomRequests.ClearCheckpoints);
    if (this.#target.getSpawnConfig().attachOnFork) {
      await this.attachOnFork();
    }

    this.setNoSingleThreadControl();
    await this.setup();
    if (this.config.externalConsole) {
      this.#target.registerTerminal(this.#target.terminal, () => {
        this.atExitCleanUp();
        this.sendEvent(new TerminatedEvent(false));
      });
    }
    // re-define restart according to how rr does it.
    this.execCLI(`source ${getExtensionPathOf("/modules/.gdb_rrinit")}`);
    const printOptions = [printOption(PrintOptions.HideStaticMembers), printOption(PrintOptions.PrettyStruct)];
    await this.setPrintOptions(printOptions);
    if (!isRemote) {
      if (stopOnEntry) {
        await this.execMI("-exec-run --start");
      } else {
        await this.run();
      }
    }
  }

  async attach_start() {
    trace = this.#target.buildSettings.trace;
    this.noSingleThreadControl = true;
    vscode.commands.executeCommand("setContext", ContextKeys.NoSingleThreadControl, this.noSingleThreadControl);
    await this.init();
    const printOptions = [printOption(PrintOptions.HideStaticMembers), printOption(PrintOptions.PrettyStruct)];
    await this.setPrintOptions(printOptions);
    await this.execCLI("set breakpoint pending on");
    await this.config.performGdbSetup(this);
  }

  /**
   * @param {{program: string, stopOnEntry: boolean, noSingleThreadControl: boolean, externalConsole: {path: string, closeTerminalOnEndOfSession: boolean, endSessionOnTerminalExit: boolean} | null }} args
   * @param { import("./spawn").SpawnConfig } config
   */
  async start(args, config) {
    const { program, stopOnEntry, noSingleThreadControl, externalConsole } = args;
    if (externalConsole != null) {
      const { path, closeTerminalOnEndOfSession, endSessionOnTerminalExit } = externalConsole;
      try {
        this.#target.registerTerminal(
          await spawnExternalConsole({ terminal: path, closeOnExit: closeTerminalOnEndOfSession }),
          () => {
            if (endSessionOnTerminalExit) {
              this.atExitCleanUp();
              this.sendEvent(new TerminatedEvent(false));
            }
          }
        );
      } catch (err) {
        showErrorPopup("Spawning an external console failed.");
        this.atExitCleanUp();
        this.sendEvent(new TerminatedEvent(false));
      }
    }

    this.#program = path.basename(program);
    trace = this.#target.buildSettings.trace;
    this.noSingleThreadControl = noSingleThreadControl;
    vscode.commands.executeCommand("setContext", ContextKeys.NoSingleThreadControl, this.noSingleThreadControl);
    await this.init();
    if (!noSingleThreadControl) {
      await this.enableAsync();
    }

    const printOptions = [printOption(PrintOptions.HideStaticMembers), printOption(PrintOptions.PrettyStruct)];
    if (this.#target.terminal) {
      await this.execCLI(`set inferior-tty ${this.#target.terminal.tty.path}`);
    }
    await this.execCLI("set breakpoint pending on");
    await this.setPrintOptions(printOptions);
    if (this.#target.getSpawnConfig().attachOnFork) {
      await this.attachOnFork();
    }
    config.performGdbSetup(this);
    if (stopOnEntry) {
      try {
        await this.execMI("-exec-run --start");
      } catch (ex) {
        this.debugConsole(`Couldn't set breakpoint at main; ${ex}. Setting pending breakpoint`);
        this.execCLI("b main");
        this.run();
      }
    } else {
      await this.run();
    }
  }

  async restart(program, stopOnEntry) {
    // todo(simon): create a reset request for the python backend.
    await this.execMI("-exec-interrupt");
    if (stopOnEntry) {
      await this.execMI("-exec-run");
    } else {
      if (this.config.isRRSession()) {
        await this.execMI("-exec-run");
        await this.execMI(`-exec-continue`);
      } else {
        await this.run();
      }
    }
  }

  /**
   * Send output to the Session's debug console
   * @param {string} output - the string contents to be displayed in the Debug Console of user
   */
  debugConsole(output) {
    const evt = new OutputEvent(output, "console");
    this.sendEvent(evt);
  }

  sendEvent(event) {
    this.#target.sendEvent(event);
  }

  setupEventHandlers(stopOnEntry) {
    this.on("notify", this.#onNotify.bind(this));
    this.on("exec", this.#onExec.bind(this));

    if (stopOnEntry) {
      this.once("stopped", this.#onStopOnEntry.bind(this));
    }

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
      if (threadId && !this.noSingleThreadControl) {
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

  async removeFnBreakpointsNotInList(names) {
    let remove_names = [];
    let remove_ids = [];
    for (let { name, id } of this.#fnBreakpoints.values()) {
      if (!names.includes(name)) {
        remove_names.push(name);
        remove_ids.push(id);
      }
    }
    for (const name of remove_names) this.#fnBreakpoints.delete(name);
    const del = remove_ids.join(" ");
    if (del.length > 0) {
      await this.execMI(`-break-delete ${del}`);
    }
  }

  // eslint-disable-next-line no-unused-vars
  async setFunctionBreakpoint(name, condition, hitCondition) {
    let bp = this.#fnBreakpoints.get(name);
    if (!bp) {
      const { bkpt } = await this.execMI(`-break-insert -f ${name}`);
      bp = { name, id: bkpt.number, verified: bkpt.pending ? false : true };
      this.#fnBreakpoints.set(name, bp);
    }
    return bp;
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
    const breakpointIds = this.#lineBreakpoints.safe_get(file).map((bkpt) => bkpt.id);
    // clear previously set breakpoints
    if (breakpointIds.length > 0) {
      // we need this check. an "empty" param list to break-delete deletes all
      this.execMI(`-break-delete ${breakpointIds.join(" ")}`);
    }
    // set new breakpoints
    let bps = [];
    for (const { line, condition, hitCondition, threadId } of bpRequest) {
      let breakpoint = await this.setConditionalBreakpoint(file, line, condition, threadId);
      if (hitCondition) await this.execMI(`-break-after ${breakpoint.id} ${hitCondition}`);
      if (breakpoint) {
        bps.push(breakpoint);
      }
    }
    this.#lineBreakpoints.set(file, bps);
    return bps;
  }

  async updateWatchpoints(wpRequest) {
    const { removeIndices, newIndices } = this.#watchpoints.unionIndices(wpRequest, (a, b) => a.id == b.id);
    if (removeIndices.length > 0) {
      const bpNumbers = removeIndices.map((idx) => this.#watchpoints.get(idx).id);
      const cmdParameter = bpNumbers.join(" ");
      this.execMI(`-break-delete ${cmdParameter}`);
    }
    this.#watchpoints.pop(removeIndices);
    for (const idx of newIndices) {
      let item = wpRequest[idx];
      let wp;
      switch (item.accessType) {
        case "write":
          wp = await this.setWatchPoint(item.dataId, "write");
          break;
        case "read":
          wp = await this.setWatchPoint(item.dataId, "read");
          break;
        case "readWrite":
          wp = await this.setWatchPoint(item.dataId, "access");
          break;
      }
      item.id = wp.number;
      item.message = item.dataId;
      item.verified = true;
      item.description = item.dataId;
      this.#watchpoints.push(item);
    }
    const result = this.#watchpoints.data;
    return result;
  }

  async threads() {
    let unit_threads = [...this.#uninitializedThread.values()];
    for (let t of unit_threads) {
      try {
        let r = await this.execMI(`-thread-info ${t.id}`);
        if (r.threads.length > 0) {
          // this is terrible. But sometimes it returns a ".name", some times it's ".details"
          // lastly it's "target-id". Fallback is name => details => target-id
          let thread_name = strValueOr(r.threads[0].name, r.threads[0].details);
          thread_name = strValueOr(thread_name, r.threads[0]["target-id"]);
          const name = `[${t.id}]: ${thread_name}`;
          this.#threads.get(t.id).name = name;
          this.#uninitializedThread.delete(t.id);
        }
      } catch (err) {
        console.log("Thread is running...");
      }
    }
    let res = [];
    for (const t of this.#threads.values()) {
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
  async #onNotify(payload) {
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
        await this.#onNotifyBreakpointCreated(payload.data);
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

  #onSignalNotifyVsCode(signalPayload) {
    let threadId = +signalPayload["thread-id"];
    let evt = new StoppedEvent("exception", threadId);
    // set except_info for VSCode to pluck out in `exceptionInfoRequest`
    this.threadExceptionInfos.set(threadId, {
      exceptionId: signalPayload["signal-name"],
      description: ui_prepare_signal_display(SIGNALS[signalPayload["signal-name"]].description),
      breakMode: "always",
      details: {
        message: "No additional information",
        typeName: signalPayload["signal-name"],
        stackTrace: "",
      },
    });
    let body = {
      reason: "exception",
      description: ui_prepare_signal_display(SIGNALS[signalPayload["signal-name"]].description),
      threadId: threadId,
      allThreadsStopped: signalPayload["stopped-threads"] == "all",
    };
    evt.body = body;
    this.sendEvent(evt);
  }

  #onSignal(payload) {
    switch (payload.data["signal-name"]) {
      case "SIGKILL":
        // rr
        if (payload.data.frame.func == "syscall_traced") {
          let evt = new StoppedEvent(
            `${SIGNALS[payload.data["signal-name"]].description}: replay end`,
            +payload.data["thread-id"]
          );
          const body = {
            reason: "exception",
            description: ui_prepare_signal_display(SIGNALS[payload.data["signal-name"]].description, "Replay ended"),
            text: "rr replay ended",
            threadId: +payload.data["thread-id"],
            allThreadsStopped: true,
          };
          evt.body = body;
          this.sendEvent(evt);
        } else {
          this.#onSignalNotifyVsCode(payload.data);
        }
        break;
      case "0": {
        if (this.config.isRRSession() && !this.paused) {
          // replayable binary has executed to it's start; we're now in rr-land
          let evt = new StoppedEvent("entry", 1);
          let body = {
            reason: "entry",
            description: "rr trampoline code",
            threadId: 1,
            allThreadsStopped: true,
          };
          evt.body = body;
          this.sendEvent(evt);
        } else if (this.paused) {
          let evt = new StoppedEvent("entry", 1);
          let body = {
            reason: "stopped",
            description: "Interrupted",
            threadId: 1,
            allThreadsStopped: true,
          };
          evt.body = body;
          this.sendEvent(evt);
        }
        break;
      }
      default: {
        this.#onSignalNotifyVsCode(payload.data);
      }
    }
  }

  createStoppedEvent(reason, desc, threadId, allThreadsStopped, hitBreakpointIds) {
    const safeParseHitBps = (bp) => {
      if (bp == null) return [];
      try {
        return [+bp];
      } catch (ex) {
        return [];
      }
    };

    const safeParseThreadId = (thr) => {
      try {
        let threadId = Number.parseInt(thr);
        if (Number.isNaN(threadId)) return null;
        return threadId;
      } catch (ex) {
        console.log(`Couldn't parse ${thr} for stopped event`);
        return null;
      }
    };

    return {
      event: "stopped",
      body: {
        reason: reason,
        description: desc,
        threadId: safeParseThreadId(threadId),
        allThreadsStopped: allThreadsStopped,
        hitBreakpointIds: safeParseHitBps(hitBreakpointIds)
      }
    };
  }

  registerExceptionInfo(thread, exceptionId, description, msg, typeName) {
    this.threadExceptionInfos.set(thread, {
      exceptionId: exceptionId,
      description: description,
      breakMode: "always",
      details: {
        message: msg,
        typeName: typeName,
        stackTrace: msg,
      },
    });
  }

  handleExecStopped(data) {
    vscode.commands.executeCommand("setContext", ContextKeys.Running, false);
    switch (data.reason) {
      case "breakpoint-hit":
        return this.createStoppedEvent("breakpoint", "Hit breakpoint", data["thread-id"], data["stopped-threads"] == "all", data.bkptno);
      case "signal-received":
        switch (data["signal-name"]) {
          case "SIGKILL":
            // rr
            if (this.config.isRRSession() && data.frame.func == "syscall_traced") {
              return this.createStoppedEvent("exception", ui_prepare_signal_display(SIGNALS[data["signal-name"]].description, "Replay ended"), data["thread-id"], true, null);
            } else {
              return this.createStoppedEvent("exception", ui_prepare_signal_display(SIGNALS[data["signal-name"]].description), data["thread-id"], data["stopped-threads"] == "all", data.bkptno);
            }
          case "0": {
            if (this.config.isRRSession() && !this.paused) {
              return this.createStoppedEvent("entry", "rr trampoline", 1, true, null);
            } else if (this.paused) {
              let evt = new StoppedEvent("entry", 1);
              let body = {
                reason: "stopped",
                description: "Interrupted",
                threadId: 1,
                allThreadsStopped: true,
              };
              evt.body = body;
              return evt;
            }
            break;
          }
          default: {
            const threadId = +data["thread-id"];
            const desc = ui_prepare_signal_display(SIGNALS[data["signal-name"]].description);
            // set except_info for VSCode to pluck out in `exceptionInfoRequest`
            this.registerExceptionInfo(threadId, data["signal-name"], desc, "", data["signal-name"]);
            return this.createStoppedEvent("exception", desc, threadId, data["stopped-threads"] == "all", null);
          }
        }
        break;
      case "exited-normally":
        return new TerminatedEvent();
      case "end-stepping-range": {
        return this.createStoppedEvent("step", "Stepping finished", data["thread-id"], data["stopped-threads"] == "all", data.bkptno);
      }
      case "function-finished": // this is a little crazy. But some times, payload.reason == ["function-finished", "breakpoint-hit"]
      case "function-finished,breakpoint-hit": {
        return this.createStoppedEvent("breakpoint", "Hit finish breakpoint", data["thread-id"], data["stopped-threads"] == "all", data.bkptno);
      }
      case "access-watchpoint-trigger":
      case "watchpoint-trigger":
      case "read-watchpoint-trigger": {
        const wp_msg = `Old value: ${data.value.old}\nNew value: ${data.value.new}`;
        this.registerExceptionInfo(+data["thread-id"], `Watchpoint`, "Watch point triggered", wp_msg, data.reason);
        return this.createStoppedEvent("exception", "Hit watchpoint", data["thread-id"], data["stopped-threads"] == "all", data.bkptno);
      }
      default: {
        let reason = "pause";
        if (data.frame && data.frame.func == "_start") {
          reason = "entry";
        }
        return this.createStoppedEvent(reason, "Stopped", data["thread-id"], data["stopped-threads"] == "all", null);
      }
    }
  }

  handleExecRunning(data) {
    let allContinued = false;
    if (data["thread-id"] == "all") {
      allContinued = true;
    }
    let threadId = Number.parseInt(data["thread-id"]);
    if (Number.isNaN(threadId)) {
      threadId = 1;
    }
    return new ContinuedEvent(threadId, allContinued);
  }

  #onExec(payload) {
    this.log(getFunctionName(), payload);
    switch (payload.state) {
      case "stopped": {
        const event = this.handleExecStopped(payload.data);
        this.sendEvent(event);
        return;
      }
      case "running": {
        const event = this.handleExecRunning(payload.data);
        this.sendEvent(event);
        return;
      }
    }
  }

  #onStopOnEntry(payload) {
    const THREADID = payload.thread.id;
    this.sendEvent(new StoppedEvent("entry", THREADID));
  }

  #onThreadCreated(thread) {
    thread.name = `${this.#program}`;
    this.#uninitializedThread.set(thread.id, thread);
    this.#threads.set(thread.id, thread);
    this.sendEvent(new ThreadEvent("started", thread.id));
  }

  #onThreadExited(thread) {
    this.#threads.delete(thread.id);
    this.#uninitializedThread.delete(thread.id);
    this.sendEvent(new ThreadEvent("exited", thread.id));
  }

  #onThreadGroupStarted(payload) {
    this.log(getFunctionName(), payload);
  }

  #onThreadGroupExited(payload) {
    this.log(getFunctionName(), payload);
  }

  #onNewObjfile(payload) {
    this.log(getFunctionName(), payload);
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
    this.log(getFunctionName(), payload);
  }

  /**
   * A thread group was added.
   *
   * @param {{id: number}} payload
   */
  #onNotifyThreadGroupAdded(payload) {
    this.log(getFunctionName(), payload);
  }

  /**
   * A thread group was removed.
   *
   * @param {{id: number}} payload
   */
  #onNotifyThreadGroupRemoved(payload) {
    this.log(getFunctionName(), payload);
  }

  /**
   * A thread group became associated with a running program.
   *
   * @param {{id:number, pid: number}} payload
   */
  #onNotifyThreadGroupStarted(payload) {
    this.log(getFunctionName(), payload);
  }

  /**
   * A thread group is no longer associated with a running program.
   *
   * @param {{id: number, exitCode: number}} payload
   */
  #onNotifyThreadGroupExited(payload) {
    this.log(getFunctionName(), payload);
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
    this.log(getFunctionName(), payload);
  }

  /**
   * Informs that the selected thread was changed
   *
   * @param {{id: number}} payload
   */
  #onNotifyThreadSelected(payload) {
    this.log(getFunctionName(), payload);
  }

  /**
   * Reports that a new library file was loaded by the program.
   *
   * @param {*} payload
   */
  #onNotifyLibraryLoaded(payload) {
    this.log(getFunctionName(), payload);
  }

  /**
   * Reports that a library was unloaded by the program.
   *
   * @param {*} payload
   */
  #onNotifyLibraryUnloaded(payload) {
    this.log(getFunctionName(), payload);
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
   *            thread?: number,
   *            locations?: object[]}} bkpt
   */

  /**
   * Reports that a breakpoint was created.
   *
   * @param { { bkpt: bkpt } } payload
   */
  async #onNotifyBreakpointCreated(payload) {
    let { number, addr, file, fullname, enabled, line, locations } = payload.bkpt;
    if (!file && !line) {
      if (locations) {
        const loc_fullname = locations[0].fullname;
        const loc_file = locations[0].file;
        const loc_line = locations[0].line;
        // we're in a template function or inlined function, thus we have the same source location (but different addresses in memory).
        // Use the major/minor version that GDB does. To disable individual locations, is up to the user in the debug console.
        if (locations.every((bp) => bp.file == loc_file && bp.line == loc_line)) {
          const newBreakpoint = {
            id: +number,
            enabled: enabled == "y",
            verified: true,
            source: new Source(loc_file, loc_fullname),
            line: +loc_line,
          };
          this.sendEvent(new BreakpointEvent("new", newBreakpoint));
          this.#lineBreakpoints.add_to(loc_file, newBreakpoint);
        } else {
          // We delete master breakpoints with multiple locations (*IF* they have different source code locations),
          // due to how VSCode handles or understand breakpoints vs how GDB does.
          await this.execMI(`-break-delete ${number}`);
          for (const loc of locations) {
            const cmd = `-break-insert *${loc.addr}`;
            try {
              const res = await this.execMI(cmd);
              const { addr, enabled, file, fullname, line, number } = res.bkpt;
              const verified = addr != "<PENDING>";
              const address = verified ? addr : null;
              const newBreakpoint = {
                id: +number,
                enabled: enabled == "y",
                verified,
                source: new Source(file, fullname),
                line: +line,
                instructionReference: address,
                message: verified ? null : "Pending breakpoint",
              };
              this.sendEvent(new BreakpointEvent("new", newBreakpoint));
              this.#lineBreakpoints.add_to(file, newBreakpoint);
            } catch (e) {
              this.sendEvent(new OutputEvent(`Setting breakpoint at ${loc.addr} failed. Exception: ${e}`, "console"));
            }
          }
        }
      }
    } else {
      const newBreakpoint = {
        id: +number,
        enabled: enabled == "y",
        verified: addr != "<PENDING>",
        source: new Source(file, fullname),
        line: +line,
      };
      this.sendEvent(new BreakpointEvent("new", newBreakpoint));
      this.#lineBreakpoints.add_to(file, newBreakpoint);
    }
  }

  /**
   * Reports that a breakpoint was modified.
   *
   * @param {{ bkpt: bkpt }} payload
   */
  #onNotifyBreakpointModified(payload) {
    const { file, fullname, line, locations } = payload.bkpt;
    const num = payload.bkpt.number;
    let bp;
    if (locations) {
      const loc_fullname = locations[0].fullname;
      const loc_file = locations[0].file;
      const loc_line = locations[0].line;
      bp = {
        id: +num,
        verified: true,
        source: new Source(loc_file, loc_fullname),
        line: +loc_line,
      };
    } else {
      bp = {
        line: +line,
        id: +num,
        verified: true,
        source: new Source(file, fullname),
      };
    }

    this.sendEvent(new BreakpointEvent("changed", bp));
    this.log(getFunctionName(), payload);
  }

  /**
   * Reports that a breakpoint was deleted.
   */
  #onNotifyBreakpointDeleted(payload) {
    const { id } = payload;
    const bp = { id: +id, verified: true };
    this.sendEvent(new BreakpointEvent("removed", bp));
    this.log(getFunctionName(), payload);
  }

  #onBreakpointHit(thread) {
    const THREADID = thread.id;
    let stopEvent = new StoppedEvent("breakpoint", THREADID);
    const body = {
      reason: stopEvent.body.reason,
      allThreadsStopped: this.noSingleThreadControl,
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

  // Set that this debug session can not control individual threads. It either resumes or stops all.
  setNoSingleThreadControl() {
    this.noSingleThreadControl = true;
    vscode.commands.executeCommand("setContext", ContextKeys.NoSingleThreadControl, true);
  }

  /**
   * Set a pending breakpoint, that might not resolve immediately.
   * @param {string} path - `path` to source code file
   * @param {number} requestedLine - `line` in file to break on
   * @param {number | undefined } threadId - thread this breakpoint belongs to; all threads if undefined
   * @returns { Promise<{id: number, enabled: boolean, verified: boolean, source: Source, line: number }> } bp
   */
  async setPendingBreakpoint(path, requestedLine, threadId = undefined) {
    const tParam = threadId ? ` -p ${threadId}` : "";
    const command = `-break-insert -f ${path}:${requestedLine}${tParam}`;
    try {
      let res = await this.execMI(command, threadId);
      let { number, enabled, file, fullname, locations, line, addr } = res.bkpt;
      if ((!file || !fullname) && locations) {
        file = locations[0].file;
        fullname = locations[0].fullname;
      } else {
        file = path;
        fullname = path;
      }
      return {
        id: +number,
        enabled: enabled == "y",
        verified: addr != "<PENDING>",
        source: new Source(file, fullname),
        line: line ?? requestedLine,
      };
    } catch (err) {
      this.sendEvent(new OutputEvent(`failed to execute set breakpoint command: ${command}:\n\t: ${err}`, "console"))
      return null;
    }
  }

  /**
   * Sets a software conditional pending breakpoint. These kinds of breakpoints incur a very large overhead.
   * @param {string} path
   * @param {number} line
   * @param {string} condition
   * @param {number} threadId
   * @returns { Promise<{id: number, enabled: boolean, verified: boolean, source: Source, line: number }> }
   */
  async setConditionalBreakpoint(path, line, condition, threadId = undefined) {
    if (strEmpty(condition)) {
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
    const breakpoint_result = (await this.execMI(`-break-insert -f ${cParam} ${tParam} ${path}:${line}`)).bkpt;
    let { number, enabled, file, fullname, locations, addr } = breakpoint_result;
    if (!file || (!fullname && locations)) {
      file = locations[0].file;
      fullname = locations[0].fullname;
    }
    let bp = {
      id: +number,
      enabled: enabled == "y",
      verified: addr != "<PENDING>",
      source: new Source(file, fullname),
      line: +line,
    };
    this.registerBreakpoint(bp);
    return bp;
  }

  registerBreakpoint(bp) {
    this.#lineBreakpoints.add_to(bp.file, bp);
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
      if (this.config.isRRSession()) {
        let a = transformToRRCommands(expression);
        if (expression != a) {
          return await this.execCMD(a);
        }
      }
      // assume CLI command, for now
      if (expression == "cancel") {
        this.interrupt_operations();
      } else {
        return await this.execCLI(`${expression}`);
      }
    }
  }

  async restartFromCheckpoint(id) {
    await this.execCLI(`restart ${id}`);
  }

  async deleteCheckpoint(id) {
    await this.execCMD(`rr-delete-checkpoint ${id}`);
  }

  // Sends Ctrl+C / Interrupt to GDB to abort whatever process it might be into right now.
  interrupt_operations() {
    gdbProcess.kill(`SIGINT`);
  }

  atExitCleanUp(signal) {
    gdbProcess.kill(signal);
    if (this.config.disposeOnExit()) this.#target.disposeTerminal();
    else {
      if (this.#target.terminal) this.#target.terminal.disposeChildren();
    }
  }

  sendContinueEvent(threadId, allThreadsContinued) {
    this.sendEvent(new ContinuedEvent(threadId, allThreadsContinued));
    vscode.commands.executeCommand("setContext", ContextKeys.Running, true);
  }

  getExceptionInfoForThread(threadId) {
    let item = this.threadExceptionInfos.get(threadId);
    this.threadExceptionInfos.delete(threadId);
    return item;
  }

  /**
   * 
   * @returns { Promise<{ pid: number, user: string, label: string }[]> }
   */
  async getOsProcesses() {
    const { processes } = await this.execCMD("get-all-pids");
    return processes;
  }
  log(location, payload) {
    if (!trace) {
      return;
    }
    this.#target.log("Midas", `[LOG #${LOG_ID++}] - Caught GDB ${location}. Payload: ${JSON.stringify(payload, null, " ")}`);
  }
}

function transformToRRCommands(expr) {
  // "True" is appended to signal to Midas that it comes from Debug Console input
  switch (expr) {
    case "checkpoint":
      return "rr-checkpoint True";
    case "info checkpoints":
      return "rr-info-checkpoints True";
    case "when":
      return "rr-when True";
    default:
      return expr;
  }
}

exports.GDB = GDB;
exports.trace = trace;
