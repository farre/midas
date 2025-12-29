const fs = require("fs");
const vs = require("vscode");
const { EventEmitter } = require("events");
const { spawn, execSync } = require("child_process");
const { sanitizeEnvVariables, which, getExtensionPathOf } = require("./utils/sysutils");
const path = require("path");
const { getAPI, kill_pid, Tool, createEmptyMidasConfig, strEmpty } = require("./utils/utils");
const { systemInstall } = require("./utils/installerProgress");
const { consoleLog, consoleErr } = require("./utils/log");

const matcher = /(\n)\[(?<current>\d+)\/(?<total>\d+)\]/g;
function cmakeProgress(str, last) {
  const matches = str.matchAll(matcher);
  let incremented = 0;
  let current_last = last;
  for (const res of matches) {
    const { current, total } = res.groups;
    const current_percent = (+current / +total) * 100.0;
    incremented += current_percent - current_last;
    current_last += incremented;
  }
  return incremented;
}

class ToolDependencies {
  #name;
  #apt;
  #dnf;
  #pacman;

  constructor(name, deps) {
    this.#name = name;
    this.#apt = deps["apt"];
    this.#dnf = deps["dnf"];
    this.#pacman = deps["pacman"];
  }

  async config() {
    const verifyPackageManagerImport = async (args) => {
      return new Promise((resolve) => {
        getAPI()
          .getPython()
          .spawn(args, { env: sanitizeEnvVariables() })
          .on("exit", (code) => {
            if (code == 0) {
              resolve(true);
            } else {
              resolve(false);
            }
          });
      });
    };

    if (!strEmpty(await which("dpkg"))) {
      if (!(await verifyPackageManagerImport(["-c", "import apt"]))) {
        throw new Error(`[${this.#name}][Python Error]: Could not import APT module on a verified dpkg system.`);
      }
      return {
        name: "apt",
        repoType: getExtensionPathOf("modules/python/apt_manager.py"),
        packages: this.#apt,
      };
    }

    if (!strEmpty(await which("rpm"))) {
      if (!(await verifyPackageManagerImport(["-c", `import dnf`]))) {
        throw new Error(`[${this.#name}][Python Error]: Could not import DNF module on a verified RPM system.`);
      }
      return {
        name: "dnf",
        repoType: getExtensionPathOf("modules/python/dnf_manager.py"),
        packages: this.#dnf,
      };
    }

    if (!strEmpty(await which("pacman"))) {
      if (!(await verifyPackageManagerImport(["-c", `import pyalpm`]))) {
        throw new Error(`[${this.#name}][Python Error]: Could not import ALPM module on a verified pacman system.`);
      }
      return {
        name: "pacman",
        repoType: getExtensionPathOf("modules/python/pacman_manager.py"),
        packages: this.#pacman,
      };
    }
    throw new Error(`[${this.#name}]: Could not resolve what package manager is used on your system`);
  }
}

/**
 * Downloads a file from `url` and saves it as `file_name` in the extension folder.
 * @param {string} url - The url of the file to download
 * @param {string} path - Path to write the file to.
 * @param { EventEmitter } emitter - Progress & cancellation emitter
 * @returns {Promise<{path: string, status: "success" | "cancelled" }>} `path` of saved file and `status` indicates if it
 */
async function downloadFile(url, path, emitter) {
  const removeFile = (file) => fs.rmSync(file, { recursive: false });
  if (fs.existsSync(path)) {
    removeFile(path);
  }
  return new Promise((resolve, reject) => {
    const output_stream = fs.createWriteStream(path, { flags: "wx" });
    const cleanup = (err, exception) => {
      consoleErr(`Exception: ${err}`);
      output_stream.close();
      removeFile(path);
      reject(exception);
    };

    const controller = new AbortController();
    const signal = controller.signal;
    signal.addEventListener("abort", () => {
      output_stream.close();
      removeFile(path);
      resolve({ path: path, status: "cancelled" });
    });
    const handle_response = (request, response) => {
      if (response.statusCode != 200) {
        // eslint-disable-next-line max-len
        throw new Error(`Download error. Server responded with: ${response.statusCode} - ${response.statusMessage}`);
      }
      response.pipe(output_stream);
      const file_size = response.headers["content-length"] ?? 0;
      response.on("data", (chunk) => {
        // if github says "nopesies" to sending content-length, due to compression, we'll get no progress here.
        const increment = (chunk.length / +file_size) * 100.0;
        emitter.emit("report", { increment: increment, message: `${url}` });
      });
      emitter.on("cancel", () => {
        controller.abort();
      });
      request.on("error", (err) => {
        cleanup(err, err.message);
      });
      output_stream.on("error", (err) => {
        cleanup(err, err.message);
      });
      output_stream.on("close", () => {
        resolve({ path: path, status: "success" });
      });
    };

    const request = require("https").get(url, { signal: signal }, (response) => {
      if (response.statusCode == 302) {
        let new_request = require("https").get(response.headers.location, { signal: signal }, (res) => {
          handle_response(new_request, res);
        });
      } else if (response.statusCode == 200) {
        handle_response(request, response);
      } else {
        cleanup(
          "Could not resolve redirection for rr source zip",
          `Download error. Server responded with: ${response.statusCode} - ${response.statusMessage}`,
        );
      }
    });
  });
}

/**
 * Downloads a file from `url` and saves it as `file_name` in the extension folder.
 * @param {string} url - The url of the file to download
 * @param {string} path - Path to write the file to.
 * @returns {Promise<{path: string, status: "success" | "cancelled" }>} `path` of saved file and `status` indicates if it
 */
async function downloadFileHttp(url, path) {
  return await vs.window.withProgress(
    {
      location: vs.ProgressLocation.Notification,
      cancellable: true,
      title: "Downloading",
    },
    async (progress, token) => {
      let emitter = new EventEmitter();
      emitter.on("report", (report) => {
        progress.report(report);
      });
      token.onCancellationRequested(() => {
        emitter.emit("cancel");
      });
      return await downloadFile(url, path, emitter);
    },
  );
}

/**
 * @abstract
 */
class BuildTool {
  #logger;
  sourcePath;
  buildPath;

  constructor(sourcePath, buildPath, logger) {
    this.#logger = logger;
    this.sourcePath = sourcePath;
    this.buildPath = buildPath;
  }

  log(msg) {
    if (this.#logger) {
      this.#logger.appendLine(msg);
    }
  }

  onProgress(cb) {}

  /**
   * @abstract
   * @param {boolean} debug - whether or not this build should be debug
   * @param {string[]} args - configuration args
   * @returns { Promise<boolean> } - A promise that when resolved resolves whether configuration was completed or not
   */
  // eslint-disable-next-line no-unused-vars
  async configure(debug, args) {
    throw new Error("async configure(debug, args) must be implemented");
  }

  /**
   * @abstract
   * @param {EventEmitter} cancellation - An event emitter which we emit cancellation events to.
   * @returns { Promise<boolean> } - A promise that when resolved resolves whether build was completed or not.
   */
  // eslint-disable-next-line no-unused-vars
  build(cancellation) {
    throw new Error("build(cancellation) must be implemented");
  }
}

class CMake extends BuildTool {
  #progress;
  #sourcePath;
  #buildPath;
  #logger;

  constructor(sourcePath, buildPath, logger) {
    super(sourcePath, buildPath, logger);
    this.#progress = new EventEmitter();
    this.#sourcePath = sourcePath;
    this.#buildPath = buildPath;
    this.#logger = logger;
  }

  usesNinja() {
    return true;
  }

  onProgress(cb) {
    this.#progress.on("progress", cb);
  }

  #spawn(args) {
    return getAPI()
      .getRequiredSystemTool("cmake")
      .spawn(args, { stdio: "pipe", env: sanitizeEnvVariables(), shell: true, detached: true });
  }

  /**
   * @param {string | "clang" | "gcc"} choice
   */
  compilerSetting(choice) {
    switch (choice) {
      case "clang":
        return `-DCMAKE_CXX_COMPILER=clang++ -DCMAKE_C_COMPILER=clang`;
      case "gcc":
        return `-DCMAKE_CXX_COMPILER=g++ -DCMAKE_C_COMPILER=gcc`;
      default:
        throw new Error(`Unsupported compiler ${choice}`);
    }
  }

  /**
   * @param {boolean} debug
   * @param {string[]} cmakeArguments
   */
  async configure(debug, cmakeArguments) {
    const compiler =
      (await vs.window.showQuickPick(["clang", "gcc"], {
        title: "Pick compiler to build with or cancel to let Midas choose.",
      })) ?? "clang";

    let args = [];

    if (debug) {
      args.push(
        "-S",
        this.#sourcePath,
        "-B",
        this.#buildPath,
        "-DCMAKE_BUILD_TYPE=Debug",
        this.usesNinja() ? "-G Ninja" : "",
      );
    } else {
      args.push(
        "-S",
        this.#sourcePath,
        "-B",
        this.#buildPath,
        "-DCMAKE_BUILD_TYPE=Release",
        this.usesNinja() ? "-G Ninja" : "",
      );
    }
    args.push(this.compilerSetting(compiler));
    args.push(...cmakeArguments.map((arg) => `-D${arg}`));
    return new Promise((resolve, reject) => {
      let process = this.#spawn(args);
      if (this.#logger != null) {
        process.stdout.on("data", (data) => {
          this.log(data.toString().trim());
        });

        process.stderr.on("data", (data) => {
          this.log(data.toString().trim());
        });
      }

      process.on("exit", (code) => {
        if (code == 0) {
          resolve(true);
        } else {
          reject(`CMake configure failed`);
        }
      });
      process.on("error", (err) => {
        consoleErr(`Failed to configure: ${err}`);
        reject(err);
      });
    });
  }

  build(cancellation) {
    return new Promise((resolve, reject) => {
      let p = this.#spawn(["--build", this.#buildPath, "-j"]);
      cancellation.on("cancel", () => {
        if (p.pid == null || p.pid == undefined) {
          throw new Error(`Could not determine process group`);
        }
        process.kill(-p.pid, 9);
      });
      let last = 0;
      p.stdout.on("data", (data) => {
        const str = data.toString();
        const inc = cmakeProgress(str, last);
        last += inc;
        if (this.#logger) {
          this.#logger.appendLine(str.trim());
        }
        this.#progress.emit("progress", inc);
      });
      p.on("error", (err) => {
        reject(err);
      });
      if (this.#logger) {
        p.stderr.on("data", (data) => {
          this.#logger.appendLine(data.toString().trim());
        });
      }
      p.on("exit", (code) => {
        if (p.signalCode == "SIGKILL" || p.signalCode == "SIGTERM") {
          resolve(false);
        } else if (code == 0) {
          if (this.#logger) {
            this.#logger.appendLine(`Build completed successfully.`);
          }
          resolve(true);
        } else {
          reject();
        }
      });
    });
  }
}

class GdbMake extends BuildTool {
  #progress;
  #makePath;
  #sourcePath;
  #buildPath;
  #logger;

  constructor(sourcePath, buildPath, logger) {
    super(sourcePath, buildPath, logger);
    this.#progress = new EventEmitter();
    this.#sourcePath = sourcePath;
    this.#buildPath = buildPath;
    this.#logger = logger;
  }

  #spawn(args) {
    return getAPI().getMake().spawn(args, { stdio: "pipe", env: sanitizeEnvVariables(), shell: true, detached: true });
  }

  /**
   * @param {boolean} debug
   * @param {string[]} configArguments
   */
  async configure(debug, configArguments) {
    const compiler =
      (await vs.window.showQuickPick(["clang", "gcc"], {
        title: "Pick compiler to build with or cancel to let Midas choose.",
      })) ?? "clang";

    const { CXX, C } = compiler == "clang" ? { CXX: "clang++", C: "clang" } : { CXX: "g++", C: "gcc" };
    let env = sanitizeEnvVariables();
    env["CXX"] = CXX;
    env["C"] = C;

    const { CXXFLAGS, CFLAGS } = debug
      ? { CXXFLAGS: "-g3 -O0", CFLAGS: "-g3 -O0" }
      : { CXXFLAGS: "-O3", CFLAGS: "-O3" };
    let args = [...configArguments];

    args.push(`CXXFLAGS='${CXXFLAGS}'`);
    args.push(`CFLAGS='${CFLAGS}'`);
    // compiling with -O3 will fail, due to -Werror not passing in bfd code. Disable Werror
    args.push(`--disable-werror`);

    if (fs.existsSync(this.#buildPath)) {
      fs.rmSync(this.#buildPath, { recursive: true });
    }
    fs.mkdirSync(this.#buildPath);

    return new Promise((resolve, reject) => {
      const configureScript = `${this.#sourcePath}/configure`;
      const process = spawn(configureScript, args, {
        stdio: "pipe",
        env: env,
        shell: true,
        detached: true,
        cwd: this.#buildPath,
      });
      if (this.#logger != null) {
        process.stdout.on("data", (data) => {
          this.log(data.toString().trim());
        });

        process.stderr.on("data", (data) => {
          this.log(data.toString().trim());
        });
      }

      process.on("exit", (code) => {
        if (code == 0) {
          resolve(true);
        } else {
          reject(`GDB Configure failed`);
        }
      });
      process.on("error", (err) => {
        consoleErr(`Failed to configure: ${err}`);
        reject(err);
      });
    });
  }

  build(cancellation) {
    return new Promise((resolve, reject) => {
      let p = this.#spawn(["-C", this.#buildPath, "all-gdb", "-j"]);
      cancellation.on("cancel", () => {
        if (p.pid == null || p.pid == undefined) {
          throw new Error(`Could not determine process group`);
        }
        process.kill(-p.pid, 9);
      });

      p.stdout.on("data", (data) => {
        if (this.#logger) {
          const str = data.toString();
          this.#logger.appendLine(str.trim());
        }
      });
      p.on("error", (err) => {
        reject(err);
      });
      if (this.#logger) {
        p.stderr.on("data", (data) => {
          this.#logger.appendLine(data.toString().trim());
        });
      }
      p.on("exit", (code) => {
        if (p.signalCode == "SIGKILL" || p.signalCode == "SIGTERM") {
          resolve(false);
        } else if (code == 0) {
          if (this.#logger) {
            this.#logger.appendLine(`Build completed successfully.`);
          }
          resolve(true);
        } else {
          reject();
        }
      });
    });
  }
}

class GitMetadata {
  /** @type { string } */
  #sha = null;

  /** @type { Date } */
  #date = null;

  constructor(sha, date) {
    this.#sha = sha;
    this.#date = date;
  }

  get sha() {
    return this.#sha;
  }

  get date() {
    return this.#date;
  }
}

class ManagedToolConfig {
  /** @typedef {{binaryPath: string, args: string[]}} SpawnArgs */
  /** @type {SpawnArgs} */
  spawnArgs;

  /** @type { string } */
  unzipFolder;

  ToolConstructor;

  #preConfigureFn;

  /** @type { string[] } */
  #configureArgs;

  /**
   * @param { SpawnArgs } spawnArgs - Configuration that details how to spawn the built binary
   * @param {(string) => void} preConfigFn - a closure that takes the sourceRoot directory and performs some pre-cmake configuration,
   *  like for instance, pulling in dependencies or running some project-script etc.
   * @param {function(new: BuildTool, ...*)} buildTool - The constructor for the build tool; i.e CMake or GdbMake etc
   */
  constructor(spawnArgs, unzipFolder, buildTool, configureArgs = null, preConfigFn = null) {
    this.spawnArgs = spawnArgs;
    this.unzipFolder = unzipFolder;
    this.ToolConstructor = buildTool;
    this.#preConfigureFn = preConfigFn;
    this.#configureArgs = configureArgs ?? [];
  }

  get preConfigureFn() {
    return this.#preConfigureFn;
  }

  /**
   * Additional arguments that this tool requires when configuring the build (pre-build).
   * Can be arguments passed to CMake, or in the case of gdb, configure
   */
  get configureArgs() {
    return this.#configureArgs;
  }

  /**
   * @param {string} sourceDirectory
   * @param {string} buildDirectory
   * @param {any} logger
   * @returns { BuildTool }
   */
  buildTool(sourceDirectory, buildDirectory, logger) {
    return new this.ToolConstructor(sourceDirectory, buildDirectory, logger);
  }
}

class ManagedTool {
  /** @type {string} */
  #root_dir;
  /** @type {string} */
  #path;
  /** @type {string} */
  #version;
  /** @type {boolean} */
  #managed;
  /** @type {GitMetadata} */
  #git;
  #name;
  #isDebugBuild;
  #globalStorage;
  #logger;
  #gitUrls;
  /** @type {import("vscode").ExtensionContext} */
  #context;
  /** @type {ToolDependencies} */
  #systemDependencies;

  /** @type { ManagedToolConfig } */
  buildConfig;

  /** @param { ManagedToolConfig } buildConfig */
  constructor(context, logger, name, gitUrls, config, buildDebug, buildConfig, deps) {
    this.#globalStorage = context.globalStorageUri.fsPath;
    this.#logger = logger;
    this.#name = name;
    this.#gitUrls = gitUrls;
    this.#context = context;
    this.loadConfig(config);
    this.#isDebugBuild = buildDebug;
    this.#systemDependencies = new ToolDependencies(name, deps[name]);
    this.buildConfig = buildConfig;
  }

  get dependencies() {
    return this.#systemDependencies;
  }

  loadConfig(config) {
    this.#root_dir = config.root_dir;
    this.#path = config.path;
    this.#version = config.version;
    this.#managed = config.managed;
    this.#git = new GitMetadata(config.git.sha, config.git.date);
  }

  serialize() {
    return {
      root_dir: this.#root_dir,
      path: this.#path,
      version: this.#version,
      managed: this.#managed,
      git: { sha: this.#git.sha, date: this.#git.date },
    };
  }

  getExportPath() {
    return path.dirname(this.#path);
  }

  get name() {
    return this.#name;
  }

  // Produces the root (source) dir of this tool and if it's not yet managed by midas
  // it produces the would-be source root. Do *not* use this during serialization.
  get sourceDirectory() {
    if (this.#root_dir) {
      return this.#root_dir;
    } else {
      return path.join(this.#globalStorage, this.name);
    }
  }

  get buildDirectory() {
    const buildDir = path.join(this.sourceDirectory, this.#isDebugBuild ? "build-debug" : "build");
    return buildDir;
  }

  // Produces the path to the binary of this tool and if it's not yet managed by midas
  // it produces the would-be binary path. Do *not* use this during serialization.
  get path() {
    if (this.#path) {
      return this.#path;
    } else {
      const isRelease = !(this.#isDebugBuild && false);
      if (isRelease) {
        return this.#path ?? path.join(this.#globalStorage, this.name, "build", this.buildConfig.spawnArgs.binaryPath);
      } else {
        return (
          this.#path ?? path.join(this.#globalStorage, this.name, "build-debug", this.buildConfig.spawnArgs.binaryPath)
        );
      }
    }
  }

  get spawnArgs() {
    return this.buildConfig?.spawnArgs?.args ?? [];
  }

  get version() {
    return this.#version;
  }

  get managed() {
    return this.#managed ?? false;
  }

  /** @returns { Promise<GitMetadata> } */
  async queryGit() {
    const options = {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Midas-Debug-Adapter",
      },
    };
    return new Promise((resolve, rej) => {
      const request = require("https").get(this.#gitUrls.query, options, (res) => {
        const buf = [];
        res.on("data", (data) => {
          buf.push(data);
        });
        res.on("close", () => {
          const processed = buf.flatMap((chunk) => chunk.toString()).join("");
          const json = JSON.parse(processed);
          const sha = json.sha;
          const { date } = json.commit.author;
          resolve(new GitMetadata(sha, date));
        });
      });

      request.on("error", (err) => {
        consoleErr(`Error: ${err}`);
        rej(`Error ${err}`);
      });
    });
  }

  log(msg) {
    if (this.#logger) {
      this.#logger.appendLine(msg);
    }
  }

  async unzipTodir(file, toPath) {
    if (!fs.existsSync(toPath)) {
      this.log(`creating dir ${toPath}`);
      fs.mkdirSync(toPath);
    }
    await getAPI().getRequiredSystemTool("unzip").execute([file, "-d", toPath], this.#logger);
  }

  removeFile(path) {
    try {
      fs.unlinkSync(path);
    } catch (ex) {
      consoleErr(`failed to remove file ${path}: ${ex}`);
    }
  }

  async #downloadSource() {
    if (fs.existsSync(this.sourceDirectory)) {
      fs.rmSync(this.sourceDirectory, { recursive: true });
    }

    if (this.#gitUrls.download) {
      const { path: zipFile, status } = await downloadFileHttp(
        this.#gitUrls.download,
        path.join(this.#globalStorage, `${this.name}.zip`),
      );
      if (status == "success") {
        try {
          await this.unzipTodir(zipFile, this.#globalStorage);
          const folder = path.join(this.#globalStorage, this.buildConfig.unzipFolder);
          execSync(`mv ${folder} ${this.sourceDirectory}`);
          this.log(`renamed dir ${folder} to ${this.sourceDirectory}`);
        } catch (ex) {
          consoleErr(`unzip failed: ${ex}`);
          this.removeFile(this.sourceDirectory);
          this.removeFile(zipFile);
          throw new Error(`Failed to unzip: ${ex}`);
        }
      }
    } else {
      throw new Error(`Managing tool using git clone not yet implemented`);
    }
  }

  async preConfigure(sourceRoot) {
    const fn = this.buildConfig.preConfigureFn;
    if (fn) {
      await fn(sourceRoot);
    }
  }

  async beginInstallerUI() {
    try {
      await vs.window.withProgress(
        {
          location: vs.ProgressLocation.Notification,
          cancellable: true,
          title: `Installing ${this.name}`,
        },
        async (progress, token) => {
          let emitter = new EventEmitter();
          token.onCancellationRequested(() => {
            emitter.emit("cancel");
          });

          await this.install((report) => {
            progress.report(report);
          }, emitter).then((success) => {
            if (success) {
              getAPI().getToolchain().serialize();
            }
          });
        },
      );
    } catch (ex) {
      vs.window.showErrorMessage(`Failed to configure & install ${this.name.toUpperCase()}: ${ex}`);
    }
  }

  async install(progressCallback, cancellation) {
    if (this.#logger) {
      this.#logger.show();
    }
    const { sha, date } = await this.queryGit();
    await this.#downloadSource();
    const buildTool = this.buildConfig.buildTool(this.sourceDirectory, this.buildDirectory, this.#logger);
    await this.preConfigure(this.sourceDirectory);
    const configured = await buildTool.configure(this.#isDebugBuild, this.buildConfig.configureArgs);
    if (configured) {
      buildTool.onProgress(progressCallback);
      const finished = await buildTool.build(cancellation);
      if (finished) {
        this.loadConfig({
          root_dir: this.sourceDirectory,
          path: path.join(this.buildDirectory, this.buildConfig.spawnArgs.binaryPath),
          version: "",
          managed: true,
          git: new GitMetadata(sha, date),
        });
      }
      return finished;
    } else {
      throw new Error(`Failed to configure ${this.name}`);
    }
  }

  async checkUserConfiguredUpdateFrequency() {
    // todo: implement some frequency setting here
    return true;
  }

  async update() {
    // This functionality has kept popping up with bugs, that we now log as much as possible
    // to save ourselves from the headaches we create ourselves here.
    if (!this.managed) {
      consoleLog(`tool ${this.#name} not managed, will not update.`);
      return false;
    }
    const configDate = new Date(this.#git.date ?? null);
    const { date } = await this.queryGit();
    const gitDate = new Date(date);

    if (!(configDate < gitDate && (await this.checkUserConfiguredUpdateFrequency()))) {
      return false;
    }
    let choice =
      (await vs.window.showInformationMessage(`${this.name} have updates. Update now?`, "yes", "no")) ?? "no";
    if (choice == "no") {
      consoleLog(`User selected to not update tool.`);
      return false;
    }

    let backup = false;
    let cancelled = false;
    let success = false;
    const removeDirectory = (dir) => fs.rmSync(dir, { recursive: true });
    try {
      fs.renameSync(this.#root_dir, `${this.#root_dir}-old`);
      backup = true;
      success = await vs.window.withProgress(
        {
          location: vs.ProgressLocation.Notification,
          cancellable: true,
          title: "Updating...",
        },
        async (reporter, token) => {
          let emitter = new EventEmitter();
          token.onCancellationRequested(() => {
            emitter.emit("cancel");
            cancelled = true;
          });
          return await this.install((report) => {
            reporter.report(report);
          }, emitter);
        },
      );
      if (!cancelled && fs.existsSync(`${this.#root_dir}-old`)) {
        removeDirectory(`${this.#root_dir}-old`);
      }
    } catch (ex) {
      if (backup) {
        if (fs.existsSync(this.#root_dir)) {
          removeDirectory(this.#root_dir);
        }
        fs.renameSync(`${this.#root_dir}-old`, `${this.#root_dir}`);
        cancelled = false;
      }
    }

    if (cancelled && fs.existsSync(`${this.#root_dir}-old`)) {
      if (fs.existsSync(this.#root_dir)) {
        removeDirectory(this.#root_dir);
      }
      fs.renameSync(`${this.#root_dir}-old`, `${this.#root_dir}`);
      cancelled = false;
    }
    return success;
  }

  asTool() {
    return new Tool(this.name, this.path, this.buildConfig.spawnArgs.args);
  }

  /**
   * @returns {import("child_process").ChildProcessWithoutNullStreams}
   */
  spawn(args, spawnOptions) {
    if (!fs.existsSync(this.path)) {
      throw new Error(`Path ${this.path} doesn't exist`);
    }
    const spawnWithArgs = (this.buildConfig.spawnArgs.args ?? []).concat(args);
    return spawn(this.path, spawnWithArgs, spawnOptions);
  }
}

class ManagedToolchain {
  static GitUrls = {
    rr: {
      query: "https://api.github.com/repos/rr-debugger/rr/commits/master",
      clone: "https://github.com/rr-debugger/rr.git",
      download: "https://github.com/rr-debugger/rr/archive/refs/heads/master.zip",
    },
    gdb: {
      // gdb uses sourceware which has like 10% of the features of github, unfortunately. using mirror.
      query: "https://api.github.com/repos/bminor/binutils-gdb/commits/master",
      clone: "https://sourceware.org/git/binutils-gdb.git",
      download: "https://github.com/bminor/binutils-gdb/archive/refs/heads/master.zip",
    },
    mdb: {
      query: "https://api.github.com/repos/theIDinside/mdebug/commits/main",
      clone: "https://github.com/theIDinside/mdebug.git",
      download: "https://github.com/theIDinside/mdebug/archive/refs/heads/main.zip",
    },
  };

  static dependencies = null;

  /** @type { { rr: ManagedToolConfig, gdb: ManagedToolConfig, mdb: ManagedToolConfig }} */
  #toolConfigurations;

  #toolchainInstallLogger;

  /** @type { ManagedTool } */
  #rr;
  /** @type { ManagedTool } */
  #gdb;
  /** @type { ManagedTool } */
  #mdb;

  /**
   *  @typedef { { root_dir: string, path: string, version: string, managed: boolean, git: { sha: string, date: Date } } } SerializedTool
   *  @returns { { midas_version: string, toolchain: { rr: SerializedTool, gdb: SerializedTool, mdb: SerializedTool } } }
   */
  static loadConfig(extensionContext) {
    const configPath = `${extensionContext.globalStorageUri.fsPath}/.config`;
    if (!fs.existsSync(configPath)) {
      return createEmptyMidasConfig();
    }
    const data = fs.readFileSync(configPath).toString();
    const cfg = JSON.parse(data);
    return this.migrateConfiguration(cfg);
  }

  /**
   * @returns { import("./utils/utils").MidasConfig }
   */
  static migrateConfiguration(config) {
    const { toolchain } = createEmptyMidasConfig();
    for (let tool in toolchain) {
      if (!config.toolchain.hasOwnProperty(tool)) {
        config.toolchain[tool] = toolchain[tool];
      }
    }
    return config;
  }

  static determinePython3Path() {
    return `/usr/bin/python3`;
  }

  static spawnArgs(bin, args) {
    return { binaryPath: bin, args: args ?? [] };
  }

  static rrConfig() {
    const rrSpawnArgs = ManagedToolchain.spawnArgs("bin/rr");
    const rrcfg = new ManagedToolConfig(rrSpawnArgs, "rr-master", CMake, ["BUILD_TESTS=OFF"]);
    return rrcfg;
  }

  static gdbConfig() {
    const gdbSpawnArgs = ManagedToolchain.spawnArgs("gdb/gdb", [
      `--data-directory=${getAPI().getStoragePathOf("binutils-gdb")}/build/gdb/data-directory`,
    ]);
    const gdbcfg = new ManagedToolConfig(gdbSpawnArgs, "binutils-gdb-master", GdbMake, [
      `--with-python=${ManagedToolchain.determinePython3Path()}`,
      "--with-expat",
      "--with-lzma",
    ]);
    return gdbcfg;
  }

  static mdbConfig() {
    const mdbSpawnArgs = ManagedToolchain.spawnArgs("bin/mdb");
    const mdbcfg = new ManagedToolConfig(mdbSpawnArgs, "mdebug-main", CMake, async (sourceRoot) => {
      const script = path.join(sourceRoot, "configure-dev.sh");
      const mode = 0o755; // make file contain the following rights: rwxr-xr-x  (so that we can execute the project-dev dependencies)
      fs.chmodSync(script, mode);
      execSync(script);
    });
    return mdbcfg;
  }

  constructor(extensionContext, logger) {
    const Self = ManagedToolchain;
    /** @type {import("vscode").ExtensionContext} */
    this.extensionContext = extensionContext;
    this.#toolchainInstallLogger = logger;
    const {
      toolchain: { rr, gdb, mdb },
    } = Self.loadConfig(this.extensionContext);

    const rrcfg = Self.rrConfig();
    const gdbcfg = Self.gdbConfig();
    const mdbcfg = Self.mdbConfig();

    this.#toolConfigurations = { rr: rrcfg, gdb: gdbcfg, mdb: mdbcfg };
    const ctx = this.extensionContext;

    const depsConfigFile = getExtensionPathOf("tool-dependencies.json");
    const deps = JSON.parse(fs.readFileSync(depsConfigFile).toString());

    this.#rr = new ManagedTool(ctx, logger, "rr", Self.GitUrls.rr, rr, false, rrcfg, deps);
    this.#gdb = new ManagedTool(ctx, logger, "gdb", Self.GitUrls.gdb, gdb, false, gdbcfg, deps);
    this.#mdb = new ManagedTool(ctx, logger, "mdb", Self.GitUrls.mdb, mdb, true, mdbcfg, deps);
  }

  exportEnvironment() {
    const exported = this.getToolList()
      .filter((t) => t.managed)
      .map((t) => t.getExportPath());
    this.extensionContext.environmentVariableCollection.append("PATH", `:${exported.join(":")}`);
  }

  get version() {
    return this.extensionContext.extension.packageJSON["version"];
  }

  serialize() {
    const serialized = {
      midas_version: this.version,
      toolchain: this.getToolList().reduce((tc, tool) => {
        tc[tool.name] = tool.serialize();
        return tc;
      }, {}),
    };
    fs.writeFileSync(`${this.extensionContext.globalStorageUri.fsPath}/.config`, JSON.stringify(serialized, null, 2));
    this.exportEnvironment();
  }

  async checkUpdates() {
    let changed = false;
    for await (const updated of this.getToolList().map((t) => t.update())) {
      changed = changed || updated;
    }
    return changed;
  }

  getToolList() {
    return [this.#rr, this.#gdb, this.#mdb];
  }

  /**
   * @returns { ManagedTool }
   */
  getTool(prop) {
    return this[prop];
  }

  get rr() {
    return this.#rr;
  }

  get gdb() {
    return this.#gdb;
  }
  get mdb() {
    return this.#mdb;
  }

  /**
   * @param {ManagedTool} tool
   * @returns
   */
  installDependencies(tool) {
    // TODO: Make this a cheaper call, for cases where we *know* system dependencies previously has been met.
    // will also mean user doesn't have to input sudo password every update.
    return tool.dependencies.config().then(({ name, repoType, packages }) => {
      consoleLog(`repo type: ${name}. installer service: ${repoType}. Required packages: ${packages.join(" ")}`);
      return systemInstall(repoType, packages, true, this.#toolchainInstallLogger);
    });
  }
}

module.exports = {
  ManagedToolchain,
  ManagedTool,
  downloadFileHttp,
};
