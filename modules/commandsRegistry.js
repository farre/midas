"use strict";

/**
 * @typedef { import("vscode").Disposable } Disposable
 */

const { showErrorMessage } = require("vscode").window;
const { registerCommand } = require("vscode").commands;

/**
 * Helper function (sorta like unimplemented!(...) in rust, only we don't panic)
 * @param {string} commandName
 * @param { string | undefined } msg
 */
const rrdbg_unimplemented = (commandName, msg = "No message provided") => {
  showErrorMessage(`rrdbg.${commandName} not yet implemented: ${msg}`);
};

/**
 * Returns VS Code commands that are to be registered
 * @returns { Disposable[] }
 */
function getVSCodeCommands() {
  let rrStart = registerCommand("rrdbg.rr-start", () =>
    rrdbg_unimplemented("rr-start")
  );
  let rrStop = registerCommand("rrdbg.rr-stop", () =>
    rrdbg_unimplemented("rr-stop")
  );
  let getExecutable = registerCommand("rrdbg.get-binary", () =>
    rrdbg_unimplemented("get-binary")
  );
  let startDebugging = registerCommand("rrdbg.start-debug-session", () =>
    rrdbg_unimplemented("start-debug-session")
  );
  let stopDebugging = registerCommand("rrdbg.start-debug-session", () =>
    rrdbg_unimplemented("stop-debug-session")
  );
  return [rrStart, rrStop, getExecutable, startDebugging, stopDebugging];
}

module.exports = {
  getVSCodeCommands,
};
