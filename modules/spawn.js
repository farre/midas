const vscode = require("vscode");
const { MidasRunMode } = require("./buildMode");
const { spawn } = require("./utils/utils");
const { getExtensionPathOf } = require("./utils/sysutils");
const { ImmediateExecuteCommand, CommandList, ExecuteCommand } = require("./gdbCommand");
const { OutputEvent } = require("@vscode/debugadapter");

/**
 * Required setup / spawn params for Midas GDB / Midas rr
 * @param { MidasRunMode } traceSettings
 * @returns
 */
function midas_setup_settings(traceSettings) {
  return new CommandList("Midas Setup Settings", [
    new ImmediateExecuteCommand("set pagination off"),
    new ImmediateExecuteCommand(`source ${getExtensionPathOf("/modules/python/setup.py")}`),
    ...traceSettings.getCommandParameters(),
    new ImmediateExecuteCommand(`source ${getExtensionPathOf("/modules/python/midas.py")}`),
  ])
}

/**
 * Base type of spawn configurations for GDB. All derived classes
 * must provide the member function `typeSpecificParameters` which returns
 * an array of strings. This array must also contain the string `binary`
 * which exists in the base class. This is because depending on the setup,
 * the binary parameter might be passed in a different dependant order.
 * See `RRSpawnConfig`, `LaunchSpawnConfig` and `AttachSpawnConfig` for examples.
 */
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
  binary;

  traceSettings;
  /**@type {{path: string, closeTerminalOnEndOfSession: boolean, endSessionOnTerminalExit?: boolean }} */
  externalConsole;

  /**
   * @param {*} launchJson - The settings in launch.json
   */
  constructor(launchJson) {
    this.path = launchJson.gdbPath;
    const cwd = launchJson.cwd ? launchJson.cwd : null;
    this.cwd = cwd;
    this.options = launchJson.gdbOptions ?? [];
    this.setupCommands = launchJson.setupCommands;
    this.binary = launchJson.program;
    this.traceSettings = new MidasRunMode(launchJson);
    this.attachOnFork = launchJson.attachOnFork ?? false;
    this.externalConsole = launchJson.externalConsole;
    this.trace = launchJson["trace"];
  }

  /**
   * @param { import("./debugSession").MidasDebugSession } session
   * @returns { { path: string, parameters: string[] } }
   */
  build(session) {
    const commandList = new CommandList("General Settings");
    commandList.addOption("-i", "mi3");
    if(this.cwd != null) {
      commandList.addOption("--cd", this.cwd);
      commandList.addCommand(`set cwd ${this.cwd}`);
    }
    commandList.addImmediateCommand("set mi-async on");

    const setupCommands = new CommandList("Setup Commands", this.setupCommands.map(cmd => new ExecuteCommand(cmd)));
    return {
      path: this.path,
      parameters: [
        ...commandList.build(session),
        ...this.options,
        ...midas_setup_settings(this.traceSettings).build(session),
        ...setupCommands.build(session),
        // @ts-ignore - provided by interface implementation
        ...this.typeSpecificParameters(session),
      ].flatMap((e) => e),
    };
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

  /**
   * @param { "launch"  | "attach" | "remote-attach" | "remote-launch" | "rr" | "remote-rr" } spawnType
   * @returns
   */
  isSpawnType(spawnType) {
    return spawnType == this.spawnType;
  }

  get spawnType() { return null; }

  /**
   * @param {import("./gdb").GDB} gdb
   */
  // eslint-disable-next-line no-unused-vars
  async performGdbSetup(gdb) { }
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

  // eslint-disable-next-line no-unused-vars
  typeSpecificParameters(session) {
    return ["--args", this.binary, ...this.inferiorArgs].flatMap((e) => e);
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

  typeSpecificParameters() {
    return ["-p", this.pid, this.binary];
  }

  get type() {
    return "midas-gdb";
  }

  get spawnType() {
    return "attach";
  }
}

class RemoteLaunchSpawnConfig extends SpawnConfig {
  port;
  address;

  constructor(launchJson) {
    super(launchJson);
    const [address, port] = launchJson.target.parameter.split(":");
    this.target = launchJson.target;
    if(!Number.isSafeInteger(parseInt(port))) {
      throw new Error(`Could not parse port number from ${port} (parsed from remote target setting: ${JSON.stringify(launchJson.remoteTarget)})`);
    }
    this.port = parseInt(port);
    this.address = address;
    this.program = launchJson["program"];
  }

  typeSpecificParameters(session) {
    const commandList = new CommandList("Remote settings");
    commandList.addOption("-l", "10000");
    commandList.addCommand(`target extended-remote ${this.address}:${this.port}`);
    commandList.addImmediateCommand("set debuginfod enabled on");
    commandList.addImmediateCommand("set tcp connect-timeout 180");
    return [...commandList.build(session)];
  }

  get spawnType() { return "remote-launch"; }

  /** @param {import("./gdb").GDB} gdb */
  async performGdbSetup(gdb) {
    if(this.program != null && this.program != undefined) {
      gdb.execCLI(`set remote exec-file ${this.program}`);
    }
  }
}

class RemoteAttachSpawnConfig extends SpawnConfig {
  port;
  address;

  constructor(launchJson) {
    super(launchJson);
    const [address, port] = launchJson.target.parameter.split(":");
    if(!Number.isSafeInteger(parseInt(port))) {
      throw new Error(`Could not parse port number from ${port} (parsed from remote target setting: ${JSON.stringify(launchJson.remoteTarget)})`);
    }
    this.port = parseInt(port);
    this.address = address;
  }

  typeSpecificParameters(session) {
    const commandList = new CommandList("Remote settings");
    commandList.addOption("-l", "10");
    commandList.addCommand(`target extended-remote ${this.address}:${this.port}`);
    commandList.addImmediateCommand("set debuginfod enabled on");
    commandList.addImmediateCommand("set tcp connect-timeout 180");
    return [...commandList.build(session)];
  }

  get spawnType() { return "remote-attach"; }

  /** @param {import("./gdb").GDB} gdb */
  async performGdbSetup(gdb) {}
}

class RRSpawnConfig extends SpawnConfig {
  serverAddress;
  constructor(launchJson) {
    super(launchJson);
    this.serverAddress = launchJson.serverAddress;
  }

  typeSpecificParameters(session) {
    const commandList = new CommandList("RR Settings");
    commandList.addImmediateCommand("set tcp connect-timeout 180");
    commandList.addImmediateCommand("set non-stop off");
    commandList.addCommand(`target extended-remote ${this.serverAddress}`);
    return [
      "-l",
      "10000",
      ...commandList.build(session),
      this.binary,
    ];
  }

  get type() {
    return "midas-rr";
  }

  isRRSession() {
    return true;
  }

  get spawnType() { return "rr"; }
}

class RemoteRRSpawnConfig extends SpawnConfig {
  port;
  address;

  constructor(launchJson) {
    super(launchJson);
    const [address, port] = launchJson.remoteTargetConfig.address.split(":");
    this.address = address;
    this.port = port;
    this.substitutePath = launchJson["remoteTargetConfig"]["substitute-path"];
  }

  typeSpecificParameters(session) {
    const commandList = new CommandList("RR Settings");
    commandList.addImmediateCommand("set tcp connect-timeout 180");
    commandList.addImmediateCommand("set non-stop off");
    commandList.addCommand(`target extended-remote ${this.address}:${this.port}`);
    if(this.substitutePath.remote != null && this.substitutePath.local != null) {
      commandList.addCommand(`set substitute-path ${this.substitutePath.remote} ${this.substitutePath.local}`);
    }
    return [
      "-l",
      "10000",
      ...commandList.build(session),
      this.binary,
    ];
  }

  get type() {
    return "midas-rr";
  }

  isRRSession() {
    return true;
  }

  get spawnType() { return "remote-rr"; }
}

/**
 * Spawns a GDB instance with the settings provided by `spawnConfig`
 * @param { SpawnConfig } spawnConfig
 * @param { import("./debugSession").MidasDebugSession } session
 * @return { any } returns a NodeJS Child Process.
 */
function spawnGdb(spawnConfig, session) {
  const { path, parameters } = spawnConfig.build(session);
  let gdb = spawn(path, parameters);
  return gdb;
}

module.exports = {
  // Base type of all spawn configurations
  SpawnConfig,
  LaunchSpawnConfig,
  AttachSpawnConfig,
  RemoteLaunchSpawnConfig,
  RemoteAttachSpawnConfig,
  RRSpawnConfig,
  RemoteRRSpawnConfig,
  // spawn command
  spawnGdb,
};
