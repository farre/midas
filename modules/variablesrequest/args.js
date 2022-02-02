const DebugAdapter = require("@vscode/debugadapter");
const { VariablesReference } = require("./variablesReference");
const GDB = require("../gdb");
const {StackFrameState} = require("./stackFramestate");
/**
 * @typedef { import("@vscode/debugprotocol").DebugProtocol.VariablesResponse } VariablesResponse
 * @typedef { import("../gdb").GDB } GDB
 * @typedef { import("../gdb").VSCodeVariable } VSCodeVariable
 */

class ArgsReference extends VariablesReference {
  #stackFrameState;

  constructor(argScopeVariableReference, threadId, frameLevel, stackFrameState) {
    super(argScopeVariableReference, threadId, frameLevel);
    this.#stackFrameState = stackFrameState;
  }

  /**
   * @param { VariablesResponse } response - response which we prepare, to be sent back to VSCode
   * @param { GDB } gdb - reference to the GDB backend
   * @returns { Promise<VariablesResponse> }
   */
  async handleRequest(response, gdb) {
    // todo(simon): this is logic that DebugSession should not handle. Partially, this stuff gdb.js should be responsible for
    response.body = {
      variables: await this.#stackFrameState.getStackArgs(gdb),
    };
    return response;
  }

  /**
   * @param { GDB } gdb - reference to the GDB backend
   */
  async cleanUp(gdb) { }
}

module.exports = {
  ArgsReference,
};
