"use strict";

const { exec } = require("child_process");
var fs = require("fs");
var path = require("path");

async function buildTestFiles(testPath, compiler) {
  const buildPath = path.join(testPath, "build");
  if (!fs.existsSync(buildPath)) {
    fs.mkdirSync(buildPath);
  }

  await new Promise((resolve) =>
    exec("cmake .. -DCMAKE_BUILD_TYPE=Debug", {
      cwd: buildPath,
    }).once("exit", resolve)
  );

  await new Promise((resolve) =>
    exec("cmake --build .", { cwd: buildPath }).once("exit", resolve)
  );
}

function getFunctionName() {
  let name;
  try {
    throw new Error();
  } catch (e) {
    // Get the name of the calling function.
    return e.stack.split("\n")[2].match(/^.+?[\.]([^ ]+)/)[1];
  }
}

module.exports = {
  buildTestFiles,
  getFunctionName,
};
