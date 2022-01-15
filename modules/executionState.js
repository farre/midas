/**
 * @typedef {import("./gdb").MidasStackFrame } MidasStackFrame
 * @typedef {import("./gdb").MidasVariable } MidasVariable
 * @typedef {number} VariableReference
 */

/// Type that tracks variablesReferences for an execution context (i.e; a thread).
class ExecutionState {
  threadId;
  /** @type {{ id: VariableReference, shouldManuallyDelete: boolean }[]} - currently managed variable references*/
  #managedVariableReferences;
  /** @type {MidasStackFrame[]} */
  stack = [];

  constructor(threadId) {
    this.threadId = threadId;
    this.#managedVariableReferences = [];
  }

  /**
   * Adds a variable reference that this execution context should track
   * @param {{id: VariableReference, shouldManuallyDelete: boolean}} `variableReferenceInfo` - the variable reference this execution context
   * should track and if that points to a variable reference which is a child to some other variable reference
   */
  addTrackedVariableReference({ id, shouldManuallyDelete }) {
    this.#managedVariableReferences.push({ id, shouldManuallyDelete });
  }

  async clear(gdb) {
    for (const { id, shouldManuallyDelete } of this.#managedVariableReferences) {
      if (shouldManuallyDelete) {
        // we only clean up non-children in the backend; gdb MI does the rest for the children
        let item = gdb.references.get(id);
        item.cleanUp(gdb);
      }
      gdb.references.delete(id);
    }
    this.stack = [];
    this.#managedVariableReferences = [];
  }
}

module.exports = {
  ExecutionState,
};
