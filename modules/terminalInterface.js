const { execSync } = require("child_process");
// Make our externally spawned consoles interchangeable with VSCode terminals
class TerminalInterface {
  #process;
  #tty;
  #pid;
  #ppid;
  /**
   * @param { import("child_process").ChildProcessWithoutNullStreams } process
   * @param {{ path: string, config: string }} tty
   * @param { number } pid
   */
  constructor(process, tty = null, pid = null, ppid) {
    this.#process = process;
    this.#tty = tty;
    this.#pid = pid;
    this.#ppid = ppid;
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
        console.log(`Process ${this.#ppid} is already dead`);
      }
    }
    this.#process.kill("SIGTERM");
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
