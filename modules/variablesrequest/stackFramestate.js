const { StructsReference } = require("./structs");
const GDB = require("../gdb");

const LocalsParameter = {
  LOCALS: "locals",
  ARGS: "args",
  // ----- N.B!! These are not implemented in the backend yet
  STATICS: "statics",
  REGISTERS: "registers"
  // ----- N.B!! These are not implemented in the backend yet
};

class StackFrameState {
  #threadId;
  #stackFrameVariableReference;
  #argsVariableReference;

  registeredLocalsNames = new Map();
  registeredArgsNames = new Map();

  constructor(stackFrameVariableReference, argsVariableReference, threadId, frameLevel) {
    this.#argsVariableReference = argsVariableReference;
    this.#stackFrameVariableReference = stackFrameVariableReference;
    this.#threadId = threadId;
    this.frameLevel = frameLevel;
  }

  /**
   * @param {GDB.GDB} gdb
   * @returns
   */
  async getStackLocals(gdb) {
    const locals = await gdb.getLocalsOf(this.#threadId, this.frameLevel, LocalsParameter.LOCALS);
    let result = [];
    for (const local of locals) {
      if (local.isPrimitive) {
        result.push(new GDB.VSCodeVariable(local.name, local.display, 0, local.name, false, local.name));
      } else {
        let ref = this.registeredLocalsNames.get(local.name);
        if(!ref) {
          ref = gdb.generateVariableReference();
          let topLevelStruct = new StructsReference(ref,this.#threadId,this.frameLevel,local.name, this.#stackFrameVariableReference );
          this.registeredLocalsNames.set(local.name, ref);
          gdb.references.set(ref, topLevelStruct);
          gdb.getExecutionContext(this.#threadId).addTrackedVariableReference(ref, this.#stackFrameVariableReference);
        }
        let v = new GDB.VSCodeVariable(local.name, local.display, ref, local.name, true, local.name);
        result.push(v);
      }
    }
    return result;
  }

  /**
   * @param {GDB.GDB} gdb
   * @returns
   */
  async getStackArgs(gdb) {
    const args = await gdb.getLocalsOf(this.#threadId, this.frameLevel, LocalsParameter.ARGS);
    let result = [];
    for (const local of args) {
      if (local.isPrimitive) {
        result.push(new GDB.VSCodeVariable(local.name, local.display, 0, local.name, false, local.name));
      } else {
        let ref = this.registeredArgsNames.get(local.name);
        if(!ref) {
          ref = gdb.generateVariableReference();
          let topLevelStruct = new StructsReference( ref, this.#threadId, this.frameLevel, local.name, this.#stackFrameVariableReference);
          this.registeredArgsNames.set(local.name, ref);
          gdb.references.set(ref, topLevelStruct);
          gdb.getExecutionContext(this.#threadId).addTrackedVariableReference(ref, this.#stackFrameVariableReference);
        }
        let v = new GDB.VSCodeVariable(local.name, local.display, ref, local.name, true, local.name);
        result.push(v);
      }
    }
    return result;
  }

  /**
   * @param { GDB.GDB } gdb - reference to the GDB backend
   */
  async cleanUp(gdb) {
    let ec = gdb.getExecutionContext(this.#threadId);
    gdb.references.get(this.#stackFrameVariableReference).cleanUp(gdb);
    gdb.references.get(this.#argsVariableReference).cleanUp(gdb);
  }
}

module.exports = {
  StackFrameState,
};
