const { DebugSession } = require("../../modules/debugSession");

console.error(`Starting  ${port}`);

let port = 0;
const args = process.argv.slice(2);
args.forEach(function (val) {
  const portMatch = /^--server=(\d{4,5})$/.exec(val);
  if (portMatch) {
    port = parseInt(portMatch[1], 10);
  }
});

DebugSession.run(port);
