"use strict";

/**
 * @typedef { import("vscode").Disposable } Disposable
 */
const vscode = require("vscode");
const { showErrorMessage } = require("vscode").window;
const { registerCommand } = require("vscode").commands;

/**
 * Helper function (sorta like unimplemented!(...) in rust, only we don't panic)
 * @param {string} commandName
 * @param { string | undefined } msg
 */
const unimplemented = (commandName, msg = "No message provided") => {
  showErrorMessage(`midas.${commandName} not yet implemented: ${msg}`);
};

/**
 * Returns VS Code commands that are to be registered
 * @returns { Disposable[] }
 */
function getVSCodeCommands() {
  let start = registerCommand("midas.start", () => unimplemented("start"));
  let stop = registerCommand("midas.stop", () => unimplemented("stop"));
  let getExecutable = registerCommand("midas.get-binary", () =>
    unimplemented("get-binary")
  );
  let startDebugging = registerCommand("midas.start-debug-session", () =>
    vscode.debug.startDebugging(undefined, {
      type: "midas",
      request: "launch",
      name: "Foo foo",
      program: "${workspaceFolder}/build/testapp",
      stopOnEntry: false,
    })
  );
  let stopDebugging = registerCommand("midas.stop-debug-session", () =>
    unimplemented("stop-debug-session")
  );
  return [start, stop, getExecutable, startDebugging, stopDebugging];
}

module.exports = {
  getVSCodeCommands,
};
