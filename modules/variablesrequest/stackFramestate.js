const { StructsReference } = require("./structs");
const { Subject } = require("await-notify");
const GDB = require("../gdb");

class StackFrameState {
  #threadId;
  #stackFrameVariableReference;
  #argsVariableReference;
  #args = [];
  #locals = [];
  #initialized = null;

  staleLocal = false;
  staleArgs = false;

  argSymbolNames = [];
  localSymbolNames = [];

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
    if (!this.#initialized)  {
      this.#initialized = this.initialise(gdb)
    }
    await this.#initialized;
    if(this.staleLocal) {
      // needs update
      let updateList = await gdb.getUpdates(this.#stackFrameVariableReference, this.#stackFrameVariableReference, this.#threadId);
      if(updateList) {
        for(const update of updateList) {
          for(let a of this.#locals) {
            if(a.evaluateName == update.name) {
              a.value = update.display;
              break;
            }
          }
        }
      }
      return this.#locals;
    } else {
      this.staleLocal = true;
      return this.#locals;
    }
  }

  /**
   * @param {GDB.GDB} gdb 
   * @returns 
   */
  async getStackArgs(gdb) {
    if (!this.#initialized)  {
      this.#initialized = this.initialise(gdb)
    }
    await this.#initialized;
    if(this.staleArgs) {
      // needs update
      let updateList = await gdb.getUpdates(this.#stackFrameVariableReference, this.#argsVariableReference, this.#threadId);
      if(updateList) {
        for(const update of updateList) {
          for(const a of this.#args) {
            if(a.evaluateName == update.name) {
              a.value = update.display;
              break;
            }
          }
        }
      }
      return this.#args;
    } else {
      this.staleArgs = true;
      return this.#args;
    }
  }

  /**
 * @param {import("../gdb").GDB} gdb
*/
  async initialise(gdb) {
    console.log("initializing stackframe state");
    if(this.#initialized) return;
    let res = await gdb.getFrameLocalsAndArgs(this.#stackFrameVariableReference, this.#argsVariableReference, this.#threadId, 0);
    
    for(const arg of res.args) {
      if(arg.isPrimitive) {
        this.#args.push(new GDB.VSCodeVariable(arg.name, arg.display, 0, arg.name, false, arg.name))
      } else {
        let nextRef = gdb.generateVariableReference();
        const options = { managed: false, isArg: true };
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
        const options = { managed: false, isArg: false };
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
    this.#initialized = true;    
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