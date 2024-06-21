const fs = require("fs");
const vs = require("vscode");
const { EventEmitter } = require("events");
const { spawn, execSync } = require("child_process");
const { sanitizeEnvVariables, which } = require("./utils/sysutils");
const path = require("path");
const { getAPI, kill_pid, Tool } = require("./utils/utils");

const DefaultConfigTemplate = {
  midas_version: "",
  toolchain: {
    rr: { root_dir: "", path: "", version: "", managed: false, git: { sha: null, date: null } },
    gdb: { root_dir: "", path: "", version: "", managed: false, git: { sha: null, date: null } },
    mdb: { root_dir: "", path: "", version: "", managed: false, git: { sha: null, date: null } },
  },
};

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

/**
 * Downloads a file from `url` and saves it as `file_name` in the extension folder.
 * @param {string} url - The url of the file to download
 * @param {string} path - Path to write the file to.
 * @param { EventEmitter } emitter - Progress & cancellation emitter
 * @returns {Promise<{path: string, status: "success" | "cancelled" }>} `path` of saved file and `status` indicates if it
 */
async function downloadFile(url, path, emitter) {
  const removeFile = (file) => fs.rmSync(file, {recursive:false});
  if (fs.existsSync(path)) {
    removeFile(path);
  }
  return new Promise((resolve, reject) => {
    const output_stream = fs.createWriteStream(path, { flags: "wx" });
    const cleanup = (err, exception) => {
      console.log(`Exception: ${err}`);
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
          `Download error. Server responded with: ${response.statusCode} - ${response.statusMessage}`
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
    }
  );
}

class CMake {
  #progress;
  #cmakePath;
  #usesNinja;
  #sourcePath;
  #buildPath;
  #logger;

  constructor(cmakePath, sourcePath, buildPath, logger, hasNinja) {
    this.#cmakePath = cmakePath;
    this.#progress = new EventEmitter();
    this.#usesNinja = hasNinja ?? false;
    this.#sourcePath = sourcePath;
    this.#buildPath = buildPath;
    this.#logger = logger;
  }

  log(msg) {
    if (this.#logger) {
      this.#logger.appendLine(msg);
    }
  }

  onProgress(cb) {
    this.#progress.on("progress", cb);
  }

  #spawn(signal, args) {
    return getAPI()
      .getRequiredSystemTool("cmake")
      .spawn(args, { stdio: "pipe", env: sanitizeEnvVariables(), signal: signal, shell: true, detached: true });
  }

  /**
   * @param {string | "clang" | "gcc"} choice
   */
  compilerSetting(choice) {
    switch (choice) {
      case "clang":
        return `-DCMAKE_CXX_COMPILER=clang++ -DCMAKE_C_COMPILER=clang`
      case "gcc":
        return `-DCMAKE_CXX_COMPILER=g++ -DCMAKE_C_COMPILER=gcc`
      default:
        throw new Error(`Unsupported compiler ${choice}`);
    }
  }

  async configure(debug) {
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
        this.#usesNinja ? "-G Ninja" : ""
      );
    } else {
      args.push(
        "-S",
        this.#sourcePath,
        "-B",
        this.#buildPath,
        "-DCMAKE_BUILD_TYPE=Release",
        this.#usesNinja ? "-G Ninja" : ""
      );
    }
    args.push(this.compilerSetting(compiler));

    return new Promise((resolve, reject) => {
      let controller = new AbortController();
      let process = this.#spawn(controller.signal, args);
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
          resolve(false);
        }
      });
      process.on("error", (err) => {
        console.log(`Failed to configure: ${err}`);
        reject(err);
      });
    });
  }

  build(cancellation) {
    return new Promise((resolve, reject) => {
      let controller = new AbortController();
      const { signal } = controller;
      let p = this.#spawn(signal, ["--build", this.#buildPath, "-j"]);
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
          this.#logger.appendLind(data.toString().trim());
        });
      }
      p.on("exit", (code) => {
        if (code == 0) {
          if (this.#logger) {
            this.#logger.appendLine(`Build completed successfully.`);
          }
          resolve();
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
  /** @type {string} relative path to binary inside build folder */
  relativeBinaryPath;
  /** @type {string[]} */
  requiredSpawnArguments;
  /** @type { string } */
  unzipFolder;

  /** @type { "clang" | "gcc" } */
  #useCompiler;

  #preConfigureFn;

  /**
   * @param {string} relativeBinaryPath - The relative path from the source root to the final build dir binary.
   *  All managed tools are built in-source tree (either in build/ or build-debug/)
   * @param {string[]} defaultSpawnArguments - Default (required) spawn arguments for the managed tool.
   *  This is for instance arguments that, since we don't run them as system installed tools, require additional params.
   * @param { "clang" | "gcc" } compiler - Configure tool to be built by compiler
   * @param {(string) => void} preConfigFn - a closure that takes the sourceRoot directory and performs some pre-cmake configuration,
   *  like for instance, pulling in dependencies or running some project-script etc.
   */
  constructor(relativeBinaryPath, defaultSpawnArguments, unzipFolder, compiler, preConfigFn = null) {
    this.relativeBinaryPath = relativeBinaryPath;
    this.requiredSpawnArguments = defaultSpawnArguments;
    this.unzipFolder = unzipFolder;
    this.#useCompiler = compiler;
    this.#preConfigureFn = preConfigFn;
  }

  get preConfigureFn() {
    return this.#preConfigureFn;
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

  /** @type { ManagedToolConfig } */
  buildConfig;

  /** @param { ManagedToolConfig } buildConfig */
  constructor(context, logger, name, gitUrls, config, buildDebug, buildConfig) {
    this.#globalStorage = context.globalStorageUri.fsPath;
    this.#logger = logger;
    this.#name = name;
    this.#gitUrls = gitUrls;
    this.context = context;
    this.#root_dir = config.root_dir;
    this.#path = config.path;
    this.#version = config.version;
    this.#managed = config.managed;
    this.#git = config.git;
    this.#isDebugBuild = buildDebug;
    this.buildConfig = buildConfig;
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
        return this.#path ?? path.join(this.#globalStorage, this.name, "build", this.buildConfig.relativeBinaryPath);
      } else {
        return (
          this.#path ?? path.join(this.#globalStorage, this.name, "build-debug", this.buildConfig.relativeBinaryPath)
        );
      }
    }
  }

  get version() {
    return this.#version;
  }

  get managed() {
    return this.#managed ?? false;
  }

  or(fn) {
    if(this.#path && fs.existsSync(this.#path)) {
      return new Tool(this.name, this.#path);
    } else {
      return fn(this.name);
    }
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
        console.log(`Error: ${err}`);
        rej(`Error ${err}`);
      });
    });
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
      console.log(`failed to remove file ${path}: ${ex}`);
    }
  }

  async #downloadSource() {
    if (fs.existsSync(this.sourceDirectory)) {
      throw new Error(`Directory ${this.sourceDirectory} exists`);
    }

    if (this.#gitUrls.download) {
      const { path: zipFile, status } = await downloadFileHttp(
        this.#gitUrls.download,
        path.join(this.#globalStorage, `${this.name}.zip`)
      );
      if (status == "success") {
        try {
          await this.unzipTodir(zipFile, this.#globalStorage);
          const folder = path.join(this.#globalStorage, this.buildConfig.unzipFolder);
          execSync(`mv ${folder} ${this.sourceDirectory}`);
          this.log(`renamed dir ${folder} to ${this.sourceDirectory}`);
        } catch (ex) {
          console.log(`unzip failed: ${ex}`);
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
          await this.install((report) => {
            progress.report(report);
          }, emitter);

          token.onCancellationRequested(() => {
            emitter.emit("cancel");
          })
        })
    } catch(ex) {
      vs.window.showErrorMessage(`Failed to configure & install ${this.name.toUpperCase()}: ${ex}`);
    }
  }

  async install(progressCallback, cancellation) {
    if (this.#logger) {
      this.#logger.show();
    }
    await this.#downloadSource();
    const cmake = new CMake("cmake", this.sourceDirectory, this.buildDirectory, this.#logger, true);
    await this.preConfigure(this.sourceDirectory);
    const configured = await cmake.configure(this.#isDebugBuild);
    const { sha, date } = await this.queryGit();
    if (configured) {
      cmake.onProgress(progressCallback);
      await cmake.build(cancellation);
      this.#root_dir = this.sourceDirectory;
      this.#path = path.join(this.buildDirectory, this.buildConfig.relativeBinaryPath);
      this.#git = new GitMetadata(sha, date);
      this.#managed = true;
    } else {
      throw new Error(`Failed to configure ${this.name}`);
    }
  }

  async checkUserConfiguredUpdateFrequency() {
    // todo: implement some frequency setting here
    return true;
  }

  async update() {
    if (!this.managed) {
      return;
    }
    const configDate = new Date(this.#git.date ?? null);
    const { date } = await this.queryGit();
    const gitDate = new Date(date);

    if (!(configDate < gitDate && (await this.checkUserConfiguredUpdateFrequency()))) {
      return;
    }
    let choice =
      (await vs.window.showInformationMessage(`${this.name} have updates. Update now?`, "yes", "no")) ?? "no";
    if (choice == "no") {
      return;
    }

    let backup = false;
    let cancelled = false;
    const removeDirectory = (dir) => fs.rmSync(dir, { recursive: true });
    try {
      fs.renameSync(this.#root_dir, `${this.#root_dir}-old`);
      backup = true;
      await vs.window.withProgress(
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
          await this.install((report) => {
            reporter.report(report);
          }, emitter);
        }
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
  }

  spawn(argsArray) {
    if (!fs.existsSync(this.path)) {
      throw new Error(`Path ${this.path} doesn't exist`);
    }
    return spawn(this.path, [...this.buildConfig.requiredSpawnArguments, ...argsArray]);
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
      query: "",
      clone: "https://sourceware.org/git/binutils-gdb.git",
      download: "",
    },
    mdb: {
      query: "https://api.github.com/repos/theIDinside/mdebug/commits/main",
      clone: "https://github.com/theIDinside/mdebug.git",
      download: "https://github.com/theIDinside/mdebug/archive/refs/heads/main.zip",
    },
  };

  /** @type { ManagedTool } */
  #rr;
  /** @type { ManagedTool } */
  #gdb;
  /** @type { ManagedTool } */
  #mdb;

  /** @type { Map<String, import("./utils/utils").Tool> } */
  #installedSystemTools = new Map();

  /**
   *  @typedef { { root_dir: string, path: string, version: string, managed: boolean, git: { sha: string, date: Date } } } SerializedTool
   *  @returns { { midas_version: string, toolchain: { rr: SerializedTool, gdb: SerializedTool, mdb: SerializedTool } } }
   */
  static loadConfig(extensionContext) {
    const cfg_path = `${extensionContext.globalStorageUri.fsPath}/.config`;
    if (!fs.existsSync(cfg_path)) {
      let default_cfg = structuredClone(DefaultConfigTemplate);
      default_cfg.midas_version = extensionContext.extension.packageJSON["version"];
      fs.writeFileSync(cfg_path, JSON.stringify(default_cfg));
      return default_cfg;
    } else {
      const data = fs.readFileSync(cfg_path).toString();
      let cfg = JSON.parse(data);
      if (!cfg.toolchain.mdb) {
        cfg.toolchain.mdb = DefaultConfigTemplate.toolchain.mdb;
      }
      return cfg;
    }
  }

  constructor(extensionContext, logger) {
    this.extensionContext = extensionContext;
    const {
      midas_version,
      toolchain: { rr, gdb, mdb },
    } = ManagedToolchain.loadConfig(this.extensionContext);
    this.version = midas_version;
    const rrcfg = new ManagedToolConfig("bin/rr", [], "rr-master", "gcc");
    const gdbcfg = new ManagedToolConfig("gdb/gdb", ["--data-directory={}"], "any", "gcc");
    const mdbcfg = new ManagedToolConfig("bin/mdb", [], "mdebug-main", "clang", async (sourceRoot) => {
      const script = path.join(sourceRoot, "configure-dev.sh");
      const mode = 0o755; // make file contain the following rights: rwxr-xr-x  (so that we can execute the project-dev dependencies)
      fs.chmodSync(script, mode);
      execSync(script);
    });
    const ctx = this.extensionContext;
    this.#rr = new ManagedTool(ctx, logger, "rr", ManagedToolchain.GitUrls.rr, rr, false, rrcfg);
    this.#mdb = new ManagedTool(ctx, logger, "mdb", ManagedToolchain.GitUrls.mdb, mdb, true, mdbcfg);
    this.#gdb = new ManagedTool(ctx, logger, "gdb", ManagedToolchain.GitUrls.gdb, gdb, false, gdbcfg);
  }

  serialize() {
    const serialized = {
      midas_version: this.version,
      toolchain: {
        rr: this.#rr.serialize(),
        gdb: this.#gdb.serialize(),
        mdb: this.#mdb.serialize(),
      },
    };
    fs.writeFileSync(`${this.extensionContext.globalStorageUri.fsPath}/.config`, JSON.stringify(serialized));
  }

  checkUpdates() {
    this.#rr.update();
    this.#mdb.update();
    this.#gdb.update();
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
}

module.exports = {
  ManagedToolchain,
  downloadFileHttp,
};
