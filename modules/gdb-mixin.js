"use strict";

const { Thread, ThreadGroup } = require("gdb-js");

const WatchPointType = {
  ACCESS: "-a",
  READ: "-r",
  WRITE: "",
};

/**
 * @param {typeof import("gdb-js").GDB} GDBBase
 */
function GDBMixin(GDBBase) {
  return class extends GDBBase {
    constructor(...args) {
      super(...args);
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
      if (this.allStopMode || !threadId) {
        return await this.execMI(`-exec-interrupt --all`);
      } else {
        return await this.execMI(`-exec-interrupt`, threadId);
      }
    }

    async pauseAll() {
      return await this.execMI(`-exec-interrupt --all`);
    }

    #setWatchPoint(location, wpType) {
      return this.execMI(`-break-watch ${wpType} ${location}`);
    }
    setReadWatchPoint(location) {
      return this.#setWatchPoint(location, WatchPointType.READ);
    }
    setWriteWatchPoint(location) {
      return this.#setWatchPoint(location, WatchPointType.WRITE);
    }
    setAccessWatchPoint(location) {
      return this.#setWatchPoint(location, WatchPointType.ACCESS);
    }
  };
}

module.exports = {
  GDBMixin,
};
