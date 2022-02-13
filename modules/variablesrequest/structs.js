const GDB = require("../gdb");
const { VariablesReference, err_response } = require("./variablesReference");
const {StaticsReference} = require("./statics")

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
  /** @type {string} */
  evaluateName;
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
    const frameLevel = super.getFrameLevel(gdb);
    let cmd_result = await gdb.getContentsOf(this.threadId, frameLevel, this.evaluateName);
    if(cmd_result) {
      response.body = {
        variables: this.processCommandResult(gdb, cmd_result)
      }
      return response;
    } else {
      return err_response(response, `Couldn't get value of ${this.evaluateName}`)
    }
  }

  processCommandResult(gdb, cmd_result) {
    let baseClassResults = this.processBaseClasses(gdb, cmd_result.base_classes);
    let membersResult = this.processMembers(gdb, cmd_result.members)
    let statics = this.processStatics(gdb, cmd_result.statics);
    return [...baseClassResults, ...membersResult, ...statics];
  }

  processBaseClasses(gdb, baseclasses) {
    let result = []
    for(const base_class of baseclasses) {
      const path = `${this.evaluateName}.${base_class.name}`;
      let ref = this.namesRegistered.get(base_class.name);
      if(!ref) {
        ref = gdb.generateVariableReference();
        const subStructHandler = new BaseClassReference(ref, this.threadId, this.evaluateName, this.stackFrameIdentifier, [base_class.name]);
        gdb.references.set(
          ref,
          subStructHandler
        );
        this.namesRegistered.set(base_class.name, ref);
        gdb.getExecutionContext(this.threadId).addTrackedVariableReference(ref, this.stackFrameIdentifier);
      }
      let v = new GDB.VSCodeVariable(base_class.name, base_class.display, ref, path, true, path);
      v.presentationHint = {
        kind: "baseClasss"
      }
      result.push(v);
    }
    return result;
  }

  processMembers(gdb, members) {
    let result = [];
    for(const member of members) {
      const path = `${this.evaluateName}.${member.name}`;
      if(member.isPrimitive) {
        let v = new GDB.VSCodeVariable(member.name, member.display, 0, path, false, path);
        result.push(v);
      } else {
        let ref = this.namesRegistered.get(member.name);
        if(!ref) {
          ref = gdb.generateVariableReference();
          const subStructHandler = new StructsReference(ref, this.threadId, path, this.stackFrameIdentifier);
          gdb.references.set(
            ref,
            subStructHandler
          );
          this.namesRegistered.set(member.name, ref);
          gdb.getExecutionContext(this.threadId).addTrackedVariableReference(ref, this.stackFrameIdentifier);
        }
        const v = new GDB.VSCodeVariable(member.name, member.display, ref, path, true, path);
        result.push(v);
      }
    }
    return result;
  }

  processStatics(gdb, statics) {
    let result = [];
    for(const member of statics) {
      const path = `${this.evaluateName}.${member.name}`;
      if(member.isPrimitive) {
        let ref = this.namesRegistered.get(member.name);
        if(!ref) {
          ref = gdb.generateVariableReference();
          const subScopeHandler = new StaticsReference(ref, this.threadId, path, this.stackFrameIdentifier);
          gdb.references.set(
            ref,
            subScopeHandler
          );
          this.namesRegistered.set(member.name, ref);
          gdb.getExecutionContext(this.threadId).addTrackedVariableReference(ref, this.stackFrameIdentifier);
        }
        let v = new GDB.VSCodeVariable(member.name, member.display, ref, path, false, path);
        result.push(v);
      } else {
        let ref = this.namesRegistered.get(member.name);
        if(!ref) {
          ref = gdb.generateVariableReference();
          const subScopeHandler = new StructsReference(ref, this.threadId, path, this.stackFrameIdentifier);
          gdb.references.set(
            ref,
            subScopeHandler
          );
          this.namesRegistered.set(member.name, ref);
          gdb.getExecutionContext(this.threadId).addTrackedVariableReference(ref, this.stackFrameIdentifier);
        }
        const v = new GDB.VSCodeVariable(member.name, member.display, ref, path, true, path);
        result.push(v);
      }
    }
    return result;
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

class BaseClassReference extends StructsReference {
  /**
   * @param { number } variablesReference 
   * @param { number } threadId 
   * @param { string } evaluateName - evaluation path to the members of this object; this path excludes base class names.
   *  so if Foo : Bar { int j } and Bar { int i }, means evaluate path to i, is Foo.i.
   * @param { number } stackFrameIdentifier - stack frame id for which this variable lives in
   * @param { string[] } baseClassNames - base class name hierarchy
   */
  baseClassHierarchy;
  constructor(variablesReference, threadId, evaluateName, stackFrameIdentifier, baseClassNames) {
    super(variablesReference, threadId, evaluateName, stackFrameIdentifier);
    this.baseClassHierarchy = baseClassNames;
  }

  async handleRequest(response, gdb) {
    const frameLevel = super.getFrameLevel(gdb);
    let cmd_result = await gdb.getContentsOfBaseClass(this.threadId, frameLevel, this.evaluateName, this.baseClassHierarchy);
    response.body = {
      variables: this.processCommandResult(gdb, cmd_result)
    }
    return response;
  }

  processCommandResult(gdb, cmd_result) {
    let baseClassResults = this.processBaseClasses(gdb, cmd_result.base_classes);
    let membersResult = super.processMembers(gdb, cmd_result.members)
    let statics = super.processStatics(gdb, cmd_result.statics);
    return [...baseClassResults, ...membersResult, ...statics];
  }

  processBaseClasses(gdb, baseclasses) {
    let result = []
    for(const base_class of baseclasses) {
      const path = `${this.evaluateName}.${base_class.name}`;
      let ref = this.namesRegistered.get(base_class.name);
      if(!ref) {
        ref = gdb.generateVariableReference();
        const subScopeHandler = new BaseClassReference(ref, this.threadId, this.evaluateName, this.stackFrameIdentifier, [...this.baseClassHierarchy, base_class.name]);
        gdb.references.set(
          ref,
          subScopeHandler
        );
        this.namesRegistered.set(base_class.name, ref);
        gdb.getExecutionContext(this.threadId).addTrackedVariableReference(ref, this.stackFrameIdentifier);
      }
      const v = new GDB.VSCodeVariable(base_class.name, base_class.display, ref, path, true, path);
      result.push(v);
    }
    return result;
  }

  async cleanUp(gdb) {
    super.cleanUp(gdb);
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
  StructsReference,
};
