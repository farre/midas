/**
 * @typedef {import("./gdb").MidasStackFrame } MidasStackFrame
 * @typedef {import("./gdb").MidasVariable } MidasVariable
 * @typedef {number} VariableReference
 * @typedef {import("./gdb").GDB } GDB
 */

/// Type that tracks variablesReferences for an execution context (i.e; a thread).
class ExecutionState {
  threadId;
  /** @type {{ id: VariableReference, shouldManuallyDelete: boolean }[]} - currently managed variable references*/
  #managedVariableReferences = [];
  /** @type {MidasStackFrame[]} */
  stack = [];
  #variablesNeedingUpdates = new Map();
  #stackFrameLevelsToStackFrameIdentifiers = [];
  #frameVariablesReferences = new Map();
  constructor(threadId) {
    this.threadId = threadId;
  }

  /**
   * Adds a variable reference that this execution context should track
   * @param {{id: VariableReference, shouldManuallyDelete: boolean}} variableReferenceInfo - the variable reference this execution context
   * should track and if that points to a variable reference which is a child to some other variable reference
   */
  addTrackedVariableReference({ id, shouldManuallyDelete }, stackFrameIdentifier) {
    let frameReferences = this.#frameVariablesReferences.get(stackFrameIdentifier) ?? [];
    frameReferences.push(id);
    this.#frameVariablesReferences.set(stackFrameIdentifier, frameReferences);
    this.#managedVariableReferences.push({ id, shouldManuallyDelete });
  }

  async clear(gdb) {
    for(let stack of this.stack) {
      let item = gdb.references.get(stack.id);
      await item.cleanUp(gdb);
      let referencedByFrame = this.#frameVariablesReferences.get(stack.id) ?? [];
      for(const variableReference of referencedByFrame) {
        gdb.references.delete(variableReference);
      }

    }
    this.#frameVariablesReferences.clear();
    this.stack = [];
    this.#managedVariableReferences = [];
    this.#variablesNeedingUpdates = new Map();
    this.#stackFrameLevelsToStackFrameIdentifiers = [];
  }
  /**
   *
   * @param {GDB} gdb
   * @param {MidasStackFrame[]} selected
   */
  async clearSelected(gdb, selected) {
    for(const stack of selected) {
      let item = gdb.references.get(stack.id);
      await item.cleanUp(gdb);
      let referencedByFrame = this.#frameVariablesReferences.get(stack.id);
      for(const variableReference of referencedByFrame) {
        gdb.references.delete(variableReference);
      }
      this.#frameVariablesReferences.delete(stack.id);
    }
  }

  updateTopFrame(frame, gdb) {
    if (this.stack[0].source.path != frame.file) {
      // some times, the stack pointer might point to the same
      // in different contexts, therefore we check if the files are different
      this.clear(gdb);
    } else {
      // if the files are the same, the stack pointer will always differ, if we are in different
      // functions, therefore, this will be caught in stackTraceRequest() in MidasDebugSession
      this.stack[0].line = frame.line;
    }
  }

  registerVariableObjectChange(variableObjectName, variableObjectValue) {
    this.#variablesNeedingUpdates.set(variableObjectName, variableObjectValue);
  }

  getMaybeUpdatedValue(variableObjectName) {
    return this.#variablesNeedingUpdates.get(variableObjectName);
  }

  removeUpdatedValue(variableObjectName) {
    this.#variablesNeedingUpdates.delete(variableObjectName);
  }

  currentFunction() {
    return this.stack[0].func;
  }

  currentStackAddressStart() {
    return this.stack[0].stackAddressStart;
  }

  isSameContextAsCurrent(stackStartAddress, functionName) {
    if(this.stack.length == 0) return false;
    return this.currentStackAddressStart() == stackStartAddress && this.currentFunction() == functionName;
  }

  // debug info logging
  dumpContext() {
    const logLines = this.stack.map((frame, idx) => `[${idx}] ${frame.name}           - 0x${frame.stackAddressStart.toString(16)}`)
    console.log(JSON.stringify(logLines, null, 2));
  }

  pushFrameLevel(stackLevelFrameIdentifier) {
    this.#stackFrameLevelsToStackFrameIdentifiers.push(stackLevelFrameIdentifier);
  }

  async setNewContext(stackStartAddress, func, gdb) {
    let indexOfFrame = this.stack.findIndex(frame => frame.func == func && frame.stackAddressStart == stackStartAddress);
    if(indexOfFrame != -1) {
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
}

module.exports = {
  ExecutionState,
};
