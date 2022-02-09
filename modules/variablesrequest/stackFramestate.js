const { StructsReference } = require("./structs");
const { Subject } = require("await-notify");
const GDB = require("../gdb");

class StackFrameState {
  #threadId;
  #stackFrameVariableReference;
  #argsVariableReference;
  #args = [];
  #locals = [];
  // pending initialization
  #initializedArgs = null;
  #initializedLocals = null;

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
    if(!this.#initializedLocals) {
      this.#initializedLocals = this.initializeLocals(gdb);
    }
    await this.#initializedLocals;
    if (this.staleLocal) {
      // needs update
      let updateList = await gdb.getUpdates(this.#stackFrameVariableReference, this.#stackFrameVariableReference, this.#threadId);
      if (updateList) {
        for (const update of updateList) {
          for (let a of this.#locals) {
            if (a.evaluateName == update.name) {
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
    if (!this.#initializedArgs) {
      this.#initializedArgs = this.initializeArgs(gdb);
    }
    await this.#initializedArgs;
    if (this.staleArgs) {
      // needs update
      let updateList = await gdb.getUpdates(this.#stackFrameVariableReference, this.#argsVariableReference, this.#threadId);
      if (updateList) {
        for (const update of updateList) {
          for (const a of this.#args) {
            if (a.evaluateName == update.name) {
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

  async initializeArgs(gdb) {
    const args = await gdb.getFrameArgs(
      this.#stackFrameVariableReference,
      this.#argsVariableReference,
      this.#threadId,
      this.frameLevel
    );
    for (const arg of args) {
      if (arg.isPrimitive) {
        this.#args.push(new GDB.VSCodeVariable(arg.name, arg.display, 0, arg.name, false, arg.name));
      } else {
        const nextRef = gdb.generateVariableReference();
        const options = { managed: false, isArg: true };
        let topLevelStruct = new StructsReference(
          nextRef,
          this.#threadId, this.frameLevel,
          {
            variableObjectName: arg.name,
            evaluateName: arg.name,
          },
          this.#stackFrameVariableReference,
          options
        );
        gdb.references.set(nextRef, topLevelStruct);
        gdb.getExecutionContext(this.#threadId).addTrackedVariableReference(nextRef, this.#stackFrameVariableReference);
        let v = new GDB.VSCodeVariable(arg.name, arg.display, nextRef, arg.name, true, arg.name);
        this.#args.push(v);
        this.argSymbolNames.push(arg.name);
      }
    }
  }

  async initializeLocals(gdb) {
    const locals = await gdb.getFrameLocals(
      this.#stackFrameVariableReference,
      this.#argsVariableReference,
      this.#threadId,
      this.frameLevel
    );
    for (const local of locals) {
      if (local.isPrimitive) {
        this.#locals.push(new GDB.VSCodeVariable(local.name, local.display, 0, local.name, false, local.name));
      } else {
        let nextRef = gdb.generateVariableReference();
        const options = { managed: false, isArg: false };
        let topLevelStruct = new StructsReference(
          nextRef,
          this.#threadId,
          this.frameLevel,
          {
            variableObjectName: local.name,
            evaluateName: local.name,
          },
          this.#stackFrameVariableReference,
          options
        );
        gdb.references.set(nextRef, topLevelStruct);
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
  StackFrameState,
};
