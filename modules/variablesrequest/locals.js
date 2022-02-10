const { VariablesReference, err_response } = require("./variablesReference");
/**
 * @typedef { import("@vscode/debugprotocol").DebugProtocol.SetVariableResponse } SetVariableResponse
 * @typedef { import("@vscode/debugprotocol").DebugProtocol.VariablesResponse } VariablesResponse
 * @typedef { import("../gdb").GDB } GDB
 * @typedef { import("../gdb").VSCodeVariable } VSCodeVariable
 */

class LocalsReference extends VariablesReference {
  argScopeIdentifier;
  registerScopeIdentifier;
  /** @type {import("./stackFramestate").StackFrameState }*/
  state;

  constructor(stackFrameId, threadId, frameLevel, argScopeIdentifer, registerScopeIdentifier, state) {
    super(stackFrameId, threadId, frameLevel);
    if(!state) debugger;
    this.argScopeIdentifier = argScopeIdentifer;
    this.registerScopeIdentifier = registerScopeIdentifier;
    this.state = state;
  }

  async handleRequest(response, gdb) {
    let v = await this.state.getStackLocals(gdb);
    response.body = {
      variables: v,
    };
    return response;
  }

  /**
   * @param { GDB } gdb - reference to the GDB backend
   */
  async cleanUp(gdb) {
    gdb.references.delete(this.variablesReferenceId);
  }

  releaseVariableReferences(gdb) {
    gdb.delete(this.variablesReferenceId);
    gdb.delete(this.argScopeIdentifier);
    gdb.delete(this.registerScopeIdentifier);
  }


}

module.exports = {
  LocalsReference,
};
