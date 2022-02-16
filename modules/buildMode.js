const vscode = require("vscode");

/**
 * Run-mode settings of Midas. Basically equivalent to "build mode" for compiled languages.
 */
class MidasRunMode {
  #contents = [];
  #utils;
  #trace = false;
  #debug = false;
  /**
   *
   * @param {*} utilities
   * @param {*} files
   * @param {*} trace
   * @param {*} debug
   * @throws - `utilities` and `files` must provide paths to all Midas backend code, or this will throw (and Midas DA will not work).
   */
  constructor(utilities, files, trace, debug) {
    if(!utilities || !files) {
      vscode.window.showErrorMessage("Midas backend code not provided. Debug Adapter will not work");
      throw new Error("Midas backend code not provided. Debug Adapter will not work");
    }
    this.#trace = trace;
    this.#debug = debug;
    if(this.#trace || this.#debug) {
      console.log(`Loading the contents of python files: ${files} and our 'midas stdlib': ${utilities}`);
    }
    const ext = vscode.extensions.getExtension("farrese.midas");
    const dir = `${ext.extensionPath}/modules/python`
    for(const file of files) {
      const fileContents = require("fs").readFileSync(`${dir}/${file}`, { encoding: 'utf8' });
      if(!fileContents || fileContents.length == 0) {
        throw new Error(`Failed to load contents of ${file}. Midas DA will not function.`);
      }
      this.#contents.push({path: file, contents: fileContents});

    }
    const fileContents = require("fs").readFileSync(`${dir}/${utilities}`, { encoding: 'utf8' });
    this.#utils = {path: utilities, contents: fileContents };
  }

  async initializeLoadedScripts(gdb) {
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
    await gdb.execPy(this.#utils.contents);

    for(const {file, contents} of this.#contents) {
      if(this.#trace || this.#debug) console.log(`Intializing contents of file ${file}`);
      await gdb.execPy(contents);
    }
  }
}

module.exports = {
  MidasRunMode
}