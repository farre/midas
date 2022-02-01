const assert = require("assert");
const GDB = require("../gdb");
const { VariablesReference, err_response } = require("./variablesReference");

/**
 * Creates a variable object for variableObjectName and create children for all it's members. This function "flattens"
 * the variable object, by creating children until it finds no more base types. Direct "struct" descendants
 * live under .public .protected and .private, but derived from, lives "directly under" so, foo.Derived instead of
 * foo.public.Derived. This function makes sure that all of Derived's members also get created as var-object listed children
 * @param { GDB.GDB } gdb
 * @param { string } variableObjectName
 */
async function parseStructVariable(gdb, variableObjectName) {
  let requests = [];
  // all variable objects for structured types, begin with .public, .protected or private, or the derived type
  let structAccessModifierList = await gdb.execMI(
    `-var-list-children --all-values "${variableObjectName}"`,
    this.threadId
  );
  for (const accessModifier of structAccessModifierList.children) {
    let e = accessModifier.value.exp;
    if(e == "public" || e == "protected" || e == "private") {
      const membersCommands = `-var-list-children --all-values "${accessModifier.value.name}"`;
      let members = await gdb.execMI(membersCommands, this.threadId);
      if(members.children && members.children[0].value.exp) {
        requests.push(members);
      }
    } else if(e) {
      let r = await parseStructVariable(gdb, accessModifier.value.name);
      requests.push(...r);
    }
  }
  return requests;
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
      let requests = await parseStructVariable(gdb, this.variableObjectName);
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
          gdb.getExecutionContext(this.threadId).addTrackedVariableReference(nextRef, this.stackFrameIdentifier);
          try {
            v.value.type.charAt(v.value.type.length - 1);
          } catch(e) {
            debugger;
          }
          if (v.value.type.charAt(v.value.type.length - 1) == "*") {
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
          new GDB.VSCodeVariable(v.value.exp, displayValue, nextRef, v.value.name, isStruct, `${this.evaluateName}.${v.value.exp}`)
        );
        gdb.executionContexts.get(this.threadId).addMapping(v.value.name, this.#memberVariables[this.#memberVariables.length - 1]);
      }
    }
    response.body = {
      variables: this.#memberVariables,
    };
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
