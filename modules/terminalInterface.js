// Make our externally spawned consoles interchangeable with VSCode terminals
class TerminalInterface {
  #process;
  #tty;
  #pid;
  /**
     * @param { import("child_process").ChildProcessWithoutNullStreams } process 
     * @param {{ path: string, config: string }} tty 
     * @param { number } pid 
     */
  constructor(process, tty = null, pid = null) {
    this.#process = process;
    this.#tty = tty;
    this.#pid = pid;
  }

  get pid() {
    return this.#pid;
  }

  // Kills terminal
  dispose() {
    this.#process.kill();
  }

  registerExitAction(action) {
    this.#process.on("exit", action);
  }

  get tty() {
    return this.#tty;
  }
}

module.exports = {
  TerminalInterface
}