"use strict"

// Debug Adapter Protocol follow thisFormattingStyle, change the remaining in future commits.
const CustomRequests = {
  ContinueAll: "continueAll",
  PauseAll: "pauseAll",
  ReverseFinish: "reverse-finish",
  RunToEvent: "run-to-event",
  ReloadMidasScripts: "hot-reload-scripts",
  SpawnConfig: "spawn-config",
  SetCheckpoint: "set-checkpoint",
  RestartCheckpoint: "restart-checkpoint",
  DeleteCheckpoint: "delete-checkpoint",
  ClearCheckpoints: "clear-checkpoints",
};

// Custom requests that doesn't reach the backend, whether it is gdb or mdb
// This is used for VSCode UI purposes, since there seems to be process isolation.
// Someone thought it was a better idea to have it act like a browser instead of an editor.
const CustomRequestsUI = {
  HasThread: "HasThreadId",
  OnSelectedThread: "OnSelectedThread",
  SetThreadStoppingBreakpoint: "NonProcessHaltingBreakpoint"
};

const ProvidedAdapterTypes = {
  RR: "midas-rr",
  Gdb: "midas-gdb",
  Native: "midas-native"
};

const Regexes = {
  MajorMinorPatch: /(\d+)\.(\d+)\.*((\d+))?/,
  WhiteSpace: /\s/,
  ForkedNoExec: /forked without exec/,
};

const ContextKeys = {
  NoSingleThreadControl: "midas.noSingleThreadControl",
  Running: "midas.Running",
  DebugType: "midas.debugType",
  RRSession: "midas.rrSession",
  NativeMode: "midas.native"
};

function ContextKeyName(contextKey) {
  if(!contextKey.includes(".")) {
    throw new Error(`Object is not a context key!`);
  }
  const [, key] = contextKey.split('.');
  return key;
}

const DebugLogging = {
  Off: "off",
  GdbEventsOnly: "gdb events",
  PythonLogsOnly: "python logs",
  Full: "full",
};

module.exports = {
  CustomRequests,
  ProvidedAdapterTypes,
  Regexes,
  ContextKeys,
  DebugLogging,
  CustomRequestsUI,
  ContextKeyName
}