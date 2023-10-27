"use strict";

const vscode = require("vscode");
const { getVSCodeCommands } = require("./commandsRegistry");
const { ConfigurationProvider, DebugAdapterFactory } = require("./providers/midas-gdb");
const { RRConfigurationProvider, RRDebugAdapterFactory } = require("./providers/midas-rr");
const { CheckpointsViewProvider } = require("./ui/checkpoints/checkpoints");
const { which } = require("./utils/sysutils");
const {
  getRR,
  strEmpty,
  getAPI,
  queryGit,
  installRRFromSource,
  verifyPreRequistesExists,
  guessInstaller,
  parseSemVer,
  semverIsNewer,
} = require("./utils/utils");
const fs = require("fs");
const Path = require("path");
const { debugLogging } = require("./buildMode");
const { InstallerExceptions } = require("./utils/installerProgress");

/** @typedef { { sha: string, date: Date } } GitMetadata */
/** @typedef { { root_dir: string, path: string, version: string, managed: boolean, git: GitMetadata } } Tool */
/** @typedef { { rr: Tool, gdb: Tool } } Toolchain */
/** @typedef { { midas_version: string, toolchain: Toolchain } } MidasConfig */

/** @returns { MidasConfig } */
const default_config_contents = () => {
  return {
    midas_version: "",
    toolchain: {
      rr: { root_dir: "", path: "", version: "", managed: false, git: { sha: null, date: null } },
      gdb: { root_dir: "", path: "", version: "", managed: false, git: { sha: null, date: null } },
    },
  };
};

function cloneNonExistingSubProperties(obj) {
  return (key, value) => {
    if (key === "" || !obj || !value || typeof value !== "object") {
      return value;
    }
    return JSON.parse(JSON.stringify({ ...obj[key], ...value }, cloneNonExistingSubProperties(obj[key])));
  };
}

const sanitize_config = (cfg) => {
  return JSON.parse(JSON.stringify(cfg, cloneNonExistingSubProperties(default_config_contents())));
};

// JSON.stringify(sanitize_config(foo))

global.API = null;

/**
 * A Debug Adapter Tracker is a means to track the communication between the editor and a Debug Adapter.
 */
class MidasDebugAdapterTracker {
  session;
  logger;

  /**
   * @param {import("./debugSession").MidasDebugSession } session
   * @param {import("vscode").OutputChannel} logger
   */
  constructor(session, logger) {
    this.session = session;
    this.logger = logger;
  }
  /**
   * A session with the debug adapter is about to be started.
   */
  onWillStartSession() {}
  /**
   * The debug adapter is about to receive a Debug Adapter Protocol message from the editor.
   */
  onWillReceiveMessage(message) {}
  /**
   * The debug adapter has sent a Debug Adapter Protocol message to the editor.
   */
  onDidSendMessage(message) {
    this.logger.appendLine(`Sent message: ${JSON.stringify(message)}`);
  }
  /**
   * The debug adapter session is about to be stopped.
   */
  onWillStopSession() {}

  /**
   * An error with the debug adapter has occurred.
   */
  async onError(error) {
    this.logger.appendLine(`Debug Adapter Error: ${JSON.stringify(error)}`);
    vscode.window.showErrorMessage("A Midas error was encountered. Show log?", ...["yes", "no"]).then((choice) => {
      if (choice == "yes") {
        this.logger.show();
      }
    });
  }
  /**
   * The debug adapter has exited with the given exit code or signal.
   */
  onExit(code, signal) {
    console.log(`The debug adapter exited with code: ${code} and signal: ${signal}`);
  }
}

class MidasDebugAdapterTrackerFactory {
  constructor() {
    this.outputChannel = null;
  }

  /**
   * The method 'createDebugAdapterTracker' is called at the start of a debug session in order
   * to return a "tracker" object that provides read-access to the communication between the editor and a debug adapter.
   *
   * @param session The {@link DebugSession debug session} for which the debug adapter tracker will be used.
   * @return A {@link DebugAdapterTracker debug adapter tracker} or undefined.
   */
  createDebugAdapterTracker(session) {
    const config = session.configuration;
    const { trace } = debugLogging(config.trace);
    if (!trace) return null;

    if (this.outputChannel == null) {
      this.outputChannel = getAPI().createLogger("Midas");
    }
    this.outputChannel.clear();
    return new MidasDebugAdapterTracker(session, this.outputChannel);
  }
}

/**
 * Public "API" returned by activate function
 */
class MidasAPI {
  #CFG_NAME = ".config";

  /** @type {import("vscode").ExtensionContext} */
  #context;

  #toolchainAddedToEnv = false;

  // loggers of Name -> Fn
  #loggers = new Map();

  /** @type {Map<String, vscode.OutputChannel>} */
  #channels = new Map();

  /** @param {import("vscode").ExtensionContext} ctx */
  constructor(ctx) {
    this.#context = ctx;

    if (!fs.existsSync(this.get_storage_path_of())) {
      fs.mkdirSync(this.get_storage_path_of(), { recursive: true });
    }
    let cfg_path = this.get_storage_path_of(this.#CFG_NAME);
    if (!fs.existsSync(cfg_path)) {
      fs.writeFileSync(cfg_path, JSON.stringify(default_config_contents()));
    }
  }

  setup_env_vars() {
    const cfg = this.get_config();
    if (!this.#toolchainAddedToEnv) {
      if (!strEmpty(cfg.toolchain.rr.path)) {
        const path = Path.dirname(cfg.toolchain.rr.path);
        this.#context.environmentVariableCollection.append("PATH", `:${path}`);
        console.log(`appended ${path} to $PATH`);
        this.#toolchainAddedToEnv = true;
      }
    }
  }

  notifyUserOfBreakingChanges() {
    let cfg = sanitize_config(this.get_config());
    const recorded_semver = parseSemVer(cfg.midas_version);
    const new_changes = (semver) => {
      return semverIsNewer(semver, recorded_semver);
    };
    if (breaking_changes.some(new_changes)) {
      // eslint-disable-next-line max-len
      const list = breaking_changes.filter(semver => semverIsNewer(semver, recorded_semver)).map(sem => `- ${sem.major}.${sem.minor}.${sem.patch}`).join("\n");
      // eslint-disable-next-line max-len
      const detail = `Some breaking changes has been introduced in recent versions.\nBe sure to read the NEWS section in the README, to see what has changed. (click the extension in your list of extensions).\n\nVersions that introduced breaking changes:\n ${list}`;
      vscode.window.showWarningMessage("Midas: Breaking changes", {detail: detail, modal: true})
    }
    cfg.midas_version = this.#context.extension.packageJSON["version"];
  }

  /** @param { MidasConfig } cfg */
  #write_config(cfg) {
    try {
      const data = JSON.stringify(cfg, null, 2);
      fs.writeFileSync(this.get_storage_path_of(this.#CFG_NAME), data);
      console.log(`Wrote configuration ${data}`);
    } catch (err) {
      console.log(`Failed to write configuration. Error: ${err}`);
    }
  }

  /** @returns {MidasConfig} */
  get_config() {
    const cfg_path = this.get_storage_path_of(this.#CFG_NAME);
    if (!fs.existsSync(cfg_path)) {
      let default_cfg = default_config_contents();
      default_cfg.midas_version = this.#context.extension.packageJSON["version"];
      fs.writeFileSync(cfg_path, JSON.stringify(default_cfg));
      return default_cfg;
    } else {
      const data = fs.readFileSync(cfg_path).toString();
      const cfg = JSON.parse(data);
      return cfg;
    }
  }

  /** @returns { Toolchain } */
  get_toolchain() {
    const cfg = this.get_config();
    return cfg.toolchain;
  }

  /**
   * Write RR settings to config file
   * @param { Tool } rr
   */
  write_rr(rr) {
    let cfg = this.get_config();
    cfg.toolchain.rr = rr;
    this.#write_config(cfg);
  }

  /**
   * Write GDB settings to config file
   * @param { Tool } gdb
   */
  write_gdb(gdb) {
    let cfg = this.get_config();
    cfg.toolchain.gdb = gdb;
    this.#write_config(cfg);
  }

  /**
   * Write Midas version to config file
   */
  write_midas_version() {
    let cfg = sanitize_config(this.get_config());
    cfg.midas_version = this.#context.extension.packageJSON["version"];
    this.#write_config(cfg);
  }

  /**
   * @param {string | null} fileOrDir
   * @returns {string} - directory or file path in global storage
   */
  get_storage_path_of(fileOrDir = null) {
    if (fileOrDir != null) {
      if (fileOrDir[0] == "/") {
        fileOrDir = fileOrDir.substring(1);
      }
      return `${this.#context.globalStorageUri.fsPath}/${fileOrDir}`;
    } else {
      return this.#context.globalStorageUri.fsPath;
    }
  }

  /**
   * Get path of `tool`, with multiple fallbacks. Order of resolving of `tool` path:
   * 1. VSCode Midas.\<rr | gdb\> Settings
   * 2. Midas managed toolchain (when built or installed via Midas command)
   * 3. $PATH
   * 4. null|undefined if not found in path
   * @param { "rr" | "gdb" } tool
   * @returns { Promise<string?> }
   */
  async resolve_tool_path(tool) {
    const cfg = vscode.workspace.getConfiguration("midas");
    if (!strEmpty(cfg.get(tool))) return cfg.get(tool);

    const toolchain = this.get_toolchain();

    if (!strEmpty(toolchain[tool].path)) return toolchain[tool].path;

    const tool_in_path = await which(tool);
    if (!strEmpty(tool_in_path)) return tool_in_path;
    return undefined;
  }

  log() {
    let cfg = this.get_config();
    console.log(`Current settings: ${JSON.stringify(cfg, null, 2)}`);
  }

  createLogger(name) {
    let logger = this.#channels.get(name);
    if (logger == null) {
      logger = vscode.window.createOutputChannel(name, "Log");
      this.#channels.set(name, logger);
    }
    return logger;
  }

  /**
   *
   * @param {string} name
   * @returns {import("vscode").OutputChannel}
   */
  getLogger(name) {
    return this.#loggers.get(name);
  }

  closeOutputChannels() {
    this.#loggers.clear();
    for (let channel of this.#channels.values()) {
      channel.dispose();
    }
    this.#channels.clear();
  }

  clearChannelOutputs() {
    for (let channel of this.#channels.values()) {
      channel.clear();
    }
  }

  async checkRRUpdates() {
    const { rr } = this.get_toolchain();
    if (rr.managed) {
      try {
        const { sha, date } = await queryGit();
        const configDate = new Date(rr.git.date ?? null);
        const queryDate = new Date(date);
        if (rr.git.sha != sha && configDate < queryDate) {
          vscode.window
            .showInformationMessage("A newer version of RR can be built. Do you want to build it?", ...["yes", "no"])
            .then(async (res) => {
              if (res == "yes") {
                await this.updateRR();
              }
            });
        }
      } catch (ex) {
        vscode.window.showInformationMessage(`Update failed: ${ex}`);
      }
    }
  }

  async updateRR() {
    let logger = vscode.window.createOutputChannel("Installing RR dependencies", "Log");
    logger.show();
    let cfg = this.get_toolchain();
    logger.appendLine(`Current toolchain: ${JSON.stringify(cfg)}`);
    const requiredTools = ["cmake", "python", "unzip"];
    const requirements = verifyPreRequistesExists(requiredTools);
    for (const tool of requiredTools) {
      if (!requirements.hasOwnProperty(tool)) {
        // eslint-disable-next-line max-len
        throw {
          type: InstallerExceptions.TerminalCommandNotFound,
          message: `Could not determine if you have one of the required tools installed on your system: ${requiredTools.join(
            ", "
          )}`,
        };
      }
      if (!requirements[tool].found()) {
        throw { type: InstallerExceptions.TerminalCommandNotFound, message: requirements[tool].errorMessage() };
      }
    }
    let args = {};
    for (const tool of requiredTools) {
      args[tool] = requirements[tool].path;
    }
    const tmp_build_path = this.get_storage_path_of("rr-tmp-update");
    logger.appendLine(`Temporary RR build directory: ${tmp_build_path}`);
    try {
      await guessInstaller(args["python"], logger);
    } catch (ex) {
      logger.appendLine(
        `Couldn't update RR: ${JSON.stringify(ex)}. If you're running in a virtual environement updating will not work.`
      );
      return;
    }

    try {
      const {
        install_dir: install_directory,
        build_dir,
        path,
        managed,
        git,
        version,
      } = await installRRFromSource(args, logger, tmp_build_path);
      logger.appendLine("Building of RR succeeded. Removing old build...");
      if (fs.existsSync(cfg.rr.root_dir)) {
        fs.rmSync(cfg.rr.root_dir, { force: true, recursive: true });
      }
      // for not-yet-migrated configs, we don't have root path; we need to determine
      // path from binary path; which is, pop /bin/rr off of it
      if (cfg.rr.root_dir == "" && fs.existsSync(cfg.rr.path)) {
        const binary_dir = Path.dirname(cfg.rr.path);
        const rr_dir = Path.dirname(binary_dir);
        fs.rmSync(rr_dir, { force: true, recursive: true });
      }
      fs.renameSync(build_dir, install_directory);
      cfg.rr = { root_dir: install_directory, version, git, managed, path: `${install_directory}/bin/rr` };
      this.write_rr(cfg.rr);
    } catch (ex) {
      logger.appendLine(`Couldn't update RR: ${ex}`);
      fs.rmSync(cfg.rr.root_dir, { force: true, recursive: true });
    }
  }
}

/**
 * Run first time midas runs.
 * @param { MidasAPI } api
 */
async function init_midas(api) {
  const cfg = api.get_config();
  // the first time we read config, this will be empty.
  // this can't be guaranteed with vscode mementos. They just live their own life of which we
  // have 0 oversight over.
  if (strEmpty(cfg.midas_version)) {
    const answers = ["yes", "no"];
    const msg = "Thank you for using Midas. Do you want to setup RR settings for Midas?";
    const opts = { modal: true, detail: "Midas will attempt to find RR on your system" };
    const answer = await vscode.window.showInformationMessage(msg, opts, ...answers);
    if (answer == "yes") {
      const rr = await which("rr");
      if (strEmpty(rr)) {
        const msg = "No RR found in $PATH. Do you want Midas to install or build RR?";
        const opts = { modal: true };
        if ((await vscode.window.showInformationMessage(msg, opts, ...answers)) == "yes") {
          await getRR();
        }
      }
    }
  }
  api.setup_env_vars();
  api.notifyUserOfBreakingChanges();
  api.write_midas_version();
}

function registerMidasType(context) {
  let provider = new ConfigurationProvider();
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(
      provider.type,
      provider,
      vscode.DebugConfigurationProviderTriggerKind.Dynamic
    )
  );
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(provider.type, new DebugAdapterFactory())
  );
}

function registerRRType(context) {
  const cp_provider = new CheckpointsViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(cp_provider.type, cp_provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
  const rrProvider = new RRConfigurationProvider();
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(
      rrProvider.type,
      rrProvider,
      vscode.DebugConfigurationProviderTriggerKind.Dynamic
    )
  );
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(rrProvider.type, new RRDebugAdapterFactory(cp_provider))
  );
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function activateExtension(context) {
  vscode.debug.registerDebugAdapterTrackerFactory("*", new MidasDebugAdapterTrackerFactory());
  context.subscriptions.push(...getVSCodeCommands());

  registerMidasType(context);
  registerRRType(context);

  global.API = new MidasAPI(context);
  await init_midas(global.API);
  await global.API.checkRRUpdates();
}

function deactivateExtension() {}

const breaking_changes = [{ major: 0, minor: 20, patch: 0 }];

module.exports = {
  activateExtension,
  deactivateExtension,
  MidasAPI,
  sanitize_config,
};
