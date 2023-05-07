![Midas](docs/index_large.png)

Midas is a debug adapter that utilizes the GDB/MI interface while also integrating into the experience an ease of use of [rr](https://rr-project.org/). It also aims to be as fast as GDB/rr allows for non-trivial applications and as such uses GDB's great Python integration to be faster than some debug adapters, where possible.

Midas defines a set of debug sessions. A "normal debug session" is launching a new session with a specified program to debug.
The "attach debug session" launches a debug session that attaches to currently running program. A "replayable debug session"
consists of launching a RR replay and debug that. All of these debug sessions also come with the additional "remote session" flavor
which consists of connecting to a remote target machine to debug there.

## Contents

- [Requirements](#requirements)
- [Toolchain management](#toolchain-management)
- [Launch configuration](#launch-configuration)
- [Normal debug session](#normal-debug-session)
- [Replayable rr debug session](#replayable-rr-debug-session)
- [Attach session](#attach-session)
- [Remote debug sessions](#remote-debug-sessions)
- [Setup commands](#setup-commands)


## Q & A

Join the matrix room [https://chat.mozilla.org/#/room/#midas:mozilla.org](https://chat.mozilla.org/#/room/#midas:mozilla.org) for questions. Office hours are every waking moment of the day ;)

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

- GDB 9.1, GDB 11.1 and [GDB built from source](https://www.sourceware.org/gdb/current/)
- rr 5.5.0: seeing as how this uses the GDB remote serial protocol, earlier versions should probably be fine

Currently Midas will only work for GDB versions above 9.1 due to the nature of the Python implementation of earlier GDB versions. There might be some work put into getting earlier versions to work. But it might not be possible depending on how far back Python support exists in GDB.

[back to top](#contents)
## Toolchain management
Midas aims to be able to support full toolchain management for debugging. At the moment, it currently only supports management of RR.

If you don't have RR installed, Midas provides 3 ways of installing it for you. You execute the midas function `Get RR` (`ctrl + shift + p` to open the panel, type: `Midas: get rr` and hit enter) at which point you can choose
to either:
- Install from repository
- Download .deb or .rpm file (Midas will figure out what package manager you are using) and install using that.
- Build from source (recommended choice by Midas developers)

This will install RR and also make it available from the VSCode terminal by simply entering `rr` as a command. If you let Midas manage the RR tool, you do not have to specify the path to RR in your `launch.json` file anymore.

Currently, all three ways require that you run a Linux system that uses either `dnf` or `apt` as package managers to resolve dependencies. The first two options installs RR system wide, while the 3rd option (Build from source) downloads the latest master from github and builds it locally and places it in the Midas extension folder. This folder is typically found in `$HOME/.config/Code/User/globalStorage/farrese-midas/...`. For this to work you must *not* be running a virtual environment like `virtualenv`. If you are, open a VSCode window in a source folder where it's not active and re-run the command from there.

N.B! You will be required to input your sudo password for all three of these to work. A message box will ask you if this is OK. Midas does not store your password nor any other information about you.

In the future, the idea is that GDB should also be managed to be able to keep up with all the new features and optimization work that is being put into GDB by the great developers who are working on
GDB. The justification for this, is that just in version 12 of GDB, debug symbol parsing was greatly optimized making life a lot better for people working on non-trivial applications of millions
of lines of code. Midas wants to be able to make the process of staying on "current" as much as possible, as an opt-in feature.

[back to top](#contents)
## Launch configuration
Midas defines different debug sessions; "normal", "attach", and "replayable" and all three also come with an additional "remote" flavor, where the actual program
is being run on a remote target.

The quickest way to configure is to open up the `launch.json` file and hit the auto-complete keybinding (defaul: `ctrl+space`) and start typing "midas" and you will find the different session settings.

[back to top](#contents)
## Normal debug session

```json
{
  "type": "midas-gdb",
  "request": "launch",
  "name": "Launch Debug",
  "program": "/path/to/binary",
  "cwd": "${workspaceFolder}",
  "rrPath": "rr", // not required if you let Midas manage the toolchain
  "gdbPath": "gdb", // if GDB is on $PATH, this field is not required
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

[back to top](#contents)
## Replayable RR debug session

A minimum required launch config for RR is really simple as Midas will query RR for it's traces in `$RR_TRACE_DIR`.

```json
{
  "type": "midas-rr",
  "request": "launch",
  "name": "Minimum rr",
  "trace": "Off",
}
```

This requires that `GDB` and `rr` can be found in `$PATH` (or that the latter was built by Midas). It is recommended that you provide `setupCommands: ["set auto-load safe-path /"]` so that GDB can load whatever pretty printers, or other functionality needed by your debugging experience. If security is a concern, replace the root path (`/`) with the path you need. [Information about GDB auto loading](https://sourceware.org/gdb/onlinedocs/gdb/Auto_002dloading-safe-path.html).

Configuration example, for a rr debug session of for example a `firefox` test:

```json
{
  "type": "midas-rr",
  "request": "launch",
  "name": "Launch replay debug session",
  "cwd": "${workspaceFolder}",
  "stopOnEntry": true,
  "trace": "Off",
  "gdbPath": "gdb",
  "rrPath": "rr",
  "setupCommands": ["set print object on", "set auto-load safe-path /"]
}
```

However, you shouldn't have to fill out a placeholder for yourself, VSCode should be able to provide auto-completion like it normally does (default trigger usually is `ctrl` + `space`), shown below.

![Default Launch config](docs/launchconfig.gif)

[back to top](#contents)
## Attach session
Attaching to a running process is basically done and setup the same way. Midas will provide a default setting:

```json
{
  "type": "midas-gdb",
  "request": "attach",
  "name": "Attach",
  "program": "${workspaceFolder}",
  "cwd": "${workspaceFolder}",
  "trace": "Off",
  "pid": "${command:getPid}",
  "gdbPath": "gdb",
  "setupCommands": [],
  "attachOnFork": false
}
```

Leave PID field as is (or remove the field entirely) and you will be asked for it at debug session launch where you can type either the PID directly or the process name and get a list of PID's to choose from (if only 1 exists, it automatically gets picked).

[back to top](#contents)

## Remote debug sessions
Midas currently supports remote debug sessions in a rudimentary fashion. In order to set up a remote debug session, you must
add the following field to your configurations in launch.json: `remoteTargetConfiguration`. The Midas maintainer(s) don't have much
experience in remote debugging; so developing a simplified work flow will not be perfect just yet but if you have any issues, please
report them here on Github and we will get to working on them as soon as possible.

Below is an example of a `normal remote debug session` launching an application by connecting to a remote GDBServer and instructing it to launch `program`

```json
{
  "type": "midas-gdb",
  "request": "launch",
  "name": "Launch application in remote",
  "program": "/path/to/app/on/remote",
  "trace": "Off",
  "setupCommands": [],
  "remoteTargetConfig": {
    "address": "192.168.1.15:12345",
    "substitute-path": {
      "local": "/prefix-path/on/your/machine",
      "remote": "/prefix-path/on/remote/machine"
    }
  }
}
```

The `address` field is self-explanatory. The `substitute-path` field, describes how to replace a path on the remote machine with
a path on your local machine. If the remote application exists in a root folder of `/home/remote/dev/` and your local source files
exists on your system under `/home/local/dev`, then set `local` to `/home/local/dev` and `remote` to `/home/remote/dev/` as this will make GDB find the source code so that you can have a full debugging experience. If your remote system and local system has identical paths to the application being debugged, then you can set both `local` and `remote` to `null`.

As usual, these fields come with auto-completion when writing them in `launch.json` with description showing if you hover the mouse over them.

For a `attach remote debug session` the configuration looks a bit different, it excludes the `program` field:
```json
// Example config of a remote target running at address 192.168.1.100 on port 12345. In this case, remote file system matches local file system
{
  "type": "midas-gdb",
  "request": "attach",
  "name": "Connect and run remote target",
  "trace": "Off",
  "gdbPath": "gdb", // not required if GDB is in $PATH
  "setupCommands": [],
  "attachOnFork": false,
  "remoteTargetConfig": {
    "address": "192.168.1.100:12345",
    "substitute-path": {
      "local": null,
      "remote": null
    }
  }
},
```

`remote replayable debug session` example configuration:

```json
// connect to RR debug session at 192.168.1.100 on port 12345
{
  "type": "midas-rr",
  "request": "launch",
  "name": "Launch replay debug session",
  "trace": "Off",
  "gdbPath": "gdb",
  "rrPath": "rr",
  "setupCommands": [
    "set sysroot /",
    "set debuginfod enabled off",
    "set auto-load safe-path /"
  ],
  "remoteTargetConfig": {
    "address": "192.168.1.100",
    // where ever GDB sees /home/user/remoteDevRootFolder as a path, it will
    // replace it with /home/user/myLocalDevFolder and look for source files there in your local machine
    "substitute-path": {
      "local": "/home/user/myLocalDevFolder",
      "remote": "/home/user/remoteDevRootFolder"
    }
  }
}
```

[back to top](#contents)
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

[back to top](#contents)
## Usage

Since VSCode is aimed to be as general as possible, some functionality might never be represented in the UI - as such it might appear unintuitive. [Describing such functionality is found here](docs/USAGE.md), like setting watch points, formatting displayed values etc. It's recommended to skim through, to get to know useful Midas features.

If Midas behaves strangely, there exists a midas command (`Create github issue log`) that aims to make reports easier to file. It creates a new virtual document with the error logs. Please use this when filing a issue. It gets the `rr` and `gdb` version from the `launch.json` configuration of the active running debug session you've provided and also tries to figure out the Linux distro you are using. To access this midas command open the control panel (default shortcut for VSCode is `ctrl+shift+P`). and type `Create github issue". Example below.
![Issue logs](docs/how_to_create_logs.gif). Either save this file and add it to the issue or paste it into the issue itself. This command needs to be executed while the debug session is active & running in order for it to work. The logs it copies from are non-persistent to not swamp your file system.

[back to top](#contents)
## Development

To package extension, run the alias
`yarn package` or `vsce package --yarn` (vsce needs to be installed; `npm install -g vsce`)

## Changelog

Can be [found here](docs/CHANGELOG.md)

## Known bugs

Can be [found here](docs/BUGS.MD)
