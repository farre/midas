/**
 * @typedef { import("@vscode/debugprotocol").DebugProtocol.Response } Response
 * @typedef { import("@vscode/debugprotocol").DebugProtocol.VariablesResponse } VariablesResponse
 * @typedef { import("@vscode/debugprotocol").DebugProtocol.SetVariableResponse } SetVariableResponse
 * @typedef { import("../gdb").GDB } GDB
 */

/**
 * Sets this response to indicate that the request failed
 * @param { Response } response
 * @returns { any } the `response` object with it's error fields set
 */
 function err_response(response, msg) {
  response.message = msg;
  response.success = false;
  response.body = null;
  return response;
}

// base class, should not be instantiated.
class VariablesReference {
  /**
   * @type { number } - `variablesReferenceId` - handed to us by VSCode. The core identifier used.
   */
  variablesReferenceId;
  /**
   * @type { number } - `frameLevel` - Frame level this variable reference was handed to us by VSCode for.
   */
  frameLevel;
  /**
   * @type { number } - `threadId` - The thread id - what thread this reference was "created in" or meant to map to.
   */
  threadId;

  /**
   * @param {number} variablesReference - can be a stackFrameId or an id for a variable
   * @param {number} threadId - the thread which this variable or stackframe exists in
   * @param {number} frameLevel - the (current) frame level this variable or stack frame lives on
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

  /**
   * Sets a new value of a named object (variable object) that this reference tracks or manages.
   * @param { SetVariableResponse } response - The response initialized by VSCode which we should return
   * @param {GDB} gdb - GDB backend instance
   * @param {string} namedObject - a named object this VariablesReference tracks, which should be updated
   * @param {string} value - The `value` in string form which the named object should be updated to hold
   * @returns { Promise<SetVariableResponse> } prepared VSCode response
   */
  async update(response, gdb, namedObject, value) {
    throw new Error("Base class VariablesReference should not be instantiated. Merely for documentation purposes");
  }
}

module.exports = {
  VariablesReference,
  err_response,
};