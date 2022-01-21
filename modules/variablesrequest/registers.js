const DebugAdapter = require("@vscode/debugadapter");
const { VariablesReference } = require("./reference");
const GDB = require("../gdb");
/**
 * @typedef { import("@vscode/debugprotocol").DebugProtocol.VariablesResponse } VariablesResponse
 * @typedef { import("../gdb").GDB } GDB
 * @typedef { import("../gdb").MidasVariable } MidasVariable
 */

class RegistersReference extends VariablesReference {
  /** @type {MidasVariable[]}  */
  #registerVariables;

  constructor(stackFrameId, threadId, frameLevel) {
    super(stackFrameId, threadId, frameLevel);
    this.#registerVariables = [];
  }

  /**
   * @param { VariablesResponse } response - response which we prepare, to be sent back to VSCode
   * @param { GDB } gdb - reference to the GDB backend
   * @returns { Promise<VariablesResponse> }
   */
  async handleRequest(response, gdb) {
    // todo(simon): this is logic that DebugSession should not handle. Partially, this stuff gdb.js should be responsible for
    await gdb.selectStackFrame(this.frameLevel, this.threadId);
    let miResult = await gdb.execMI(`-data-list-register-values N ${gdb.generalPurposeRegCommandString}`);
    response.body = {
      variables: miResult["register-values"].map((res, index) => new DebugAdapter.Variable(gdb.registerFile[index], res.value)),
    };
    return response;
  }

  /**
   * @param { GDB } gdb - reference to the GDB backend
   */
  async cleanUp(gdb) {
    for (const v of this.#registerVariables) {
      await gdb.deleteVariableObject(v.voName);
    }
  }
}

module.exports = {
  RegistersReference,
};
