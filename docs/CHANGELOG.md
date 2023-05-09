# Change Log

All notable changes to the "midas" extension will be documented in this file. Changelog begins with version 0.1.1 additions prior to this unfortunately not registered.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.11.1]
Toolchain versioning management added
Added auto complete for debug console for gdb commands
Re-factored logging yet again

## [0.11.0]
Added remote target support. Configurable via `remoteTargetConfig` on the debug session config in launch.json

## [0.5.5] - 2022-12-12
- Added ability to install RR, or build it from source and install it locally in the extension folder. Resolving dependencies are performed by dnf or apt and requries sudo.

## [0.4.7] - 2022-07-06
- Added ability to get range of pretty printed child values for watch variables

## [0.4.0] - 2022-05-23
- Hooked up Midas to work with VSCode Disassembly view
- Added "Create issue log" command
- Added checkpoints UI for setting and returning to a checkpoint
- Added scope-locking for watch variables, *<variablename> binds a watch variable
	to the first found variable with that name in the call stack. Subscript operators
	and hex formatting works for these as well.

## [0.2.0]
- Added checkpoint UI

## [0.1.2] - 2022-04-25

- Added the repl command "cancel" - sends an interrupt to GDB in case it is doing something that takes too long.
- Added subscript to watch-variables
- Added USAGE.md where functionality that not necessarily is all that intuitive is described.
- Added hex formatting of WATCH variables. Formatting a watch expression is done by adding ",x" at the end.
- Changed README to reflect new changes.
- Added "externalConsole" as a configuration option. Currently working, although not in most preferrable way.
- Added "externalConsole" config for rr debug sessions
- Added TerminalInterface to wrap behavior of externally spawned consoles and VSCode's internal console
- Added utility functions to rrutils.js, utils.js and netutils.js
- Added different debugger types, for normal/replay (gdb / gdb+rr) in config file
- Add watch variable functionality
- Added ability to set watchpoints from UI
- Added invalidate execution context command
- Added VSCode requests to python: stackTraceRequest, variablesRequest, scopesRequest
- Execute gdb commands from debug console
- Build state when inside frame, to speed up stepping and continue commands
- Initial release
