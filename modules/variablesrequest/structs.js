const GDB = require("../gdb");
const { VariablesReference, err_response } = require("./variablesReference");

let LOG_ID = 0;
function log(reason, message) {
  if (!GDB.trace) {
    return;
  }
  console.log(`[LOG #${LOG_ID++}: ${reason}] - ${message}`);
}

function getBaseTypesFromVarListChildren(miResult) {
  return miResult.filter(({value}) => {
    switch(value.exp ?? "") {
      case "private":
      case "public":
      case "protected":
      case "":
        return false;
      default:
        return true;
    }
  });
}

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
  if(!structAccessModifierList.children) {
    log("VARIABLE OBJECT CREATION", `Variable object unexpectedly had no children. \n${variableObjectName}: ${JSON.stringify(structAccessModifierList, null, 2)}`);
    return [];
  }
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

  #fallbackMemberVariables = [];
  /** @type {string} */
  variableObjectName;
  /** @type {string} */
  evaluateName;

  subStructs = new Map();

  stackFrameIdentifier;

  managed;

  /**
   * 
   * @param { number } variablesReference 
   * @param { number } threadId 
   * @param { number } frameLevel 
   * @param { { variableObjectName: string, evaluateName: string } } names 
   * @param { number } stackFrameIdentifier 
   * @param { {managed: boolean} } options 
   */
  constructor(variablesReference, threadId, frameLevel, names, stackFrameIdentifier, options = { managed: false }) {
    super(variablesReference, threadId, frameLevel);
    this.#memberVariables = [];
    this.stackFrameIdentifier = stackFrameIdentifier;
    this.variableObjectName = names.variableObjectName;
    this.evaluateName = names.evaluateName;
    this.managed = options.managed;
  }

  /**
   * @param { VariablesResponse } response - response which we prepare, to be sent back to VSCode
   * @param { GDB } gdb - reference to the GDB backend
   * @returns { Promise<VariablesResponse> }
   */
  async handleRequest(response, gdb) {
    if(!this.managed) {
      const children = await gdb.getChildren(this.evaluateName);
      let res = [];
      for(const member of children) {
        const path = `${this.evaluateName}.${member.name}`;
        if(member.isPrimitive) {
          let v = new GDB.VSCodeVariable(member.name, member.display, 0, path, false, path);
          res.push(v);
        } else {
          const subStruct = this.subStructs.get(path);
          if(subStruct) {
            res.push(subStruct);
          } else {
            let nextRef = gdb.generateVariableReference();
            const options = { managed: true };
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
            res.push(v);
          }
        }
      }
      response.body = {
        variables: res,
      };
    } else {
      response.body = {
        variables: this.#memberVariables,
      };
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
          const options = { managed: true };
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
