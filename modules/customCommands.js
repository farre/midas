const glob = require("glob");
const path = require("path");
const fs = require("fs");

async function initialize(gdb) {
  const commandPath = path.resolve(__dirname, "../commands");
  let scripts = [];
  glob(
    "*-command.py",
    { cwd: path.resolve(__dirname, "../commands") },
    (err, files) => {
      if (err) {
        throw err;
      }

      // Add files to the test suite
      files.forEach((file) => {
        let script = fs.readFileSync(path.join(commandPath, file));
        scripts.push(gdb.execPy(script));
      });
    }
  );

  await Promise.all(scripts);
}

module.exports = {
  initialize,
};
