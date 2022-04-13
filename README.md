![Midas](docs/index_large.png)

Midas is a debug adapter that utilizes the GDB/MI interface while also integrating into the experience an ease of use of [rr](https://rr-project.org/). It also aims to be as fast as GDB/rr allows for non-trivial applications and as such uses GDB's great Python integration to be faster than some debug adapters, where possible.

## Requirements

Midas is developed exclusively for GDB with Python integration in mind. If you are running a GDB which does not support it, or hasn't been built with Python functionality, Midas will not work, at all.

And as it's developed with rr in mind, Linux is also a requirement.

To check whether or not GDB has been built with Python, from a terminal write

```bash
gdb --config
```

This will give you a list of GDB features built in. In this list, something like this should be shown:

    --with-python=/usr (relocatable)
    --with-python-libdir=/usr/lib (relocatable)

Midas has been tested with the following GDB versions

- GDB 9.2, GDB 11.1 and [GDB built from source](https://www.sourceware.org/gdb/current/)
- rr 5.5.0: seeing as how this uses the GDB remote serial protocol, earlier versions should probably be fine

## Launch configuration

We distinguish between a "normal" debug session and a "replayable debug session" by setting up the following configurations
in `launch.json` config:

### Normal debug session:

```json
{
  "type": "midas-gdb",
  "request": "launch",
  "name": "Launch Debug",
  "program": "/path/to/binary",
  "cwd": "${workspaceFolder}",
  "stopOnEntry": true,
  "trace": "Off",
  "allStopMode": true
}
```

Required values are

- type
- request: launch
- program: path/to/binary

Default values for non-required (or non-set) properties:

- trace: "Off"
- stopOnEntry: false
- allStopMode: true
- gdbPath: gdb (meaning, if gdb doesn't exist on $PATH you will have to set this)

All stop mode, means that all stop / continue actions halt or start threads in unison.

Trace has the following settings:

- "Off", no logging
- "GDB events" - gdb events are logged to the developer console
- "Python logs" - logs performance and debug messages to performance_time.log, error.log and debug.log.
- "Full" all logging turned on.

The log files will be found where the extension is installed (typically at $HOME/.vscode/extensions/...). These are currently very bare bones though.

To "run" the inferior (debugged program) in an external console, add the `externalConsole` field. Depending
on the debug session type it takes different values. For a normal debug session it might look like:

```json
    "externalConsole": {
        "path": "x-terminal-emulator",
        "closeTerminalOnEndOfSession": true,
        "endSessionOnTerminalExit": true
    }
```

rr:

```json
    "externalConsole": {
        "path": "x-terminal-emulator",
        "closeTerminalOnEndOfSession": true,
    }
```

Since the rr debug session relies on rr running, closing the terminal where it's running externally, will
end the debug session. These fields are described in the UI when setting up a launch.json.

However, currently this is only tested on Ubuntu, thus it uses `x-terminal-emulator` alias with pretty specific parameters. If your linux distro, spawns
a shell with this command, external console should work on your Linux distro as well;

`x-terminal-emulator -e sh -c "tty > /tmp/someFileMidasDecidesAtRunTime && echo $$ >> /tmp/someFileMidasDecidesAtRunTime && sleep 100000000000000"`

## Setup commands

Another field that can be added is the `setupCommands` which takes an array of strings that are GDB commands to be executed before
loading the binary or file containing symbols (the `-iex "someCommand here"`). Below is an example of such

```json
{
  "type": "midas-gdb",
  "request": "launch",
  "name": "Launch Debug",
  "program": "${workspaceFolder}/path/binary",
  "cwd": "${workspaceFolder}",
  "stopOnEntry": true,
  "trace": "Off",
  "allStopMode": true,
  "setupCommands": ["set print object on", "set auto-load safe-path /"]
}
```

## Replayable debug session (rr)

Configuration example of a rr debug session:

```json
{
  "type": "midas-rr",
  "request": "launch",
  "name": "Launch replay debug session",
  "program": "${workspaceFolder}/path/binary",
  "cwd": "${workspaceFolder}",
  "stopOnEntry": true,
  "trace": "Off",
  "gdbPath": "gdb",
  "rrPath": "rr",
  "serverAddress": "localhost:50505"
}
```

rrServerAddress defines the host and port that rr will be told to listen on, which we connect to with GDB. If this field is not set
Midas will use `127.0.0.1:RandomFreePort`.

rrPath behaves just like the gdbPath field and defaults to trying to find `rr` in `$PATH`.

However, you shouldn't have to fill out a placeholder for yourself, VSCode should be able to provide auto-completion like it normally does (default trigger usually is `ctrl` + `space`), shown below.

![Default Launch config](docs/launchconfig.gif)

## Usage

You can use GDB/rr from the debug console in VSCode as normal. No prefix commands with -exec etc, just type whatever commands you want. Notice however, that some commands might alter GDB state which might _not_ be seen by Midas, so if you ever come across a command that breaks Midas or make Midas behave strange, please be so kind and report it so that edge cases can be handled.

Setting watchpoints; right click the variable in the variable window and pick the menu option for what watch point you want to set. The watchpoints are always set by address (location). The reasoning behind this, is that the re-evaluation of watch points when new scopes are entered will slow them down. Doing this defeats the purpose of fast hardware watchpoints.

## Development

To package extension, run the alias
`yarn package` or `vsce package --yarn` (vsce needs to be installed; `npm install -g vsce`)

## Changelog

Can be [found here](docs/CHANGELOG.md)

## Known bugs

Can be [found here](docs/BUGS.MD)
