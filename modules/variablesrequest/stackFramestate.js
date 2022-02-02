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
    let firstRun = false;
    if (!this.#initialized)  {
      this.#initialized = this.initialise(gdb);
      firstRun = true;
    }
    await this.#initialized;
    if (firstRun) {
      return this.#locals;
    }

    let ec = gdb.executionContexts.get(this.#threadId);
    for (let v of this.#locals) {
      const changeList = await gdb.execMI(`-var-update --all-values ${v.variableObjectName}`);
      for (const change of changeList.changelist) {
        ec.updateVariable(change.name, change.value);
      }
    }
    return this.#locals;
  }

  async getStackArgs(gdb) {
    let firstRun = false;
    if (!this.#initialized)  {
      this.#initialized = this.initialise(gdb)
      firstRun = true;
    }
    await this.#initialized;
    if (firstRun) {
      return this.#args;
    }


    let ec = gdb.executionContexts.get(this.#threadId);
    for (let v of this.#args) {
      const changeList = await gdb.execMI(`-var-update --all-values ${v.variableObjectName}`);
      for (const change of changeList.changelist) {
        ec.updateVariable(change.name, change.value);
      }
    }
    return this.#args
  }

  /**
 * @param {import("../gdb").GDB} gdb
 */
  async initialise(gdb) {
    if(this.#initialized) return;
    let ec = gdb.getExecutionContext(this.#threadId);
    const frameLevel = ec.getFrameLevel(this.#stackFrameVariableReference);
    let stackVariables = await gdb.getStackLocals(this.#threadId, frameLevel);
    const add = (Var, arg) => {
      if (arg) {
        this.#args.push(Var);
      } else {
        this.#locals.push(Var);
      }
    }
    for (const { name, type, value, arg } of stackVariables) {
      if (name == "this") {
        let { nextRef, varObjectName } = await gdb.createVariableObjectForPointerType(name, this.#threadId);
        gdb.references.set(
          nextRef,
          new StructsReference(nextRef, this.#threadId, frameLevel, { variableObjectName: varObjectName, evaluateName: name })
        );
        ec.addTrackedVariableReference(nextRef, this.#stackFrameVariableReference);
        let mvar = new GDB.VSCodeVariable(name, `<${value}> ${type}`, nextRef, varObjectName, value ? false : true, name);
        add(mvar, arg);
      } else {
        let vscodeRef = 0;
        let { nextRef, varObjectName, result } = await gdb.createVariableObject(name, this.#threadId);
        // we have to execute the creation of varObjs first; if we have come across a non-capturing lambda
        // it will *not* have `value` set, like structured types, but it will also *not* have numchild > 0,
        // so we must find out this first, to refrain from tracking it
        const numchild = result.numchild;
        if (!value && numchild > 0) {
          vscodeRef = nextRef;
          gdb.references.set(
            nextRef,
            new StructsReference(nextRef, this.#threadId, frameLevel, { variableObjectName: varObjectName, evaluateName: name })
          );
          ec.addTrackedVariableReference(nextRef, this.#stackFrameVariableReference);
          let mvar = new GDB.VSCodeVariable(name, value ?? type, vscodeRef, varObjectName, value ? false : true, name);
          add(mvar, arg);
        } else if (isNotVariable(value, numchild)) {
          await gdb.deleteVariableObject(varObjectName);
          continue;
        } else if (isStructuredOrPointer(value, numchild)) {
          // we're *most likely* a pointer to something
          let nextRef = gdb.generateVariableReference();
          const deref_voname = `vr_${nextRef}`;
          // notice the extra * -> we are dereferencing a this pointer
          const cmd = `-var-create ${deref_voname} * *${name}`;
          try {
            let varobj = await gdb.execMI(cmd, this.#threadId);
            // means that the value behind the pointer is a structured type. a pointer, always have 1 numchild
            // so in order to find out if it's a primitive type, we dereference it and check if there are further children.
            if (varobj.numchild > 0) {
              vscodeRef = nextRef;
              gdb.references.set(
                nextRef,
                new StructsReference(nextRef, this.#threadId, frameLevel, {
                  variableObjectName: deref_voname,
                  evaluateName: name,
                })
              );
              ec.addTrackedVariableReference(nextRef, this.#stackFrameVariableReference);
              let mvar = new GDB.VSCodeVariable(name, `<${value}> ${type}`, nextRef, deref_voname, value ? false : true, name);
              ec.addMapping(varObjectName, mvar);
              add(mvar, arg);
            } else {
              let mvar = new GDB.VSCodeVariable(name, value ?? type, vscodeRef, varObjectName, value ? false : true, name);
              ec.addMapping(varObjectName, mvar);
              add(mvar, arg);
            }
          } catch (isOf_l_or_r_ReferenceTypeError) {
            vscodeRef = nextRef;
            gdb.references.set(
              nextRef,
              new StructsReference(nextRef, this.#threadId, frameLevel,
                { variableObjectName: varObjectName, evaluateName: name },
                this.#stackFrameVariableReference)
            );
            ec.addTrackedVariableReference(nextRef, this.#stackFrameVariableReference);
            let mvar = new GDB.VSCodeVariable(name, type, vscodeRef, varObjectName, value ? false : true, name);
            ec.addMapping(varObjectName, mvar);
            add(mvar, arg);
          }
        } else if (isPrimitiveType(value, numchild)) {
          ec.addTrackedVariableReference(nextRef, this.#stackFrameVariableReference);
          const doesNotReferenceOtherVariables = 0;
          let mvar = new GDB.VSCodeVariable(name, value, doesNotReferenceOtherVariables, varObjectName, value ? false : true, name);
          ec.addMapping(varObjectName, mvar);
          add(mvar, arg);
        }
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