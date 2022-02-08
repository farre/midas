const GDB = require("../gdb");
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

class StructsReference extends VariablesReference {
  /** @type {VSCodeVariable[]} */
  #memberVariables;
  /** @type {string} */
  variableObjectName;
  /** @type {string} */
  evaluateName;

  subStructs = new Map();

  stackFrameIdentifier;

  managed;
  isArgScope;

  initialized = false;

  /**
   * 
   * @param { number } variablesReference 
   * @param { number } threadId 
   * @param { number } frameLevel 
   * @param { { variableObjectName: string, evaluateName: string } } names 
   * @param { number } stackFrameIdentifier 
   * @param { {managed: boolean, isArg: boolean } } options 
   */
  constructor(variablesReference, threadId, frameLevel, names, stackFrameIdentifier, options = { managed: false, isArg: false }) {
    super(variablesReference, threadId, frameLevel);
    this.#memberVariables = [];
    this.stackFrameIdentifier = stackFrameIdentifier;
    this.variableObjectName = names.variableObjectName;
    this.evaluateName = names.evaluateName;
    this.managed = options.managed;
    this.isArgScope = options.isArg;
  }

  /**
   * @param { VariablesResponse } response - response which we prepare, to be sent back to VSCode
   * @param { GDB } gdb - reference to the GDB backend
   * @returns { Promise<VariablesResponse> }
   */
  async handleRequest(response, gdb) {
    if(!this.initialized) {
      let children = await gdb.get_children(this.stackFrameIdentifier, this.evaluateName, this.variablesReferenceId, this.isArgScope)
      console.log(`result of children: ${children}`);
      for(const child of children) {
        const path = `${this.evaluateName}.${child.name}`;
        if(child.isPrimitive) {
          let v = new GDB.VSCodeVariable(child.name, child.display, 0, path, false, path);
          this.#memberVariables.push(v);
        } else {
          let nextRef = gdb.generateVariableReference();
          const options = { managed: true, isArg: this.isArgScope };
          let subStructHandler = new StructsReference(nextRef, this.threadId, this.frameLevel, {
            variableObjectName: path,
            evaluateName: path,
          }, this.stackFrameIdentifier, options);
          gdb.references.set(
            nextRef,
            subStructHandler
          );
          gdb.getExecutionContext(this.threadId).addTrackedVariableReference(nextRef, this.stackFrameIdentifier);
          let v = new GDB.VSCodeVariable(child.name, child.display, nextRef, path, true, path);
          this.#memberVariables.push(v);
        }
      }
      this.initialized = true;
    } else {
      let updateList = await gdb.getUpdates(this.stackFrameIdentifier, this.variablesReferenceId, this.threadId);
      if(updateList) {
        for(const update of updateList) {
          for(const item of this.#memberVariables) {
            if(update.name == item.name) {
              item.value = update.display;
              break;
            }
          }
        }
      }
    }
    response.body = {
      variables: this.#memberVariables
    }
    return response;
  }

  async cleanUp(gdb) {
    // we don't need to do clean up; we're always managed by either a LocalsReference or a WatchReference
    gdb.references.delete(this.variablesReferenceId);
  }

  setVariablesOfManaged(gdb, variables) {
    this.#memberVariables = []; 
    for(const member of variables) {
      const path = `${this.evaluateName}.${member.name}`;
      if(member.isPrimitive) {
        let v = new GDB.VSCodeVariable(member.name, member.display, 0, path, false, path);
        this.#memberVariables.push(v);
      } else {
        const subStruct = this.subStructs.get(path);
        if(subStruct) {
          this.#memberVariables.push(subStruct);
        } else {
          let nextRef = gdb.generateVariableReference();
          const options = { managed: true, isArg: this.isArgScope };
          let subStructHandler = new StructsReference(nextRef, this.threadId, this.frameLevel, {
            variableObjectName: path,
            evaluateName: path,
          }, this.stackFrameIdentifier, options);
          subStructHandler.setVariablesOfManaged(gdb, member.payload);
          gdb.references.set(
            nextRef,
            subStructHandler
          );
          gdb.getExecutionContext(this.threadId).addTrackedVariableReference(nextRef, this.stackFrameIdentifier);
          let v = new GDB.VSCodeVariable(member.name, member.display, nextRef, path, true, path);
          this.subStructs.set(path, v);
          this.#memberVariables.push(v);
        }
      }
    }
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
    for (const v of this.#memberVariables) {
      if (v.name == namedObject) {
        let res = await gdb.execMI(`-var-assign ${v.variableObjectName} "${value}"`, this.threadId);
        if (res.value) {
          v.value = res.value;
          response.body = {
            value: res.value,
            variablesReference: v.variablesReference,
          };
        }
        return response;
      }
    }
    return err_response(response, `${namedObject} is not tracked by the variablesReference ${this.variablesReferenceId}`);
  }
}

module.exports = {
  StructsReference,
};
