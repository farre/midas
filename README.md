# midas
midas is a debug adapter that aims to implement the GDB/MI interface while also integrating into the experience
an ease of use of [rr](https://rr-project.org/). 

These sections will be filled out as features get filled in.

## Launch configuration

We distinguish between a "normal" debug session and a "replayable debug session" by setting up the following configurations
in `launch.json` config:

### Normal debug session:
```json
{
    "type": "midas",
    "request": "launch",
    "name": "Launch Debug",
    "program": "${workspaceFolder}/binary",
    "stopOnEntry": true,
    "trace": false,
    "allStopMode": false,
    "debuggerPath": "gdb"
}
```

Required values are
- type
- request: launch
- program: path/to/binary

Default values for non-required properties:
- trace: false
- stopOnEntry: false
- allStopMode: true
- debuggerPath: gdb (meaning, if gdb doesn't exist on $PATH you will have to set this)

All stop mode, means that when a breakpoint is hit all threads stop, as well as when continuing, all threads start.

### Replayable debug session (rr)

```json
{
    "type": "midas",
    "request": "launch",
    "name": "Launch Debug",
    "program": "${workspaceFolder}/build/testapp",
    "stopOnEntry": true,
    "trace": true,
    "allStopMode": true,
    "rrServerAddress": "localhost:50505",
    "rrPath": "rr",
    "debuggerPath": "gdb"
},
```

Required fields are the same as normal, along with:
- rrServerAddress: host:port

One thing to remember is that when debugging a replayable session, all stop mode can not be set to be true. So if you elide this option, as it will default to true.

- rrPath - will be set to "rr", similar to how debuggerPath is set to "gdb", thus have to be on path if not set

## Development

To package extension, run the alias
`yarn package` or `vsce package --yarn`
