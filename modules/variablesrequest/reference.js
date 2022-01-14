/**
 * @typedef { import("@vscode/debugprotocol").DebugProtocol.VariablesResponse } VariablesResponse
 * @typedef { import("../gdb").GDB } GDB
 */

// base class, should not be instantiated.
class VariablesReference {
  /**
   * @type {number} - `variablesReferenceId` - handed to us by VSCode. The core identifier used.
   */
  variablesReferenceId;
  /**
   * @type {number} - `frameLevel` - Frame level this variable reference was handed to us by VSCode for.
   */
  frameLevel;
  /**
   * @type {number} - `threadId` - The thread id - what thread this reference was "created in" or meant to map to.
   */
  threadId;

  /**
   * @param {number} variablesReference
   * @param {number} threadId
   * @param {number} frameLevel
   */
  constructor(variablesReference, threadId, frameLevel) {
    this.variablesReferenceId = variablesReference;
    this.threadId = threadId;
    this.frameLevel = frameLevel;
  }

  /**
   * @param { VariablesResponse } response - response which we prepare, to be sent back to VSCode
   * @param { GDB } gdb - reference to the GDB backend
   * @returns { Promise<VariablesResponse> }
   */
  async handleRequest(response, gdb) {
    throw new Error("Base class VariablesReference should not be instantiated. Merely for documentation purposes.");
  }

  /**
   * This "virtual" function must uphold this contract:
   * Clean up any data in the backend, that it promises to manage. How or where, is not important, as long as this
   * function always upholds that promise.
   */
  async cleanUp(gdb) {
    throw new Error("Base class VariablesReference should not be instantiated. Merely for documentation purposes");
  }
}

module.exports = {
  VariablesReference,
};
