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

module.exports = {
  buildTestFiles,
};
