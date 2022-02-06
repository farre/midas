"use strict";

const { exec, spawn: _spawn } = require("child_process");
var fs = require("fs");
var path = require("path");

// we moved this here, to deal with cyclic imports which failed silently in debug *and* in installed ("release") mode
/** @typedef { import("@vscode/debugprotocol").DebugProtocol.LaunchRequestArguments | import("vscode").DebugConfiguration } ConfigurationVariant  */
/**
 * Checks if this object represents a configuration of a replay session with rr
 * @param { ConfigurationVariant } config -  object to check if it has the "replay" attribute, it can be an LaunchArguments or DebugConfiguration
 * @returns true if it is
 */
const isReplaySession = (config) => config.hasOwnProperty("replay");

async function buildTestFiles(testPath) {
  const buildPath = path.join(testPath, "build");
  if (!fs.existsSync(buildPath)) {
    fs.mkdirSync(buildPath);
  }

  await new Promise((resolve) =>
    exec("cmake .. -DCMAKE_BUILD_TYPE=Debug", {
      cwd: buildPath,
    }).once("exit", resolve)
  );

  await new Promise((resolve) => exec("cmake --build .", { cwd: buildPath }).once("exit", resolve));
}

function getFunctionName() {
  try {
    throw new Error();
  } catch (e) {
    // Get the name of the calling function.
    return e.stack.split("\n")[2].match(/^.+?[\.]([^ ]+)/)[1];
  }
}

/**
 * Custom spawn-function that intercepts stdio so that we can control
 * encoding, and also have the ability to process commands typically sent over the command line
 * stdin/stdout.
 * @param {string} gdbPath
 */
function spawn(gdbPath, args) {
  let p = _spawn(gdbPath, args);

  return {
    stdin: {
      __proto__: p.stdin,
      /**
       * @param {string} data
       */
      write(data) {
        p.stdin.write(data);
      },
    },
    stdout: p.stdout,
    stderr: p.stderr,
    kill() {
      p.kill();
    },
  };
}

function deescape_gdbjs_output(str) {
  return str.replaceAll('"', "").replaceAll("\\n", "\n");
}

function diff(a, b) {
  return Math.abs(a - b);
}

/**
 * @param {string} str
 */
async function cleanJsonString(str) {

}

const CompiledRegex = {
  WhiteSpace: /w/
};

const testString = '{m_id = 2, m_date = {day = 3, month = 11, year = 2021}, m_title = { _M_dataplus = {<std::allocator<char>> = {<No data fields>}, _M_p = 0x41df30 "Test local struct"}, _M_string_length = 17, { _M_local_buf = "\\021\\000\\000\\000\\000\\000\\000\\000\\346\\a\\000\\000\\377\\177\\000", _M_allocated_capacity = 17}}}';

/**
 * @param {string} str
 */
async function parseStringGDBJsonHybrid(str) {
  let obj = {};
  let it = str.indexOf("{") + 1;
  let start = it;
  for(; it < str.length; it++) {
    let end = str.indexOf("=", it+1);
    let identifier = str.substring(start, end);
    obj[identifier] = null;
    start
  }
}

module.exports = {
  buildTestFiles,
  getFunctionName,
  spawn,
  deescape_gdbjs_output,
  isReplaySession,
  diff,
  cleanJsonString
};
