const { VariablesReference, err_response } = require("./reference");
const { StructsReference } = require("./structs");
const GDB = require("../gdb");
/**
 * @typedef { import("@vscode/debugprotocol").DebugProtocol.SetVariableResponse } SetVariableResponse
 * @typedef { import("@vscode/debugprotocol").DebugProtocol.VariablesResponse } VariablesResponse
 * @typedef { import("../gdb").GDB } GDB
 * @typedef { import("../gdb").MidasVariable } MidasVariable
 */

const isPrimitiveType = (value, childrenCount) => value && (childrenCount == 0);
const isStructuredOrPointer = (value, childrenCount) => value && (childrenCount > 0);
const isNotVariable = (value, childrenCount) => !value && (childrenCount == 0);

class LocalsReference extends VariablesReference {
  /** @type {MidasVariable[]}  */
  #variables;

  #initialized = false;

  constructor(stackFrameId, threadId, frameLevel) {
    super(stackFrameId, threadId, frameLevel);
    this.#variables = [];
  }

  async #initRequest(gdb) {
    let ec = gdb.getExecutionContext(this.threadId);
    const frameLevel = ec.getFrameLevel(this.variablesReferenceId);
    this.frameLevel = frameLevel;
    let result = await gdb.getStackLocals(this.threadId, this.frameLevel);
    for (const { name, type, value } of result) {
      if (name == "this") {
        let nextRef = gdb.generateVariableReference();
        const voname = `vr_${nextRef}`;
        // notice the extra * -> we are dereferencing a this pointer
        const cmd = `-var-create ${voname} * *${name}`;
        await gdb.execMI(cmd, this.threadId);
        gdb.references.set(
          nextRef,
          new StructsReference(nextRef, this.threadId, this.frameLevel, { variableObjectName: voname, evaluateName: name })
        );
        gdb.getExecutionContext(this.threadId).addTrackedVariableReference({ id: nextRef, shouldManuallyDelete: true });
        let mvar = new GDB.MidasVariable(name, `<${value}> ${type}`, nextRef, voname, value ? false : true, name);
        this.#variables.push(mvar);
      } else {
        let nextRef = gdb.generateVariableReference();
        let vscodeRef = 0;
        const voname = `vr_${nextRef}`;
        let cmd = `-var-create ${voname} * ${name}`;
        // we have to execute the creation of varObjs first; if we have come across a non-capturing lambda
        // it will *not* have `value` set, like structured types, but it will also *not* have numchild > 0,
        // so we must find out this first, to refrain from tracking it
        const numchild = (await gdb.execMI(cmd, this.threadId)).numchild;
        if (!value && numchild > 0) {
          vscodeRef = nextRef;
          gdb.references.set(
            nextRef,
            new StructsReference(nextRef, this.threadId, this.frameLevel, { variableObjectName: voname, evaluateName: name })
          );
          gdb.getExecutionContext(this.threadId).addTrackedVariableReference({ id: nextRef, shouldManuallyDelete: true });
          let mvar = new GDB.MidasVariable(name, value ?? type, vscodeRef, voname, value ? false : true, name);
          this.#variables.push(mvar);
        } else if (isNotVariable(value, numchild)) {
          await gdb.deleteVariableObject(voname);
          continue;
        } else if (isStructuredOrPointer(value, numchild)) {
          // we're *most likely* a pointer to something
          let nextRef = gdb.generateVariableReference();
          const deref_voname = `vr_${nextRef}`;
          // notice the extra * -> we are dereferencing a this pointer
          const cmd = `-var-create ${deref_voname} * *${name}`;
          // this is wrapped in a try block because:
          // below, we try to derefence what we believe to be a pointer, but it doesn't have to be,
          // it can be an l-value reference or an r-value reference. And they don't have the operator*
          // so the catch block, is there for these kinds, if they're a reference, they get treated as the code on line 52-59
          // which does the exact same thing, but for l-values
          try {
            let varobj = await gdb.execMI(cmd, this.threadId);
            // means that the value behind the pointer is a structured type. a pointer, always have 1 numchild
            // so in order to find out if it's a primitive type, we dereference it and check if there are further children.
            if (varobj.numchild > 0) {
              vscodeRef = nextRef;
              gdb.references.set(
                nextRef,
                new StructsReference(nextRef, this.threadId, this.frameLevel, {
                  variableObjectName: deref_voname,
                  evaluateName: name,
                })
              );
              gdb.getExecutionContext(this.threadId).addTrackedVariableReference({ id: nextRef, shouldManuallyDelete: true }, this.variablesReferenceId);
              let mvar = new GDB.MidasVariable(name, `<${value}> ${type}`, nextRef, deref_voname, value ? false : true, name);
              this.#variables.push(mvar);
            } else {
              let mvar = new GDB.MidasVariable(name, value ?? type, vscodeRef, voname, value ? false : true, name);
              this.#variables.push(mvar);
            }
          } catch (isOf_l_or_r_ReferenceTypeError) {
            vscodeRef = nextRef;
            gdb.references.set(
              nextRef,
              new StructsReference(nextRef, this.threadId, this.frameLevel, { variableObjectName: voname, evaluateName: name }, this.variablesReferenceId)
            );
            gdb.getExecutionContext(this.threadId).addTrackedVariableReference({ id: nextRef, shouldManuallyDelete: true }, this.variablesReferenceId);
            let mvar = new GDB.MidasVariable(name, type, vscodeRef, voname, value ? false : true, name);
            this.#variables.push(mvar);
          }
        } else if(isPrimitiveType(value, numchild)) {
          gdb.getExecutionContext(this.threadId).addTrackedVariableReference({ id: nextRef, shouldManuallyDelete: true }, this.variablesReferenceId);
          const doesNotReferenceOtherVariables = 0;
          let mvar = new GDB.MidasVariable(name, value, doesNotReferenceOtherVariables, voname, value ? false : true, name);
          this.#variables.push(mvar);
        }
      }
    }
    this.#initialized = true;
  }

  /**
   * @param { VariablesResponse } response - response which we prepare, to be sent back to VSCode
   * @param { GDB } gdb - reference to the GDB backend
   * @returns { Promise<VariablesResponse> }
   */
  async handleRequest(response, gdb) {
    if(!this.#initialized) {
      await this.#initRequest(gdb);
      response.body = {
        variables: this.#variables,
      };
    } else {
      // we need to update the stack frame
      let ec = gdb.executionContexts.get(this.threadId);
      for(let v of this.#variables) {
        const changeList = await gdb.execMI(`-var-update --all-values ${v.variableObjectName}`);
        for(const change of changeList.changelist) {
          ec.registerVariableObjectChange(change.name, change.value);
        }
        let changeValue = ec.getMaybeUpdatedValue(v.variableObjectName);
        if(changeValue) {
          v.value = changeValue;
          ec.removeUpdatedValue(v.variableObjectName);
        }
      }

      response.body = {
        variables: this.#variables,
      };
    }
    return response;
  }

  /**
   * @param { GDB } gdb - reference to the GDB backend
   */
  async cleanUp(gdb) {
    for (const v of this.#variables) {
      await gdb.deleteVariableObject(v.variableObjectName);
    }
    gdb.references.delete(this.variablesReferenceId);
  }
  /**
   * Sets a new value of a named object (variable object) that this reference tracks or manages.
   * @param { SetVariableResponse } response - The response initialized by VSCode which we should return
   * @param {GDB} gdb - GDB backend instance
   * @param {string} namedObject - a named object's name, that this VariablesReference tracks, which should be updated
   * @param {string} value - The `value` in string form which the named object should be updated to hold
   * @returns { Promise<SetVariableResponse> } prepared VSCode response
   */
  async update(response, gdb, namedObject, value) {
    for (const v of this.#variables) {
      if (v.name == namedObject) {
        let res = await gdb.execMI(`-var-assign ${v.variableObjectName} "${value}"`, this.threadId);
        if (res.value) {
          v.value = res.value;
          response.body = {
            value: res.value,
            variablesReference: v.variablesReference,
          };
          return response;
        }
      }
    }
    return err_response(response, `${namedObject} is not tracked by the variablesReference ${this.variablesReferenceId}`);
  }
}

module.exports = {
  LocalsReference,
};
