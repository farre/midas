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
        let nextRef = gdb_.generateVariableReference({
          threadId: this.threadId,
          frameLevel: this.frameLevel,
        });
        let vscodeRef = 0;
        const voname = `vr_${nextRef}`;
        let cmd = `-var-create ${voname} * ${name}`;
        if (!value) {
          vscodeRef = nextRef;
          gdb_.references.set(nextRef, new StructsReference(nextRef, this.threadId, this.frameLevel, voname));
          gdb_.getExecutionContext(this.threadId).addTrackedVariableReference({ id: nextRef, isChild: false });
        }

        let mvar = new GDB.MidasVariable(name, value ?? type, vscodeRef, voname, value ? false : true);
        this.#variables.push(mvar);
        await gdb_.execMI(cmd, this.threadId);
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
