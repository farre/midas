const GDB = require("../gdb");
const { StructsReference } = require("./structs");
const { VariablesReference, err_response } = require("./variablesReference");

let LOG_ID = 0;
function log(reason, message) {
  if (!GDB.trace) {
    return;
  }
  console.log(`[LOG #${LOG_ID++}: ${reason}] - ${message}`);
}

/**
 * @typedef { import("@vscode/debugprotocol").DebugProtocol.VariablesResponse } VariablesResponse
 * @typedef { import("@vscode/debugprotocol").DebugProtocol.SetVariableResponse } SetVariableResponse
 * @typedef { import("../gdb").GDB } GDB
 * @typedef { import("../executionState").ExecutionState } ExecutionState
 * @typedef { import("../gdb").VSCodeVariable } VSCodeVariable
 */

class StaticsReference extends VariablesReference {
  /** @type {string} */
  evaluateName;
  subStructs = new Map();
  namesRegistered = new Map();
  stackFrameIdentifier;
  initialized = false;

  /**
   * 
   * @param { number } variablesReference 
   * @param { number } threadId 
   * @param { string } evaluateName
   * @param { number } stackFrameIdentifier 
   */
  constructor(variablesReference, threadId, evaluateName, stackFrameIdentifier) {
    super(variablesReference, threadId);
    this.stackFrameIdentifier = stackFrameIdentifier;
    this.evaluateName = evaluateName;
  }

  /**
   * @param { VariablesResponse } response - response which we prepare, to be sent back to VSCode
   * @param { GDB } gdb - reference to the GDB backend
   * @returns { Promise<VariablesResponse> }
   */
  async handleRequest(response, gdb) {
    const frameLevel = gdb.getExecutionContext(this.threadId).getFrameLevel(this.stackFrameIdentifier);
    let result = []
    let children = await gdb.getContentsOfStatic(this.threadId, frameLevel, this.evaluateName);
    for(const child of children) {
      const path = `${this.evaluateName}.${child.name}`;
      if(child.isPrimitive) {
        let v = new GDB.VSCodeVariable(child.name, child.display, 0, path, false, path);
        result.push(v);
      } else {
        let nextRef = this.namesRegistered.get(child.name);
        if(!nextRef) {
          nextRef = gdb.generateVariableReference();
          let subStructHandler = new StructsReference(nextRef, this.threadId, path, this.stackFrameIdentifier);
          gdb.references.set(
            nextRef,
            subStructHandler
          );
          this.namesRegistered.set(child.name, nextRef);
          gdb.getExecutionContext(this.threadId).addTrackedVariableReference(nextRef, this.stackFrameIdentifier);
        }
        let v = new GDB.VSCodeVariable(child.name, child.display, nextRef, path, true, path);
        result.push(v);
      }
    }
    response.body = {
      variables: result
    }
    return response;
  }

  async cleanUp(gdb) {
    // we don't need to do clean up; we're always managed by either a LocalsReference or a WatchReference
    gdb.references.delete(this.variablesReferenceId);
    for(const [name, ref] of this.namesRegistered) {
      gdb.references.delete(ref);
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
    const vo_name = `ASSIGN_TEMPORARY_${this.evaluateName}_${namedObject}`;
    let res = await gdb.execMI(`-var-create ${vo_name} * ${this.evaluateName}.${namedObject}`);
    try {
      res = await gdb.execMI(`-var-assign ${vo_name} "${value}"`, this.threadId);
      await gdb.execMI(`-var-delete ${vo_name}`);
      if (res.value) {
        response.body = {
          value: res.value
        };
        return response;
      }
    } catch(err) {
      await gdb.execMI(`-var-delete ${vo_name}`);
      return err_response(response, `${namedObject} is not editable`);
    }
  }

}

module.exports = {
  StaticsReference,
};
