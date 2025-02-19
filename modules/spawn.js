const { getExtensionPathOf } = require("./utils/sysutils");

class SpawnConfig {
  /** @type {string} */
  path;
  /** @type {string[]} */
  options;
  /** @type {string} */
  cwd;
  /** @type {string[]} */
  setupCommands;
  /** @type {string} */
  tracedProgramFilePath;

  /**@type {{path: string, closeTerminalOnEndOfSession: boolean, endSessionOnTerminalExit?: boolean }} */
  externalConsole;

  /** @type {boolean} */
  ignoreStandardLibrary;

  /** @type { string } - Path to the directory where Midas should look for DAP Pretty printers. */
  prettyPrinterPath;

  /**
   * @param {*} launchJson - The settings in launch.json
   */
  constructor(launchJson) {
    this.path = launchJson.gdbPath;
    const cwd = launchJson.cwd ? launchJson.cwd : null;
    this.cwd = cwd;
    this.options = launchJson.gdbOptions ?? [];
    this.setupCommands = launchJson.setupCommands;
    this.externalConsole = launchJson.externalConsole;
    this.trace = launchJson["trace"];
    this.prettyPrinterPath = launchJson.prettyPrinterPath;
    this.ignoreStandardLibrary = launchJson["ignoreStandardLibrary"];
  }

  get type() {
    return "midas-gdb";
  }

  isRRSession() {
    return false;
  }

  disposeOnExit() {
    return (this.externalConsole ?? { closeTerminalOnEndOfSession: true }).closeTerminalOnEndOfSession;
  }

  get spawnType() {
    return null;
  }

  /** @returns { Promise<string[]> } */
  getCppStandardLibraryFileList() {
    if (!this.ignoreStandardLibrary) {
      return Promise.resolve([]);
    }
    return new Promise((resolve, reject) => {
      require("fs").readFile(getExtensionPathOf("/modules/c++stdlib.ignore"), "utf-8", (err, data) => {
        if (err) {
          reject(err);
        }
        resolve(data.split("\n").filter((line) => line.length > 0));
      });
    });
  }
}

class LaunchSpawnConfig extends SpawnConfig {
  /** @type {string[]} */
  inferiorArgs;

  /**
   * @param {*} launchJson - The settings in launch.json
   */
  constructor(launchJson) {
    super(launchJson);
    this.inferiorArgs = launchJson.args ?? [];
  }

  get type() {
    return "midas-gdb";
  }
}

class AttachSpawnConfig extends SpawnConfig {
  pid;
  /**
   * @param {*} launchJson - The settings in launch.json
   */
  constructor(launchJson) {
    super(launchJson);
    this.pid = launchJson.pid;
  }

  get type() {
    return "midas-gdb";
  }
}

class RRSpawnConfig extends SpawnConfig {
  serverAddress;
  constructor(launchJson) {
    super(launchJson);
    this.rrOptions = launchJson.rrOptions ?? [];
    this.serverAddress = launchJson.serverAddress;
  }

  get type() {
    return "midas-rr";
  }

  isRRSession() {
    return true;
  }

  get spawnType() {
    return "rr";
  }
}

class MdbSpawnConfig {
  // A parameter that informs mdb that the process that actually spawned it, was RR
  // which means MDB has to configure itself properly (in order to alleviate RR recording and be able to debug MDB easier.)
  // For instance, when recording Midas debugger under RR, we don't throw the entire systems thread resources in the thread pool
  // but just use 1 or 2 (because adding more than that under RR is pointless)
  #mdbRecordedUnderRr;

  constructor(config) {
    this.path = config.mdbPath ?? "mdb";
    this.options = config.dbgArgs ?? [];
    this.debug = config.debug;
    this.#mdbRecordedUnderRr = config?.RRSession;
    this.isReplay = config?.attachArgs?.type == "rr";
    this.prettyPrinterPath = config?.prettyPrinterPath;
    if (config.childConfiguration) {
      this.processId = config.childConfiguration.processId;
      this.autoAttached = true;
    }
  }

  get isBeingRecorded() {
    return this.#mdbRecordedUnderRr;
  }

  get attached() {
    return this.autoAttached ?? false;
  }
}

module.exports = {
  // Base type of all spawn configurations
  SpawnConfig,
  LaunchSpawnConfig,
  AttachSpawnConfig,
  RRSpawnConfig,
  MdbSpawnConfig,
};
