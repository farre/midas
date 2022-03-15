const vscode = require("vscode");

/**
 * Run-mode settings of Midas. Loads scripts and holds trace of GDB events and debug logging.
 */
class MidasRunMode {
  #trace = false;
  #debug = false;

  /**
   * @param {*} trace
   * @param {*} debug
   * @throws - `utilities` and `files` must provide paths to all Midas backend code, or this will throw (and Midas DA will not work).
   */
  constructor(trace, debug) {
    this.#trace = trace;
    this.#debug = debug;
  }

  async setProductionMode(gdb) {
    if(this.#trace) {
      await gdb.execPy("setTrace = True");
    } else {
      await gdb.execPy("setTrace = False");
    }

    if(this.#debug) {
      await gdb.execPy("isDevelopmentBuild = True");
    } else {
      await gdb.execPy("isDevelopmentBuild = False");
    }
  }

  async reloadStdLib(gdb) {
    const ext = vscode.extensions.getExtension("farrese.midas");
    const dir = `${ext.extensionPath}/modules/python`
    await gdb.execCMD(`source ${dir}/stdlib.py`);
  }

  get trace() {
    return this.#trace;
  }

  get debug() {
    return this.#debug;
  }
}

module.exports = {
  MidasRunMode
}