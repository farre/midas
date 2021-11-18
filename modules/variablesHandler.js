const DebugAdapter = require("vscode-debugadapter");
const { VariableObject } = require("./gdbtypes");

const STACK_ID_START = 1000;
const VAR_ID_START = 1000 * 1000;

class VariableHandler {
  /** @type { DebugAdapter.Handles<VariableObject> } */
  #variableHandles;
  /** @type { Map<string, number> } */
  #nameToIdMapping;

  /** @type { number[] } */
  #ids;

  constructor() {
    this.#variableHandles = new DebugAdapter.Handles(VAR_ID_START);
    this.#nameToIdMapping = new Map();
  }

  /**
   *
   * @param { VariableObject } variable
   * @returns
   */
  create(variable) {
    let var_id = this.#variableHandles.create(variable);
    this.#nameToIdMapping.set(variable.name, var_id);
    this.#ids.push(var_id);
    return var_id;
  }

  /**
   *
   * @param {string} name
   * @param {string} expression
   * @param {string} childrenCount
   * @param {string} value
   * @param {string} type
   * @param {string} has_more
   * @returns
   */
  createNew(name, expression, childrenCount, value, type, has_more) {
    let vob = new VariableObject(
      name,
      expression,
      childrenCount,
      value,
      type,
      has_more,
      0
    );
    let vid = this.#variableHandles.create(vob);
    this.#variableHandles.get(vid).variableReference = vid;
    return vid;
  }

  /**
   * @param {string} name
   * @returns {VariableObject | undefined}
   */
  getByName(name) {
    return this.#variableHandles.get(this.#nameToIdMapping.get(name));
  }

  /**
   * @param {number} id
   * @returns {VariableObject | undefined}
   */
  getById(id) {
    return this.#variableHandles.get(id);
  }

  /**
   * @param {string} name
   * @returns {boolean}
   */
  hasName(name) {
    return this.#nameToIdMapping.get(name) !== undefined;
  }

  /**
   *
   * @param {number} id
   * @returns {boolean}
   */
  hasID(id) {
    for (const vid of this.#ids) {
      if (vid == id) return true;
    }
    return false;
  }

  reset() {
    this.#ids = [];
    this.#nameToIdMapping = new Map();
    this.#variableHandles = new DebugAdapter.Handles(VAR_ID_START);
  }

  get names() {
    return this.#nameToIdMapping.keys();
  }
}

module.exports = {
  VariableHandler,
  VAR_ID_START,
  STACK_ID_START,
};
