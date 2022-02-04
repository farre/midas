const { VariablesReference, err_response } = require("./variablesReference");
/**
 * @typedef { import("@vscode/debugprotocol").DebugProtocol.SetVariableResponse } SetVariableResponse
 * @typedef { import("@vscode/debugprotocol").DebugProtocol.VariablesResponse } VariablesResponse
 * @typedef { import("../gdb").GDB } GDB
 * @typedef { import("../gdb").VSCodeVariable } VSCodeVariable
 */

class LocalsReference extends VariablesReference {
  /** @type {VSCodeVariable[]}  */
  #variables;

  #initialized = false;

  argScopeIdentifier;
  registerScopeIdentifier;
  /** @type {import("./stackFramestate").StackFrameState }*/
  state;

  constructor(stackFrameId, threadId, frameLevel, argScopeIdentifer, registerScopeIdentifier, state) {
    super(stackFrameId, threadId, frameLevel);
    if(!state) debugger;
    this.#variables = [];
    this.argScopeIdentifier = argScopeIdentifer;
    this.registerScopeIdentifier = registerScopeIdentifier;
    this.state = state;
  }

  async handleRequest(response, gdb) {
    response.body = {
      variables: await this.state.getStackLocals(gdb),
    };
    return response;
  }

  /**
   * @param { GDB } gdb - reference to the GDB backend
   */
  async cleanUp(gdb) {
    await this.state.cleanUp(gdb);
    gdb.references.delete(this.variablesReferenceId);
  }

  releaseVariableReferences(gdb) {
    gdb.delete(this.variablesReferenceId);
    gdb.delete(this.argScopeIdentifier);
    gdb.delete(this.registerScopeIdentifier);
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
