const { execSync } = require("child_process");
const { consoleErr } = require("./utils/log");
// Make our externally spawned consoles interchangeable with VSCode terminals
class TerminalInterface {
  #process;
  #tty;
  #pid;
  #ppid;
  #children;
  /**
   * @param { import("child_process").ChildProcessWithoutNullStreams } process
   * @param { { path: string } } tty
   * @param { number } pid
   */
  constructor(process, tty = null, pid = null, ppid, children) {
    this.#process = process;
    this.#tty = tty;
    this.#pid = pid;
    this.#ppid = ppid;
    this.#children = children;
  }

  get pid() {
    return this.#pid;
  }

  // Kills terminal
  dispose() {
    if (this.#ppid) {
      try {
        execSync(`kill ${this.#ppid}`);
      } catch (err) {
        consoleErr(`Process ${this.#ppid} is already dead`);
      }
    }
    this.#process.kill("SIGTERM");
  }

  disposeChildren() {
    try {
      execSync(`kill ${this.#children}`);
    } catch (err) {
      consoleErr(`Process ${this.#ppid} is already dead`);
    }
  }

  registerExitAction(action) {
    this.#process.on("exit", action);
  }

  get tty() {
    return this.#tty;
  }
}

module.exports = {
  TerminalInterface,
};
