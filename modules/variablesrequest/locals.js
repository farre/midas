const { VariablesReference, err_response } = require("./reference");
const { StructsReference } = require("./structs");
const GDB = require("../gdb");
/**
 * @typedef { import("@vscode/debugprotocol").DebugProtocol.SetVariableResponse } SetVariableResponse
 * @typedef { import("@vscode/debugprotocol").DebugProtocol.VariablesResponse } VariablesResponse
 * @typedef { import("../gdb").GDB } GDB
 * @typedef { import("../gdb").MidasVariable } MidasVariable
 */

class LocalsReference extends VariablesReference {
  /** @type {MidasVariable[]}  */
  #variables;

  constructor(stackFrameId, threadId, frameLevel) {
    super(stackFrameId, threadId, frameLevel);
    this.#variables = [];
  }

  /**
   * @param { VariablesResponse } response - response which we prepare, to be sent back to VSCode
   * @param { GDB } gdb - reference to the GDB backend
   * @returns { Promise<VariablesResponse> }
   */
  async handleRequest(response, gdb) {
    if (this.#variables.length == 0) {
      let result = await gdb.getStackLocals(this.threadId, this.frameLevel);
      for (const { name, type, value } of result) {
        let nextRef = gdb.generateVariableReference();
        let vscodeRef = 0;
        const voname = `vr_${nextRef}`;
        let cmd = `-var-create ${voname} * ${name}`;
        // we have to execute the creation of varObjs first; if we have come across a non-capturing lambda
        // it will *not* have `value` set, like structured types, but it will also *not* have numchild > 0,
        // so we must find out this first, to refrain from tracking it
        let numchild = await gdb.execMI(cmd, this.threadId).then((res) => res.numchild);
        if (!value && numchild > 0) {
          vscodeRef = nextRef;
          gdb.references.set(
            nextRef,
            new StructsReference(nextRef, this.threadId, this.frameLevel, { variableObjectName: voname, evaluateName: name })
          );
          gdb.getExecutionContext(this.threadId).addTrackedVariableReference({ id: nextRef, shouldManuallyDelete: true });
        } else if (!value && numchild == 0) {
          await gdb.deleteVariableObject(voname);
          continue;
        }

        let mvar = new GDB.MidasVariable(name, value ?? type, vscodeRef, voname, value ? false : true, name);
        this.#variables.push(mvar);
      }
      response.body = {
        variables: this.#variables,
      };
    } else {
      // we need to update the stack frame
      await gdb.updateMidasVariables(this.threadId, this.#variables);
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
      await gdb.deleteVariableObject(v.voName);
      v.voName;
    }
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
        let res = await gdb.execMI(`-var-assign ${v.voName} "${value}"`, this.threadId);
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
