const { getExtensionPathOf } = require("./utils/utils");

const DebugLogging = {
  Off: "off",
  GdbEventsOnly: "gdb events",
  PythonLogsOnly: "python logs",
  Full: "full",
};

function debugLogging(setting) {
  switch (setting.toLowerCase()) {
    case DebugLogging.Off:
      return { trace: false, pythonLogging: false };
    case DebugLogging.GdbEventsOnly:
      return { trace: true, pythonLogging: false };
    case DebugLogging.PythonLogsOnly:
      return { trace: false, pythonLogging: true };
    case DebugLogging.Full:
      return { trace: true, pythonLogging: true };
  }
  throw new Error(`Debug log settings set to incorrect value: ${setting}`);
}

/**
 * Run-mode settings of Midas. Loads scripts and holds trace of GDB events and debug logging.
 */
class MidasRunMode {
  #trace = false;
  #debug = false;

  /**
   * @param {*} config
   * @throws - `utilities` and `files` must provide paths to all Midas backend code, or this will throw (and Midas DA will not work).
   */
  constructor(config) {
    const { trace, pythonLogging } = debugLogging(config.trace);
    this.#trace = trace;
    this.#debug = pythonLogging;
  }

  async setProductionMode(gdb) {
    if (this.#trace) {
      await gdb.execPy("config.setTrace = True");
    } else {
      await gdb.execPy("config.setTrace = False");
    }

    if (this.#debug) {
      await gdb.execPy("config.isDevelopmentBuild = True");
    } else {
      await gdb.execPy("config.isDevelopmentBuild = False");
    }
  }

  getCommandParameters() {
    const traceparam = this.#trace ? "True" : "False";
    const debugparam = this.#debug ? "True" : "False";
    return ["-iex", `py config.setTrace = ${traceparam}`, "-iex", `py config.isDevelopmentBuild = ${debugparam}`];
  }

  async reloadStdLib(gdb) {
    const file = getExtensionPathOf("/modules/python/midas.py");
    await gdb.execCMD(`source ${file}`);
  }

  get trace() {
    return this.#trace;
  }

  get debug() {
    return this.#debug;
  }
}

module.exports = {
  MidasRunMode,
};
