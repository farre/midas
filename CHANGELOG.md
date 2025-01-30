# MIDAS - Debug Adapter Extension for VSCode

## Release 0.24.0

### Features

- Added `ignoreStandardLibrary` to launch and attach configurations. It will attempt at ignoring most c++ standard library files while stepping. It's a best approximation approach. Defaults to `true`.
- Extended support for the debugger backend "midas" which henceforth will be known as "midas-native"
- Added context menu support for call stack, to resume/pause all threads
- Make use of onActive item events so that the debugger backends can know what threads the user is inspecting in the UI
- Added continueAll
- Added pauseAll
- continueAll/pauseAll is used for gdb's allStopMode, or MDB.
- Deprecated allStopMode in launch.json; use noSingleThreadControl instead. It's a better name and will
  be also what this feature eventually be called by MDB.
- ${workspaceFolder} and built-ins in launch.json, should now work for all sorts of config field values
- Added new pretty printer features.
- Support for using the canonical experimental debugger `mdb`
- Added prettier to dev dependencies. use `npm run format` to format

### Fixes

- Removed old Midas version that relied on GDB/MI and gdb-js. The exclusively supported variant is midas DAP implementation.
- Make validation of config happen after substition of variables like ${workspaceFolder} so that _any_ configuration items can use the short-hands/built ins
- Refactors and cleaning up the inherent messiness of supporting what essentially is 3 backends; midas-native (mdb, future hopefully mdb+rr), midas-gdb (gdb) and midas-rr (gdb+rr).
- Added program args as a configuration item for launched program when `use-dap` is true, which seems to have been missing
- Build RR related bugs fixed
- Pretty printer related issues fixed
- Fixes to UI to behave more consistent.
- Refactor of tool management, so that it can be extended to additional software like GDB as well (in the future) in-house debugger, caused Midas to ask every time for updates of tools even when having updated to last version. Fixed.
- Fixed hex-formatting bug for register values with the sign bit set.
- Greatly improved stability and reliability of disassembly outputs
- Fixed bug in InstructionBreakpoint requests

## Release 0.22.0

### Fixes

- Fixed bug that made `Add to watch` disappear for member objects in the `Variables` list. You can now right click things
  in the list and add sub objects to `Watch` again.

### Features

- Added `(Return Value)` variable to `Locals`, if the last command that executed was `stepOut` and it succeeded completely.
  This way you can inspect return values from a function.
- Added `LogPoint` breakpoints that logs to the debug console and continues.

## Release 0.20.4

### Fixes

- Fix the Get RR bug where it did not fire if the Midas config file gets into an invalid state, possibly by aborting a build etc.

## Release 0.20.3

### Fixes

- Added connect timeout & remote timeout to 10000 for all attach

## Release 0.19.18

### Fixes

- Make checkpoints in UI clickable to go-to source where they're set

### Features

- Added ability to name checkpoints

## Release 0.19.17

### Fixes

- Fixes ##188 where Midas couldn't be started because RR was recording.

### Features

- Added `rrOptions` to `launch.json` for `midas-rr` debug sessions, which are command line options passed to RR.

## Release 0.19.15

### Fixes

- Fixes `when`, and other RR commands "crashing" Midas.

### Features

- Added run to event
- Midas now uses the output from `rr gdbinit` directly to increase stability so that if RR changes it, we don't break.

## Release 0.19.11

### Fixes

- Pretty printer-usage bug fix

## Release 0.19.10

### Fixes

- Fixed bug where frame arguments weren't displayed properly

## Release 0.19.8

### Fixes

- Fixed a bug where typedefs weren't recognized as the base type and as such wouldn't use pretty printers

## Release 0.19.7

### Fixes

- Fixed a bug where RR did not get spawned correctly, not being able to replay fork-without-execs.

## Release 0.19.2

### Features

- Added Checkpoint UI for RR sessions. The snapshot (camera icon) sets a checkpoint. And there will be a `Checkpoint` panel in the side bar during debugging from where the user can (re)start a checkpoint.

## Release 0.19.0

### Features

- New DAP interpreter. This have introduced breaking changes to the configuration of Midas. Unless you're new, you should read [the readme](https://github.com/farre/midas). This change is a substantial overhaul and is supposed to make Midas more stable and performant.
