/**
 * @typedef {import("./gdb").VSCodeStackFrame } VSCodeStackFrame
 * @typedef {import("./gdb").VSCodeVariable } VSCodeVariable
 * @typedef {number} VariableReference
 * @typedef {import("./gdb").GDB } GDB
 */

const { ArrayMap } = require("./utils");

/// Type that tracks variablesReferences for an execution context (i.e; a thread).
class ExecutionState {
  threadId;
  /** @type {VSCodeStackFrame[]} */
  stack = [];
  #stackFrameLevelsToStackFrameIdentifiers = [];
  #frameVariablesReferences = new ArrayMap();
  /** @type {Map<string, VSCodeVariable>} */
  #debugNameMap = new Map();
  states = [];
  // Our stack trace request "queue".
  pendingStackTrace = Promise.resolve();
  constructor(threadId) {
    this.threadId = threadId;
  }

  /**
   * Adds a variable reference that this execution context should track
   * @param {number} id - variable reference
   * @param {number} stackFrameIdentifier - stack frame variable reference `id` belongs to
   */
  addTrackedVariableReference(id, stackFrameIdentifier) {
    this.#frameVariablesReferences.add_to(stackFrameIdentifier, id);
  }

  async clear(gdb) {
    for (let stack of this.stack) {
      let item = gdb.references.get(stack.id);
      await item.cleanUp(gdb);
      for (const variableReference of this.#frameVariablesReferences.safe_get(stack.id)) {
        gdb.references.delete(variableReference);
      }
    }
    this.#frameVariablesReferences.clear();
    this.stack = [];
    this.#stackFrameLevelsToStackFrameIdentifiers = [];
    this.states = [];
  }
  /**
   *
   * @param {GDB} gdb
   * @param {VSCodeStackFrame[]} selected
   */
  async clearSelected(gdb, selected) {
    for (const stack of selected) {
      let item = gdb.references.get(stack.id);
      await item.cleanUp(gdb);
      for (const variableReference of this.#frameVariablesReferences.safe_get(stack.id)) {
        gdb.references.delete(variableReference);
      }
      this.#frameVariablesReferences.delete(stack.id);
    }
    this.states = this.states.slice(selected.length);
  }

  updateTopFrame(frame, gdb) {
    if (this.stack[0].source.path != frame.file) {
      // some times, the stack pointer might point to the same
      // in different contexts, therefore we check if the files are different
      this.clear(gdb);
    } else {
      // if the files are the same, the stack pointer will always differ, if we are in different
      // functions, therefore, this will be caught in stackTraceRequest() in MidasDebugSession
      this.stack[0].line = +frame.line;
    }
  }

  currentFunction() {
    return this.stack[0].func;
  }

  currentStackAddressStart() {
    return this.stack[0].stackAddressStart;
  }

  isSameContextAsCurrent(stackStartAddress, functionName) {
    if (this.stack.length == 0) return false;
    return this.currentStackAddressStart() == stackStartAddress && this.currentFunction() == functionName;
  }

  // debug info logging
  dumpContext() {
    const logLines = this.stack.map((frame, idx) => `[${idx}] ${frame.name}           - 0x${(frame.stackAddressStart ?? 0).toString(16)}`)
    console.log(JSON.stringify(logLines, null, 2));
  }

  pushFrameLevel(stackLevelFrameIdentifier) {
    this.#stackFrameLevelsToStackFrameIdentifiers.push(stackLevelFrameIdentifier);
  }

  async setNewContext(stackStartAddress, func, gdb) {
    let indexOfFrame = this.stack.findIndex(frame => frame.func == func && frame.stackAddressStart == stackStartAddress);
    if (indexOfFrame != -1) {
      const levelsToClean = this.stack.splice(0, indexOfFrame);
      this.#stackFrameLevelsToStackFrameIdentifiers = this.#stackFrameLevelsToStackFrameIdentifiers.slice(indexOfFrame);
      await this.clearSelected(gdb, levelsToClean);
      return this.stack.length;
    } else {
      await this.clear(gdb);
      return 0;
    }
  }

  getFrameLevel(stackFrameIdentifier) {
    return this.#stackFrameLevelsToStackFrameIdentifiers.indexOf(stackFrameIdentifier);
  }

  addMapping(variableObjectName, variable) {
    this.#debugNameMap.set(variableObjectName, variable);
  }

  updateVariable(variableObjectName, value) {
    let v = this.#debugNameMap.get(variableObjectName);
    v.value = value;
  }
  deleteMapping(variableObjectName) {
    this.#debugNameMap.delete(variableObjectName);
  }

  pushStackFrame(stackFrame, state) {
    this.stack.push(stackFrame);
    this.states.push(state);
    this.pushFrameLevel(stackFrame.id);
  }
}

module.exports = {
  ExecutionState,
};
