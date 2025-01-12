"use strict";

const { Thread, ThreadGroup } = require("gdb-js");
const { trace } = require("./gdb");

const WatchPointType = {
  ACCESS: "access",
  READ: "read",
  WRITE: "write",
};

function printOption(opt, value = null) {
  switch (opt) {
    case PrintOptionType.ShowStaticMembers:
      return { name: opt, description: "Show static members" };
    case PrintOptionType.HideStaticMembers:
      return { name: opt, description: "Hide static members" };
    case PrintOptionType.MaxDepth:
      return { name: opt, description: "Set max depth", value };
    case PrintOptionType.SetDepthMinimum:
      return { name: PrintOptionType.MaxDepth, description: "Set max depth to 1", value: 1 };
    case PrintOptionType.PrintObjectOn:
      return { name: opt, description: "Set print objects on" };
    case PrintOptionType.PrintObjectOff:
      return { name: opt, description: "Set print objects off" };
    case PrintOptionType.AddressOff:
      return { name: opt, description: "Don't print address of pointers / values" };
    case PrintOptionType.AddressOn:
      return { name: opt, description: "Print address of pointers / values" };
    case PrintOptionType.CharLength:
      return { name: opt, description: "Print only N elements of an array or string", value };
    case PrintOptionType.PrettyStruct:
      return { name: opt, description: "Pretty layout of printed struct" };
  }
}

const PrintOptionType = {
  ShowStaticMembers: 0,
  HideStaticMembers: 1,
  MaxDepth: 2,
  SetDepthMinimum: 3,
  PrintObjectOn: 4,
  PrintObjectOff: 5,
  AddressOff: 6,
  AddressOn: 7,
  CharLength: 8,
  PrettyStruct: 9,
};

/**
 * @param {typeof import("gdb-js").GDB} GDBBase
 */
function GDBMixin(GDBBase) {
  return class extends GDBBase {
    #pid;
    constructor(gdb) {
      super(gdb);
      this.#pid = gdb.pid();
    }

    pid() {
      return this.#pid;
    }

    _execMI(cmd, scope) {
      let [, name, options] = /([^ ]+)( .*|)/.exec(cmd);

      if (typeof scope === "number") {
        return this._exec(`${name} --thread ${scope} ${options}`, "mi");
      } else if (scope instanceof Thread) {
        return this._exec(`${name} --thread ${scope.id} ${options}`, "mi");
      } else if (scope instanceof ThreadGroup) {
        // `--thread-group` option changes thread.
        return this._preserveThread(() => this._exec(`${name} --thread-group i${scope.id} ${options}`, "mi"));
      } else {
        return this._exec(cmd, "mi");
      }
    }

    async stepIn(threadId, reverse = false) {
      if (reverse) {
        await this.execMI(`-exec-step --reverse`, threadId);
      } else {
        await this.execMI(`-exec-step`, threadId);
      }
    }

    async stepOver(threadId, reverse = false) {
      if (reverse) {
        await this.execCLI(`reverse-next`);
      } else {
        await this.execMI(`-exec-next`, threadId);
      }
    }

    async stepInstruction(threadId, reverse = false) {
      if (reverse) {
        await this.execMI(`-exec-next-instruction --reverse`, threadId);
      } else {
        await this.execMI(`-exec-next-instruction`, threadId);
      }
    }

    async finishExecution(threadId, reverse = false, frameLevel = 0) {
      await this.execMI(`-stack-select-frame ${frameLevel}`, threadId);
      if (reverse) {
        await this.execMI("-exec-finish --reverse", threadId);
      } else {
        await this.execMI(`-exec-finish`, threadId);
      }
    }

    async continueAll() {
      return this.proceed();
    }

    // todo(simon): calling this function with no threadId should in future releases fail
    //  if pause of all is desired, call pauseAll() instead
    async pauseExecution(threadId) {
      this.userRequestedInterrupt = true;
      if (this.noSingleThreadControl || !threadId) {
        return await this.execMI(`-exec-interrupt --all`);
      } else {
        return await this.execMI(`-exec-interrupt`, threadId);
      }
    }

    async pauseAll() {
      return await this.execMI(`-exec-interrupt --all`);
    }

    async setWatchPoint(location, wpType) {
      let result = await this.execCMD(`watchpoint ${wpType} ${location}`);
      return { number: result.number, message: "Watch point", verified: true };
    }

    setReadWatchPoint(location) {
      return this.setWatchPoint(location, WatchPointType.READ);
    }
    setWriteWatchPoint(location) {
      return this.setWatchPoint(location, WatchPointType.WRITE);
    }
    setAccessWatchPoint(location) {
      return this.setWatchPoint(location, WatchPointType.ACCESS);
    }

    async setPrintOptions(printOptions) {
      let cmd_list = [];
      for (const opt of printOptions) {
        switch (opt.name) {
          case PrintOptionType.ShowStaticMembers:
            cmd_list.push(`set print static-members on`);
            break;
          case PrintOptionType.HideStaticMembers:
            cmd_list.push(`set print static-members off`);
            break;
          case PrintOptionType.MaxDepth:
            cmd_list.push(`set print max-depth ${opt.value}`);
            break;
          case PrintOptionType.PrintObjectOn:
            cmd_list.push(`set print object on`);
            break;
          case PrintOptionType.PrintObjectOff:
            cmd_list.push(`set print object off`);
            break;
          case PrintOptionType.AddressOff:
            cmd_list.push("set print address off");
            break;
          case PrintOptionType.AddressOn:
            cmd_list.push("set print address on");
            break;
          case PrintOptionType.CharLength:
            cmd_list.push(`set print elements ${opt.value}`);
            break;
          case PrintOptionType.PrettyStruct:
            cmd_list.push(`set print pretty on`);
            break;
          default:
            throw new Error(`Unknown or unsupported print option: ${opt.name} [${opt.description}]`);
        }
      }
      let optIndex = 0;
      for (const cmd of cmd_list) {
        if (trace) console.log(`Setting: ${printOptions[optIndex++].description}`);
        await this.execCLI(cmd);
      }
    }
  };
}

module.exports = {
  GDBMixin,
  PrintOptions: PrintOptionType,
  printOption,
};
