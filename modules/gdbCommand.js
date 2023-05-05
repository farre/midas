const { OutputEvent } = require("@vscode/debugadapter");

class Command {
  constructor(cmd) {
    this.cmd = cmd;
  }

  /** @returns {string[]} */
  build() { return []; }
}

class ExecuteCommand extends Command {
  constructor(command) {
    super(command);
  }
  build() { return ["-ex",  `${this.cmd}`]}
}

class ImmediateExecuteCommand extends Command {
  constructor(command) {
    super(command);
  }
  build() {
    return ["-iex",  `${this.cmd}`]
  }
}

class Option extends Command {
  constructor(option, value) {
    super(option);
    this.option = option;
    this.value = value;
  }

  build() {
    return [this.option, this.value]
  }
}

class CommandList {
  /**
   * @param {Command[]} commands
   */
  constructor(name = "", commands = []) {
    this.name = name;
    this.commands = commands;
  }

  addOption(option, value) {
    this.commands.push(new Option(option, value));
  }

  addImmediateCommand(cmd) {
    this.commands.push(new ImmediateExecuteCommand(cmd));
  }

  addCommand(cmd) {
    this.commands.push(new ExecuteCommand(cmd));
  }

  /**
   * @param { import("./debugSession").MidasDebugSession } session
   * @returns
   */
  build(session) {
    if(this.commands.length == 0) return [];
    const logBuffer = [];
    const parameterList = [];
    logBuffer.push((this.name == "") ? `:::::: GDB Commands ::::::` : `:::::: ${this.name} ::::::`);
    for(const cmd of this.commands) {
      const built = cmd.build();
      logBuffer.push(`${built[0]} ${built[1]}`);
      parameterList.push(...built);
    }
    logBuffer.push("\n");
    session.sendEvent(new OutputEvent(logBuffer.join("\n"), "console"));
    return parameterList;
  }
}

module.exports = {
  Option,
  Command,
  ExecuteCommand,
  ImmediateExecuteCommand,
  CommandList
}