# Change Log

All notable changes to the "midas" extension will be documented in this file. Changelog begins with version 0.1.1 additions prior to this unfortunately not registered.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Create specific handlers for all VSCode requests directly in Python

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
