const { StructsReference } = require("./structs");
const { Subject } = require("await-notify");
const GDB = require("../gdb");

const isPrimitiveType = (value, childrenCount) => value && (childrenCount == 0);
const isStructuredOrPointer = (value, childrenCount) => value && (childrenCount > 0);
const isNotVariable = (value, childrenCount) => !value && (childrenCount == 0);

class StackFrameState {
  #threadId;
  #stackFrameVariableReference;
  #args = [];
  #locals = [];
  #initialized = null;

  argSymbolNames = [];
  localSymbolNames = [];

  constructor(stackFrameVariableReference, threadId) {

    this.#stackFrameVariableReference = stackFrameVariableReference;
    this.#threadId = threadId;
  }

  async maybeInit(gdb) {
    if (!this.#initialized) {
      await this.initialise(gdb);
      return true;
    }
    return false;
  }

  async getStackLocals(gdb) {
    if (!this.#initialized)  {
      this.#initialized = this.initialise(gdb)
    }
    await this.#initialized;
    return this.#locals;
  }

  async getStackArgs(gdb) {
    if (!this.#initialized)  {
      this.#initialized = this.initialise(gdb)
    }
    await this.#initialized;
    return this.#args;
  }

  /**
 * @param {import("../gdb").GDB} gdb
 */
  async initialise(gdb) {
    console.log("initializing stackframe state");
    if(this.#initialized) return;
    let res = await gdb.getFrameLocalsAndArgs();
    
    for(const arg of res.args) {
      if(arg.isPrimitive) {
        this.#args.push(new GDB.VSCodeVariable(arg.name, arg.display, 0, arg.name, false, arg.name))
      } else {
        let nextRef = gdb.generateVariableReference();
        const options = { managed: false };
        let topLevelStruct = new StructsReference(nextRef, this.#threadId, 0, {
          variableObjectName: arg.name,
          evaluateName: arg.name,
        }, this.#stackFrameVariableReference, options);
        gdb.references.set(
          nextRef,
          topLevelStruct
        );
        gdb.getExecutionContext(this.#threadId).addTrackedVariableReference(nextRef, this.#stackFrameVariableReference);
        let v = new GDB.VSCodeVariable(arg.name, arg.display, nextRef, arg.name, true, arg.name);
        this.#args.push(v);
        this.argSymbolNames.push(arg.name);
      }
    }

    for(const local of res.variables) {
      if(local.isPrimitive) {
        this.#locals.push(new GDB.VSCodeVariable(local.name, local.display, 0, local.name, false, local.name))
      } else {
        let nextRef = gdb.generateVariableReference();
        const options = { managed: false };
        let topLevelStruct = new StructsReference(nextRef, this.#threadId, 0, {
          variableObjectName: local.name,
          evaluateName: local.name,
        }, this.#stackFrameVariableReference, options);
        gdb.references.set(
          nextRef,
          topLevelStruct
        );
        gdb.getExecutionContext(this.#threadId).addTrackedVariableReference(nextRef, this.#stackFrameVariableReference);
        let v = new GDB.VSCodeVariable(local.name, local.display, nextRef, local.name, true, local.name);
        this.#locals.push(v);
        this.argSymbolNames.push(local.name);
      }
    }    
  }
  /**
   * @param { GDB.GDB } gdb - reference to the GDB backend
   */
  async cleanUp(gdb) {
    let ec = gdb.getExecutionContext(this.#threadId);
    for (const v of this.#locals) {
      await gdb.deleteVariableObject(v.variableObjectName);
      ec.deleteMapping(v.variableObjectName);
    }
    for (const v of this.#args) {
      await gdb.deleteVariableObject(v.variableObjectName);
      ec.deleteMapping(v.variableObjectName);
    }

    gdb.references.delete(this.#stackFrameVariableReference);
  }
}

module.exports = {
  StackFrameState
};