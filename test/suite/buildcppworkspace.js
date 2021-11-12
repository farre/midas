const { exit } = require("process");
const { buildTestFiles } = require("../../modules/utils");
const path = require("path");
const PROJECT_ROOT = path.normalize(path.join(__dirname, "..", ".."));
const TEST_PROJECT = path.join(PROJECT_ROOT, "test", "cppworkspace", "test");
const MANDELBROT_PROJECT = path.join(PROJECT_ROOT, "test", "cppworkspace", "thread");

async function build_all() {
  const cpp_compiler = process.env.CXX || "clang++";
  const c_compiler = process.env.CC || "clang";

  return await Promise.all([buildTestFiles(TEST_PROJECT, MANDELBROT_PROJECT)]);
}

build_all().then((exitCodes) => {
  for(const exitCode of exitCodes) {
    exit(exitCode);
  }
});