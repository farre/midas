import gdb
import config
import midas_utils
import json

"""
    interface Source {
        name?: string;
        path?: string;
        sourceReference?: number;
        presentationHint?: 'normal' | 'emphasize' | 'deemphasize';
        origin?: string;
        sources?: Source[];
        adapterData?: any;
        checksums?: Checksum[];
    }

    interface Breakpoint {
        id?: number;
        verified: boolean;
        message?: string;
        source?: Source;
        line?: number;
        column?: number;
        endLine?: number;
        endColumn?: number;
        instructionReference?: string;
        offset?: number;
    }

    SetBreakpointsArguments {
        source: Source;
        breakpoints?: SourceBreakpoint[];
        lines?: number[];
        sourceModified?: boolean;
    }

    interface SourceBreakpoint {
        line: number;
        column?: number;
        condition?: string;
        hitCondition?: string;
        logMessage?: string;
    }
    Example request:
    'args: { breakpoints: [{ line: 135 }, {line: 138 }, {line: 141 },{ line: 1306 } ], lines: [135,138,141,1306], source:{ name: "CanonicalBrowsingContext.cpp", path: "/home/cx/dev/opensource/mozilla-central/docshell/base/CanonicalBrowsingContext.cpp", sourceReference: 0},sourceModified: false }'

"""

class Breakpoint:
    def __init__(self, source, bp_definition):
        self.bp_definition = bp_definition
        self.line = int(bp_definition["line"])
        self.gdb_breakpoint = gdb.Breakpoint(source=source, line=int(bp_definition["line"]))
        self.gdb_breakpoint.condition = bp_definition.get("condition")

    def breakpoint_response(self):
        return { "line": self.line, "id": self.gdb_breakpoint.number, "verified": not self.gdb_breakpoint.pending, "enabled": self.gdb_breakpoint.enabled }

    def delete(self):
        self.gdb_breakpoint.delete()

class SetSourceBreakpointsRequest(gdb.Command):
    BREAKPOINTS: dict[str, list[tuple[dict, Breakpoint]]] = {}
    def __init__(self):
        super(SetSourceBreakpointsRequest, self).__init__("gdbjs-setbreakpoints", gdb.COMMAND_USER)
        self.name = "setbreakpoints"

    @config.timeInvocation
    def invoke(self, arguments, from_tty):
        arguments = arguments.replace("'", '"')
        request = json.loads(arguments)
        source_key = request["source"]["path"]
        breakpoints = request["breakpoints"]
        if SetSourceBreakpointsRequest.BREAKPOINTS.get(source_key) is None:
            SetSourceBreakpointsRequest.BREAKPOINTS[source_key] = []

        currently_set = SetSourceBreakpointsRequest.BREAKPOINTS[source_key]
        new_set = []

        for bp in currently_set:
            found = False
            for sbp in breakpoints:
                if sbp == bp.bp_definition:
                    found = True
                    break
            if not found:
                bp.delete()
            else:
                new_set.append(bp)

        for bp_definition in breakpoints:
            new = True
            for bkpt in currently_set:
                if bkpt.bp_definition == bp_definition:
                    new = False
                    break
            if new:
                new_set.append(Breakpoint(source_key, bp_definition))
        midas_utils.send_response(self.name, { "breakpoints": [bp.breakpoint_response() for bp in new_set] }, midas_utils.prepare_command_response)
        SetSourceBreakpointsRequest.BREAKPOINTS[source_key] = new_set