"use strict";

const vscode = require("vscode");
const { getVSCodeCommands } = require("./commandsRegistry");
const { ConfigurationProvider, DebugAdapterFactory } = require("./providers/midas-gdb");
const { RRConfigurationProvider, RRDebugAdapterFactory } = require("./providers/midas-rr");
const { MdbConfigurationProvider, MdbDebugAdapterFactory } = require("./providers/midas-native");
const { CheckpointsViewProvider } = require("./ui/checkpoints/checkpoints");
const { which, sanitizeEnvVariables } = require("./utils/sysutils");
const {
  strEmpty,
  getAPI,
  parseSemVer,
  semverIsNewer,
  releaseNotesProvider,
  showReleaseNotes,
  Tool,
  createEmptyMidasConfig,
} = require("./utils/utils");
const fs = require("fs");
const { debugLogging } = require("./buildMode");
const { ProvidedAdapterTypes, DebugLogging, CustomRequests, CustomRequestsUI, ContextKeys } = require("./constants");
const { execSync } = require("child_process");
const { ManagedToolchain } = require("./toolchain");

function cloneNonExistingSubProperties(obj) {
  return (key, value) => {
    if (key === "" || !obj || !value || typeof value !== "object") {
      return value;
    }
    return JSON.parse(JSON.stringify({ ...obj[key], ...value }, cloneNonExistingSubProperties(obj[key])));
  };
}

/** @returns {import("./utils/utils").MidasConfig} */
const sanitizeConfig = (cfg) => {
  return JSON.parse(JSON.stringify(cfg, cloneNonExistingSubProperties(createEmptyMidasConfig())));
};

// JSON.stringify(sanitize_config(foo))

global.API = null;

/**
 * A Debug Adapter Tracker is a means to track the communication between the editor and a Debug Adapter.
 */
class MidasDebugAdapterTracker {
  session;
  logger;

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
  onWillReceiveMessage(message) {
    if (message.command) {
      this.logger.appendLine(`[REQ][${message.command}] ----> ${JSON.stringify(message)}`);
    } else {
      this.logger.appendLine(`[EVT][${message.event}] ----> ${JSON.stringify(message)}`);
    }
  }
  /**
   * The debug adapter has sent a Debug Adapter Protocol message to the editor.
   */
  onDidSendMessage(message) {
    if (message.command) {
      this.logger.appendLine(`[RES][${message.command}] <---- ${JSON.stringify(message)}\n`);
    } else {
      this.logger.appendLine(`[EVT][${message.event}] <---- ${JSON.stringify(message)}\n`);
    }
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

  initOutputChannel() {
    if (this.outputChannel == null) {
      this.outputChannel = getAPI().createLogger("Midas");
    }
    this.outputChannel.clear();
    this.outputChannel.show();
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
    switch (config.type) {
      case ProvidedAdapterTypes.Native: {
        if (config.debug?.logging?.dapMessages) {
          this.initOutputChannel();
          return new MidasDebugAdapterTracker(session, this.outputChannel);
        }
        break;
      }
      case ProvidedAdapterTypes.RR:
      case ProvidedAdapterTypes.Gdb: {
        const { trace } = debugLogging(config?.trace ?? DebugLogging.Off);
        if (!trace) return null;

        this.initOutputChannel();
        return new MidasDebugAdapterTracker(session, this.outputChannel);
      }
    }
    return null;
  }
}

// This will make it impossible to introduce this bug again.
class APIInit {
  configFilePath;
  constructor(extensionContext) {
    if (!fs.existsSync(extensionContext.globalStorageUri.fsPath)) {
      fs.mkdirSync(extensionContext.globalStorageUri.fsPath, { recursive: true });
    }
    this.configFilePath = `${extensionContext.globalStorageUri.fsPath}/.config`;
    if (!fs.existsSync(this.configFilePath)) {
      fs.writeFileSync(this.configFilePath, JSON.stringify(createEmptyMidasConfig()));
    }
  }

  get configFile() {
    return this.configFilePath;
  }
}

// The objects of type vscode.DebugSession lives in a different process (seemingly, at least)
// than the ones in the extension vscode.debugadapter.DebugSession. Only way of having some
// fine tuned control of the UI is unfortunately via customRequests.
class UIDebugSession {
  /** @type { vscode.DebugSession } */
  #session;
  /** @param { vscode.DebugSession } session */
  constructor(session) {
    this.#session = session;
  }

  /** @returns { Thenable<boolean> } */
  ManagesThread(id) {
    return this.#session.customRequest(CustomRequestsUI.HasThread, { id: id }).then((res) => res?.hasThread);
  }

  /** @returns { Thenable<void> } */
  ContinueAll() {
    return this.#session.customRequest(CustomRequests.ContinueAll, {});
  }

  /** @returns { Thenable<void> } */
  PauseAll() {
    return this.#session.customRequest(CustomRequests.PauseAll, {});
  }

  /** @returns { Thenable<boolean> } */
  SelectedThreadInUI(id) {
    return this.#session.customRequest(CustomRequests.OnSelectedThread, { id: id });
  }

  /** @param {string} sessionId @returns { boolean } */
  CompareId(sessionId) {
    return this.#session.id == sessionId;
  }

  static SelectedThreadInUi(session, id) {
    return session.customRequest(CustomRequests.OnSelectedThread, { id: id });
  }
}

/**
 * Public "API" returned by activate function
 */
class MidasAPI extends APIInit {
  /** @type {import("vscode").ExtensionContext} */
  #context;

  #toolchainAddedToEnv = false;

  // loggers of Name -> Fn
  #loggers = new Map();

  /** @type {Map<String, vscode.OutputChannel>} */
  #channels = new Map();

  /** @type { Map<String, import("./utils/utils").Tool> } */
  #tools = new Map();

  /** @type { Map<String, UIDebugSession> } */
  #debugSessions = new Map();

  /** @param {import("vscode").ExtensionContext} ctx */
  constructor(ctx) {
    super(ctx);
    this.#context = ctx;
  }

  initToolsRequired() {
    this.toolsInitialized = this.toolsInitialized ?? false;

    if (!this.toolsInitialized) {
      const RequiredTools = {
        cmake: { variants: ["cmake"] },
        make: { variants: ["make"] },
        python: { variants: ["python", "python3", "py"] },
        unzip: { variants: ["unzip"] },
        ninja: { variants: ["ninja"] },
      };
      for (const prop in RequiredTools) {
        for (const variant of RequiredTools[prop].variants) {
          try {
            const p = execSync(`which ${variant}`, { env: sanitizeEnvVariables() }).toString().trim();
            this.#tools.set(prop, new Tool(prop, p, null));
            break;
          } catch (e) {}
        }
      }
      this.toolsInitialized = true;
    }
  }

  /**
   * @returns { ManagedToolchain }
   */
  getToolchain() {
    return this.toolchain;
  }

  getSystemTool(name) {
    this.initToolsRequired();
    const tool = this.#tools.get(name);
    return tool;
  }

  getRequiredSystemTool(name) {
    const tool = this.getSystemTool(name);
    if (tool == null) {
      vscode.window.showErrorMessage(
        `Failed to find required tool ${name} on $PATH. This may cause Midas toolchain management to not work.`,
      );
      throw new Error(`Could not determine ${name} existence on system`);
    }
    return tool;
  }

  getPython() {
    return this.getRequiredSystemTool("python");
  }

  getCmake() {
    return this.getRequiredSystemTool("cmake");
  }

  getUnzip() {
    return this.getRequiredSystemTool("unzip");
  }

  getMake() {
    return this.getRequiredSystemTool("make");
  }

  hasRequiredTools(required) {
    for (const req of required) {
      try {
        const t = this.getRequiredSystemTool(req);
      } catch (ex) {
        return false;
      }
    }
    return true;
  }

  maybeDisplayReleaseNotes() {
    try {
      let cfg = ManagedToolchain.loadConfig(this.#context);
      const recordedSemVer = parseSemVer(cfg.midas_version);
      const currentlyLoadedSemVer = parseSemVer(this.#context.extension.packageJSON["version"]);
      if (semverIsNewer(currentlyLoadedSemVer, recordedSemVer ?? currentlyLoadedSemVer) || recordedSemVer == null) {
        showReleaseNotes();
      }
    } catch (ex) {
      console.log(`exception caught, won't show release notes: ${ex}`);
    }
  }

  #write_config(cfg) {
    try {
      const data = JSON.stringify(cfg, null, 2);
      fs.writeFileSync(this.configFile, data);
      console.log(`Wrote configuration ${data}`);
    } catch (err) {
      console.log(`Failed to write configuration. Error: ${err}`);
    }
  }

  /** @returns {import("./utils/utils").MidasConfig} */
  getConfig() {
    return ManagedToolchain.loadConfig(this.#context);
  }

  getWrittenMidasVersion() {
    return ManagedToolchain.loadConfig(this.#context).midas_version;
  }

  getExtensionVersion() {
    return this.#context.extension.packageJSON["version"];
  }

  /** @returns { import("./utils/utils").Toolchain } */
  getToolchainConfiguration() {
    return ManagedToolchain.loadConfig(this.#context).toolchain;
  }

  /**
   * Write Midas version to config file
   */
  serializeMidasVersion() {
    const configuration = ManagedToolchain.loadConfig(this.#context);
    let sanitizedConfiguration = sanitizeConfig(configuration);
    sanitizedConfiguration.midas_version = this.#context.extension.packageJSON["version"];
    this.#write_config(sanitizedConfiguration);
  }

  /**
   * @param {string | null} fileOrDir
   * @returns {string} - directory or file path in global storage
   */
  getStoragePathOf(fileOrDir = null) {
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
   * @param { "rr" | "gdb" | "mdb" } tool
   * @throws Will throw if `tool`'s path could not be resolved using 'which' command or reading Midas configuration
   * @returns { Promise<string?> }
   */
  async resolveToolPath(tool) {
    const cfg = vscode.workspace.getConfiguration("midas");
    if (!strEmpty(cfg.get(tool))) return cfg.get(tool);

    const tool_in_path = await which(tool);
    if (!strEmpty(tool_in_path)) return tool_in_path;
    throw new Error(`Could not resolve path for ${tool}`);
  }

  /**
   * Gets `name` tool if it has been installed and is managed by Midas, otherwise attempt to return system installation.
   * @param {"rr" | "gdb" | "mdb"} name
   * @throws Will throw if no path (or managed tool) could be resolved for `name`
   * @returns { Promise<import("./toolchain").ManagedTool | Tool> } Returns an object that satisfies the Tool interface
   */
  async getDebuggerTool(name) {
    const tool = this.toolchain.getTool(name);
    if (tool.managed) {
      return tool;
    }
    const path = await this.resolveToolPath(name);
    return new Tool(name, path, null);
  }

  createLogger(name) {
    let logger = this.#channels.get(name);
    if (logger == null) {
      logger = vscode.window.createOutputChannel(name, "Log");
      this.#channels.set(name, logger);
    }
    return logger;
  }

  initToolchain() {
    const toolConfigureLogger = this.createLogger("Midas: Tool management");
    toolConfigureLogger.hide();
    this.toolchain = new ManagedToolchain(this.#context, toolConfigureLogger);
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

  async checkToolchainUpdates() {
    const manager = this.getToolchain();
    for (const tool of ["rr", "gdb", "mdb"]) {
      try {
        manager.getTool(tool).update();
      } catch (ex) {}
    }
  }

  async updatesCheck() {
    try {
      const changed = await this.toolchain.checkUpdates();
      if (changed) {
        this.toolchain.serialize();
      }
    } catch (ex) {
      vscode.window.showErrorMessage(`Failed to update: ${ex}`);
    }
  }

  /** @return { Map<string, UIDebugSession> } */
  GetDebugSessions() {
    return this.#debugSessions;
  }

  AddDebugSession(session) {
    this.#debugSessions.set(session.id, new UIDebugSession(session));
  }

  RemoveDebugSession(session) {
    this.#debugSessions.delete(session.id);
  }
}

/**
 * Run first time midas runs.
 * @param { MidasAPI } api
 */
async function initMidas(api) {
  let firstInit = false;
  api.initToolchain();
  const cfg = api.getConfig();
  // the first time we read config, this will be empty.
  // this can't be guaranteed with vscode mementos. They just live their own life of which we
  // have 0 oversight over.
  if (strEmpty(cfg.midas_version)) {
    firstInit = true;
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
          await api.getToolchain().getTool("rr").beginInstallerUI();
        }
      }
    }
  }
  api.getToolchain().exportEnvironment();
  api.maybeDisplayReleaseNotes();
  api.serializeMidasVersion();

  if (!firstInit) {
    await api.updatesCheck();
  }
}

function registerDebuggerType(context, ConfigConstructor, FactoryConstructor, checkpointProvider = null) {
  const provider = new ConfigConstructor();
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(
      provider.type,
      provider,
      vscode.DebugConfigurationProviderTriggerKind.Dynamic,
    ),
  );

  if (checkpointProvider != null) {
    context.subscriptions.push(
      vscode.debug.registerDebugAdapterDescriptorFactory(provider.type, new FactoryConstructor(checkpointProvider)),
    );
  } else {
    context.subscriptions.push(
      vscode.debug.registerDebugAdapterDescriptorFactory(provider.type, new FactoryConstructor()),
    );
  }
}

/** @returns { MidasAPI } */
function InitializeGlobalApi(ctx) {
  if (global.API == null || global.API == undefined) {
    global.API = new MidasAPI(ctx);
    initMidas(global.API);
  }
  return global.API;
}

function RestoreContextDefaults() {
  vscode.commands.executeCommand("setContext", ContextKeys.RRSession, false);
  vscode.commands.executeCommand("setContext", ContextKeys.NativeMode, false);
  vscode.commands.executeCommand("setContext", ContextKeys.NoSingleThreadControl, true);
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function activateExtension(context) {
  vscode.debug.registerDebugAdapterTrackerFactory("*", new MidasDebugAdapterTrackerFactory());
  context.subscriptions.push(...getVSCodeCommands());

  context.subscriptions.push(releaseNotesProvider());

  const checkpointProvider = new CheckpointsViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(checkpointProvider.type, checkpointProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  try {
    registerDebuggerType(context, ConfigurationProvider, DebugAdapterFactory);
    registerDebuggerType(context, RRConfigurationProvider, RRDebugAdapterFactory, checkpointProvider);
    registerDebuggerType(context, MdbConfigurationProvider, MdbDebugAdapterFactory, checkpointProvider);
  } catch (ex) {
    console.log(`Failed to init Midas`);
    throw ex;
  }

  let api = InitializeGlobalApi(context);
  global.API.DebugSessionMap = new Map();

  vscode.debug.onDidStartDebugSession((session) => {
    api.AddDebugSession(session);
  });

  vscode.debug.onDidChangeActiveStackItem((uiElement) => {
    if (uiElement.threadId) {
      UIDebugSession.SelectedThreadInUi(uiElement.session, uiElement.threadId);
    }
  });

  vscode.debug.onDidTerminateDebugSession((session) => {
    api.RemoveDebugSession(session);
    if (api.GetDebugSessions().size == 0) {
      RestoreContextDefaults();
    }
  });

  return api;
}

function deactivateExtension() {}

module.exports = {
  activateExtension,
  deactivateExtension,
  MidasAPI,
  sanitize_config: sanitizeConfig,
};
