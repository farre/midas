const { VariablesReference } = require("./reference");
const { StructsReference } = require("./structs");
const GDB = require("../gdb");
/**
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
   * @param { GDB } gdb_ - reference to the GDB backend
   * @returns { Promise<VariablesResponse> }
   */
  async handleRequest(response, gdb_) {
    if (this.#variables.length == 0) {
      let result = await gdb_.getStackLocals(this.threadId, this.frameLevel);
      for (const { name, type, value } of result) {
        let nextRef = gdb_.generateVariableReference();
        let vscodeRef = 0;
        const voname = `vr_${nextRef}`;
        let cmd = `-var-create ${voname} * ${name}`;

        // we have to execute the creation of varObjs first; because if we have come across a lambda (i.e not closures, they capture something, so that will be fine)
        // it will *not* have `value` set, like structured types, but it will also *not* have numchild > 0, so we must find out this first, so
        // we don't add lambdas to variables we should track.
        let numchild = await gdb_.execMI(cmd, this.threadId).then((res) => res.numchild);
        if (!value && numchild > 0) {
          vscodeRef = nextRef;
          gdb_.references.set(nextRef, new StructsReference(nextRef, this.threadId, this.frameLevel, voname));
          gdb_.getExecutionContext(this.threadId).addTrackedVariableReference({ id: nextRef, shouldManuallyDelete: true });
        } else if (!value && numchild == 0) {
          await gdb_.execMI(`-var-delete ${voname}`, this.threadId);
          continue;
        }

        let mvar = new GDB.MidasVariable(name, value ?? type, vscodeRef, voname, value ? false : true);
        this.#variables.push(mvar);
      }
      response.body = {
        variables: this.#variables,
      };
    } else {
      // we need to update the stack frame
      await gdb_.updateMidasVariables(this.threadId, this.#variables);
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
      await gdb.execMI(`-var-delete ${v.voName}`, this.threadId);
      v.voName;
    }
  }
}

module.exports = {
  LocalsReference,
};
