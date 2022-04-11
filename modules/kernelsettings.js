const fs = require("fs");

// *nix utility functions for reading system/kernel variables

function readPtraceScope() {
  let data = fs.readFileSync("/proc/sys/kernel/yama/ptrace_scope");
  const setting = data.toString().trim();
  const n = Number.parseInt(setting);
  if (Number.isNaN(n)) {
    throw new Error("Failed to read Yama security module setting");
  }
  return n;
}

function readPerfEventParanoid() {
  let data = fs.readFileSync("/proc/sys/kernel/perf_event_paranoid");
  const setting = data.toString().trim();
  const n = Number.parseInt(setting);
  if (Number.isNaN(n)) {
    throw new Error("Failed to read Perf Event Paranoid setting");
  }
  return n;
}

module.exports = {
  readPtraceScope,
  readPerfEventParanoid,
};
