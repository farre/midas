const { exit } = require("process");
const { buildTestFiles } = require("../../modules/utils/utils");
const path = require("path");
const PROJECT_ROOT = path.normalize(path.join(__dirname, "..", ".."));
const TEST_PROJECT = path.join(PROJECT_ROOT, "test", "cppworkspace", "test");
const MANDELBROT_PROJECT = path.join(PROJECT_ROOT, "test", "cppworkspace", "thread");

async function build_all() {
  return await Promise.all([buildTestFiles(TEST_PROJECT), buildTestFiles(MANDELBROT_PROJECT)]);
}

build_all().then((exitCodes) => {
  for (const exitCode of exitCodes) {
    if (typeof exitCode === "number") exit(exitCode);
    else throw new Error("Must return exit code");
  }
});
