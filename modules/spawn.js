const vscode = require("vscode");
const { MidasRunMode } = require("./buildMode");
const { spawn } = require("./utils/utils");
const { getExtensionPathOf } = require("./utils/sysutils");
const { ImmediateExecuteCommand, CommandList } = require("./gdbCommand");

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
    const cwd = launchJson.cwd ? launchJson.cwd : vscode.workspace.workspaceFolders[0].uri.fsPath;
    this.cwd = cwd;
    this.options = launchJson.gdbOptions ?? [];
    this.setupCommands = launchJson.setupCommands;
    this.binary = launchJson.program;
    this.traceSettings = new MidasRunMode(launchJson);
    this.attachOnFork = launchJson.attachOnFork ?? false;
    this.externalConsole = launchJson.externalConsole;
  }

  build() {
    const commandList = new CommandList("General Settings");
    commandList.addOption("-i", "mi3");
    commandList.addOption("--cd", this.cwd);
    commandList.addCommand(`set cwd ${this.cwd}`);
    commandList.addImmediateCommand("set mi-async on");
    return {
      path: this.path,
      parameters: [
        ...commandList.build(),
        ...this.options,
        ...midas_setup_settings(this.traceSettings).build(),
        ...this.setupCommands.flatMap((cmd) => ["-iex", `${cmd}`]),
        // @ts-ignore - provided by interface implementation
        ...this.typeSpecificParameters(),
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

  typeSpecificParameters() {
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

  spawnType() { return "attach"; }
}

class RemoteLaunchSpawnConfig extends SpawnConfig {
  port;
  address;

  constructor(launchJson) {
    super(launchJson);
    const [address, port] = launchJson.remoteTarget.address.split(":");
    if(!Number.isSafeInteger(parseInt(port))) {
      throw new Error(`Could not parse port number from ${port} (parsed from remote target setting: ${JSON.stringify(launchJson.remoteTarget)})`);
    }
    this.port = parseInt(port);
    this.address = address;
    this.substitutePath = launchJson["remoteTarget"]["substitute-path"];
  }
  typeSpecificParameters() {
    const commandList = new CommandList("Remote settings");
    commandList.addOption("-l", "10000");
    commandList.addCommand(`target extended-remote ${this.address}:${this.port}`);
    commandList.addImmediateCommand("set debuginfod enabled on");
    commandList.addImmediateCommand("set tcp connect-timeout 180");
    commandList.addCommand("set sysroot /");
    commandList.addCommand(`set substitute-path ${this.substitutePath.remote} ${this.substitutePath.local}`);

    return [...commandList.build()];
  }

  spawnType() { return "remote"; }
}

class RRSpawnConfig extends SpawnConfig {
  serverAddress;
  constructor(launchJson) {
    super(launchJson);
    this.serverAddress = launchJson.serverAddress;
  }

  typeSpecificParameters() {
    const commandList = new CommandList("RR Settings");
    commandList.addImmediateCommand("set tcp connect-timeout 180");
    commandList.addImmediateCommand("set non-stop off");
    commandList.addCommand("set sysroot /");
    commandList.addCommand(`target extended-remote ${this.serverAddress}`);
    return [
      "-l",
      "10000",
      ...commandList.build(),
      this.binary,
    ];
  }

  get type() {
    return "midas-rr";
  }

  isRRSession() {
    return true;
  }

  spawnType() { return "rr"; }
}

/**
 * Spawns a GDB instance with the settings provided by `spawnConfig`
 * @param { SpawnConfig } spawnConfig
 * @return { any } returns a NodeJS Child Process.
 */
function spawnGdb(spawnConfig) {
  const { path, parameters } = spawnConfig.build();
  let gdb = spawn(path, parameters);
  return gdb;
}

module.exports = {
  // Base type of all spawn configurations
  SpawnConfig,
  LaunchSpawnConfig,
  AttachSpawnConfig,
  RemoteAttachSpawnConfig: RemoteLaunchSpawnConfig,
  RRSpawnConfig,
  // spawn command
  spawnGdb,
};
