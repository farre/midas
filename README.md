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


## Launch configuration

We distinguish between a "normal" debug session and a "replayable debug session" by setting up the following configurations
in `launch.json` config:

### Normal debug session:
```json
{
    "type": "midas",
    "request": "launch",
    "name": "Launch Debug",
    "program": "/path/to/binary",
    "cwd": "${workspaceFolder}",
    "stopOnEntry": true,
    "trace": "Off",
    "allStopMode": true,
    "mode": "gdb"
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

## Setup commands
Another field that can be added is the `setupCommands` which takes an array of strings that are GDB commands to be executed before
loading the binary or file containing symbols (the `-iex "someCommand here"`). Below is an example of such

```json
{
    "type": "midas",
    "request": "launch",
    "name": "Launch Debug",
    "program": "${workspaceFolder}/path/binary",
    "cwd": "${workspaceFolder}",
    "stopOnEntry": true,
    "trace": "Off",
    "allStopMode": true,
    "mode": "gdb",
    "setupCommands": ["set print object on"]
}
```

## Replayable debug session (rr)

```json
{
    "type": "midas",
    "request": "launch",
    "name": "Launch replay debug session",
    "program": "${workspaceFolder}/path/binary",
    "cwd": "${workspaceFolder}",
    "stopOnEntry": true,
    "trace": "Off",
    "gdbPath": "gdb",
    "mode": "rr",
    "serverAddress": "localhost:50505",
    "replay": {
        "rrPath": "rr"
    }
}
```

Required fields are the same as a normal debug session, along with:
- The `replay` JSON object setting which takes an rrPath property, that behaves just like the gdbPath setting.

rrServerAddress defines the host and port that rr will be told to listen on, which we connect to with GDB. If this field is not set
Midas will use `127.0.0.1:RandomFreePort`.

One thing to remember is that when debugging a replayable session, all stop mode can not be set to be true. So you can elide this option, as it will be set to true, regardless.

However, you shouldn't have to fill out a placeholder for yourself, VSCode should be able to provide auto-completion like it normally does (default trigger usually is `ctrl` + `space`), shown below.

![Default Launch config](docs/launchconfig.gif)

## Usage
You can use GDB/rr from the debug console in VSCode as normal. No prefix commands with -exec etc, just type whatever commands you want. Notice however, that some commands might alter GDB state which might *not* be seen by Midas, so if you ever come across a command that breaks Midas or make Midas behave strange, please be so kind and report it so that edge cases can be handled.

## Development

To package extension, run the alias
`yarn package` or `vsce package --yarn` (vsce needs to be installed; `npm install -g vsce`)

## Changelog
Can be [found here](docs/CHANGELOG.md)

## Known bugs
Can be [found here](docs/BUGS.MD)