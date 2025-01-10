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
  AllStopModeSet: "midas.allStopModeSet",
  Running: "midas.Running",
  DebugType: "midas.debugType",
  RRSession: "midas.rrSession",
  NativeMode: "midas.native"
};

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
  DebugLogging
}