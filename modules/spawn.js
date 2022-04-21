const vscode = require("vscode");
const ext = vscode.extensions.getExtension("farrese.midas");
const dir = `${ext.extensionPath}/modules/python`;
const { MidasRunMode } = require("./buildMode");
const { spawn } = require("./utils");

/**
 * Required setup / spawn params for Midas GDB / Midas rr
 * @param { MidasRunMode } traceSettings
 * @returns
 */
function midas_setup_settings(traceSettings) {
  return [
    ["-iex", "set pagination off"],
    ["-iex", `source ${dir}/setup.py`],
    traceSettings.getCommandParameters(),
    ["-iex", `source ${dir}/midas.py`],
  ];
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
  path;
  options;
  cwd;
  setupCommands;
  binary;
  traceSettings;

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
  }

  build() {
    return {
      path: this.path,
      parameters: [
        "-i=mi3",
        `--cd=${this.cwd}`,
        "-ex",
        `set cwd ${this.cwd}`,
        "-iex",
        "set mi-async on",
        ...this.options,
        ...midas_setup_settings(this.traceSettings),
        ...this.setupCommands.flatMap((cmd) => ["-iex", `${cmd}`]),
        // @ts-ignore - provided by interface implementation
        ...this.typeSpecificParameters(),
      ].flatMap((e) => e),
    };
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
}

class RRSpawnConfig extends SpawnConfig {
  serverAddress;
  constructor(launchJson) {
    super(launchJson);
    this.serverAddress = launchJson.serverAddress;
  }

  typeSpecificParameters() {
    return [
      "-l",
      "10000",
      "-iex",
      "set tcp connect-timeout 180", // if rr is taking time to start up, we want to wait. We set it to 3 minutes.
      "-iex",
      "set non-stop off",
      "-ex",
      "set sysroot /",
      `-ex`,
      `target extended-remote ${this.serverAddress}`,
      this.binary,
    ];
  }
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
  RRSpawnConfig,
  // spawn command
  spawnGdb,
};
