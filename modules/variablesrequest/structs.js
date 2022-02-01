const GDB = require("../gdb");
const { VariablesReference, err_response } = require("./reference");

/**
 * @typedef { import("@vscode/debugprotocol").DebugProtocol.VariablesResponse } VariablesResponse
 * @typedef { import("@vscode/debugprotocol").DebugProtocol.SetVariableResponse } SetVariableResponse
 * @typedef { import("../gdb").GDB } GDB
 * @typedef { import("../executionState").ExecutionState } ExecutionState
 * @typedef { import("../gdb").MidasVariable } MidasVariable
 */

class StructsReference extends VariablesReference {
  /** @type {MidasVariable[]} */
  #memberVariables;
  /** @type {string} */
  variableObjectName;
  /** @type {string} */
  evaluateName;

  stackFrameIdentifier;

  constructor(variablesReference, threadId, frameLevel, names, stackFrameIdentifier) {
    super(variablesReference, threadId, frameLevel);
    this.#memberVariables = [];
    this.stackFrameIdentifier = stackFrameIdentifier;
    this.variableObjectName = names.variableObjectName;
    this.evaluateName = names.evaluateName;
  }

  /**
   * @param { VariablesResponse } response - response which we prepare, to be sent back to VSCode
   * @param { GDB } gdb - reference to the GDB backend
   * @returns { Promise<VariablesResponse> }
   */
  async handleRequest(response, gdb) {
    // todo(simon): this is logic that DebugSession should not handle. Partially, this stuff gdb.js should be responsible for
    if (this.#memberVariables.length == 0) {
      // we haven't cached it's members
      let structAccessModifierList = await gdb.execMI(
        `-var-list-children --all-values "${this.variableObjectName}"`,
        this.threadId
      );
      let requests = [];
      for (const accessModifier of structAccessModifierList.children) {
        const membersCommands = `-var-list-children --all-values "${accessModifier.value.name}"`;
        let members = await gdb.execMI(membersCommands, this.threadId);
        const expr = (members.children ?? [{ value: { exp: null } }])[0].value.exp;
        if (expr) {
          requests.push(members);
        }
      }
      for (let v of requests.flatMap((i) => i.children)) {
        let nextRef = 0;
        let displayValue = "";
        let isStruct = false;
        if (!v.value.value || v.value.value == "{...}" || +v.value.numchild > 0) {
          nextRef = gdb.generateVariableReference();
          gdb.references.set(
            nextRef,
            new StructsReference(nextRef, this.threadId, this.frameLevel, {
              variableObjectName: v.value.name,
              evaluateName: `${this.evaluateName}.${v.value.exp}`
            }, this.stackFrameIdentifier)
          );
          gdb.getExecutionContext(this.threadId).addTrackedVariableReference({ id: nextRef, shouldManuallyDelete: false }, this.stackFrameIdentifier);
          if(v.value.type.charAt(v.value.type.length-1) == "*") {
            displayValue = `<${v.value.value}> ${v.value.type}`;
          } else {
            displayValue = v.value.type;
          }
          isStruct = true;
        } else {
          displayValue = v.value.value;
          isStruct = false;
        }
        this.#memberVariables.push(
          new GDB.MidasVariable(v.value.exp, displayValue, nextRef, v.value.name, isStruct, `${this.evaluateName}.${v.value.exp}`)
        );
      }
      response.body = {
        variables: this.#memberVariables,
      };
    } else {
      let ec = gdb.executionContexts.get(this.threadId);
      for(let v of this.#memberVariables) {
        let changeValue = ec.getMaybeUpdatedValue(v.variableObjectName);
        if(changeValue) {
          v.value = changeValue;
          ec.removeUpdatedValue(v.variableObjectName);
        }
      }
      response.body = {
        variables: this.#memberVariables,
      };
    }
    return response;
  }

  async cleanUp(gdb) {
    // we don't need to do clean up; we're always managed by either a LocalsReference or a WatchReference
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
