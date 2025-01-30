import gdb
import traceback
from io import StringIO
from os import path, unlink
import socket
import json
import sys
import random
import string
import threading
import re

# Decorator functions
import functools

# For read memory requests
import base64

# Import thread-safe queue to be used for message passing
from queue import Queue

# Add "this" to the path, so we can import variables_reference module
stdlibpath = path.dirname(path.realpath(__file__))
if sys.path.count(stdlibpath) == 0:
    sys.path.append(stdlibpath)

import logger as logmodule

logger = logmodule.logger

from variables_reference import (
    can_var_ref,
    variableReferences,
    exceptionInfos,
    StackFrame,
    clear_variable_references,
    create_eager_var_ref,
    frame_variables
)


def safeInt(value):
    if value is None:
        return 0
    else:
        return value


# DAP "Interpreter" State
commands = {}
seq = 1
run = True
breakpoints = {}
exceptionBreakpoints = {}
watchpoints = {}
singleThreadControl = False
responsesQueue = Queue()
eventsQueue = Queue()
currentReturnValue = {}

session = None
eventSocketPath = "/tmp/midas-events"
commandSocketPath = "/tmp/midas-commands"


def iterate_options(opts):
    if opts is not None:
        for opt in opts:
            yield opt
    return

def loadRRConfiguration(path):
    gdb.execute(f"source {path}")

# All requests use post_event; so here we _must_ use gdb.execute, so that we don't create weird out-of-order scenarios.
class Session:
    def __init__(self, initArgs):
        self.type = initArgs["adapterID"]
        self.started = False
        if self.type == "midas-rr":
            if initArgs.get("rrinit") is None:
                raise Exception("Path to RR init script not provided. This initialization needs to happen before we setup the RR session.")
            loadRRConfiguration(initArgs["rrinit"])

    def is_rr_session(self):
        return self.type == "midas-rr"

    def start_session(self, sessionArgs):
        global logger
        if self.started:
            raise Exception("Session already started")
        self.started = True
        self.sessionArgs = sessionArgs
        # These needs to be executed _first_ (otherwise what's the point?)
        # For instance, `set sysroot /` in RR sessions, make GDB look for the symbols
        # "locally", instead of having RR serve them to gdb over a serial connection.
        for opt in iterate_options(self.sessionArgs.get("setupCommands")):
            logger.log_msg(f"[cfg]: '{opt}'\n")
            gdb.execute(opt)

        if sessionArgs["type"] == "launch":
            if sessionArgs.get("program") is None:
                raise Exception("No program was provided for gdb to launch")
            gdb.execute(f"file {sessionArgs['program']}")
            programArgs = " ".join(sessionArgs["args"])
            gdb.execute(f"set args {programArgs}")
        elif sessionArgs["type"] == "attach":
            gdb.execute("set remotetimeout 10000")
            gdb.execute("set tcp connect-timeout 10000")
            gdb.execute(sessionArgs["command"])
        else:
            raise Exception(f"Unknown session type {sessionArgs['type']}")

    def start_tracee(self):
        global singleThreadControl
        noSingleThreadControl = (
            True
            if self.sessionArgs.get("noSingleThreadControl") is None
            else self.sessionArgs.get("noSingleThreadControl")
        )
        if self.sessionArgs["type"] == "launch":
            if not noSingleThreadControl:
                singleThreadControl = True
                gdb.execute("set non-stop on")
            if self.sessionArgs["stopOnEntry"]:
                gdb.execute(f"start")
            else:
                gdb.execute(f"run")

    def restart(self):
        clear_variable_references(None)
        self.interrupt()
        set_configuration()
        if self.sessionArgs["stopOnEntry"]:
            gdb.execute("start")
        else:
            gdb.execute("run")

    def interrupt(self):
        global singleThreadControl
        if singleThreadControl:
            gdb.execute("interrupt -a")
        else:
            gdb.execute("interrupt")

    def kill_tracee(self):
        self.interrupt()
        gdb.execute("kill")

    def disconnect(self, kill_tracee):
        global run
        global responsesQueue
        run = False
        if kill_tracee:
            session.kill_tracee()
        elif self.is_rr_session():
            session.kill_tracee()
        gdb.execute("disconnect")


class Args:
    """Passed to the @requests decorator. Used to verify the values passed in the `args` field of the JSON DAP request."""

    def __init__(self, required=[], optional=[]):
        self.required = set(required)
        self.supported = set(optional).union(self.required)

    def check_args(self, args):
        keys = args.keys()
        for arg in keys:
            if arg not in self.supported:
                raise Exception(
                    f"Argument {arg} not supported. Supported args: {self.supported}"
                )
        for arg in self.required:
            if arg not in keys:
                raise Exception(
                    f"Missing required argument: {arg}. Required args: {self.required}"
                )


class ArbitraryOptionalArgs(Args):
    def __init__(self, required=[], optional=[]):
        self.required = set(required)

    def check_args(self, args):
        keys = args.keys()
        for arg in self.required:
            if arg not in keys:
                raise Exception(
                    f"Missing required argument: {arg}. Required args: {self.required}"
                )


def request(name, req_args=Args()):
    """Wraps a request and verifies that the required parameters have been passed into the dictionary `args`.
    Only optional parameters need to be checked if they're None or not (using args.get(..))
    """

    def dec(fn):
        global commands

        @functools.wraps(fn)
        def wrap(args):
            global logger
            req_args.check_args(args)
            logger.log_request(name, args)
            try:
                result = fn(args)
            except Exception as e:
                logger.log_exception(name, e)
                raise e
            logger.log_response(name, result)
            return result

        commands[name] = wrap
        return wrap

    return dec


def generate_socket_path():
    return "/tmp/midas-" + "".join(
        random.choice(string.ascii_uppercase) for i in range(10)
    )


def select_thread(threadId):
    for t in gdb.selected_inferior().threads():
        if t.global_num == threadId:
            t.switch()
            return t
    raise Exception(f"Found no thread with id {threadId}")


def iterate_frames(frame, count=None, start=None):
    count_ = 10000 if count is None else count
    if start is not None:
        iterated = 0
        while frame is not None and iterated != start:
            frame = frame.older()
            iterated += 1

    while frame is not None and count_ > 0:
        yield frame
        frame = frame.older()
        count_ -= 1


@request("evaluate", Args(["expression", "context"], ["frameId", "format"]))
def evaluate(args):
    global running_to_event_or_restarting_checkpoint
    if args["context"] == "repl":
        try:
            if args["expression"][0:4] == "run ":
                running_to_event_or_restarting_checkpoint = True
            result = gdb.execute(args["expression"], from_tty=False, to_string=True)
            return {"result": result, "variablesReference": 0}
        except Exception as e:
            running_to_event_or_restarting_checkpoint = False
            return {"result": f"{e}", "variablesReference": 0}
    elif args["context"] == "watch":
        try:
            value = gdb.parse_and_eval(args["expression"])
            if can_var_ref(value):
                ref = create_eager_var_ref(args["expression"], value, args["expression"])
                res = ref.ui_data()
                res["result"] = res.pop("value")
                return res
            else:
                if args.get("format") and bool(args.get("format")["hex"]):
                    result = value.format_string(format="x")
                else:
                    result = str(value)
                return {
                    "result": result,
                    "variablesReference": 0,
                    "memoryReference": hex(int(value.address)),
                }
        except:
            return {"result": "couldn't be evaluated", "variablesReference": 0}
    raise Exception("evaluate request failed")


@request("threads", Args())
def threads_request(args):
    res = []
    for t in gdb.selected_inferior().threads():
        thr_name = "No thread name"
        if t.name is not None:
            thr_name = t.name
        if t.details is not None:
            thr_name = t.details
        res.append({"id": t.global_num, "name": f"{thr_name} (#{t.global_num})"})
    return {"threads": res}

def artificial_values(thread):
    global currentReturnValue
    rv = currentReturnValue.get(thread)
    if rv is not None:
        # artificial values will have no evaluateName.
        yield ("(Return Value)", rv.type, None, rv)


def locals_with_artificials(frame, thread):
    for (a,b,c,d) in frame_variables(frame):
        yield (a,b,c,d)

    for (a,b,c,d) in artificial_values(thread):
        yield (a,b,c,d)


@request("stackTrace", Args(["threadId"], ["levels", "startFrame"]))
def stacktrace(args):
    global currentReturnValue
    res = []
    thread = select_thread(args["threadId"])
    addReturnValue = currentReturnValue.get(thread.global_num) is not None
    for frame in iterate_frames(
        frame=gdb.newest_frame(),
        count=args.get("levels"),
        start=args.get("startFrame"),
    ):
        sf = None
        if addReturnValue:
            # override localsValueReader to also provide a 'Return value' in 'Locals' scope.
            sf = StackFrame(frame, thread, localsValueReader=lambda frame: locals_with_artificials(frame, thread.global_num))
            addReturnValue = False
            res.append(sf.contents())
        else:
            sf = StackFrame(frame, thread)
            res.append(sf.contents())
    return {"stackFrames": res}


@request("scopes", Args(["frameId"]))
def scopes(args):
    global variableReferences
    sf = variableReferences.get(args["frameId"])
    if sf is None:
        raise Exception(f"Failed to get frame with id {args['frameId']}")
    return {"scopes": sf.scopes()}


@request("variables", Args(["variablesReference"], ["start", "count", "format"]))
def variables(args):
    global variableReferences
    container = variableReferences.get(args["variablesReference"])
    if container is None:
        raise Exception(
            f"Failed to get variablesReference {args['variablesReference']}"
        )
    variables = container.contents(
        args.get("format"), args.get("start"), args.get("count")
    )
    return {"variables": variables}


@request("continue", Args(["threadId"], ["singleThread"]))
def continue_(args):
    global singleThreadControl
    thread = select_thread(args.get("threadId"))
    if singleThreadControl:
        gdb.execute("continue")
        allThreadsContinued = False
    else:
        allThreadsContinued = True
        cmd = "continue -a" if singleThreadControl else "continue"
        gdb.execute(cmd)

    return {"allThreadsContinued": allThreadsContinued}


@request("continueAll", ArbitraryOptionalArgs())
def continueAll(args):
    gdb.execute("continue -a")
    return {"allThreadsContinued": True}


# Not defined by the DAP spec
@request("run-to-event", Args(["event"]))
def runToEvent(args):
    global running_to_event_or_restarting_checkpoint
    running_to_event_or_restarting_checkpoint = True
    try:
        gdb.execute(f"run {args['event']}")
    except:
        running_to_event_or_restarting_checkpoint = False
        raise
    return {}


@request("dataBreakpointInfo", Args(["name", "variablesReference"], ["frameId"]))
def databreakpoint_info(args):
    global variableReferences
    global session
    canPersist = session.is_rr_session()
    try:
        container = variableReferences.get(args["variablesReference"])
        value = container.find_value(args["name"])
        return {
            "dataId": hex(int(value.address)),
            "description": args["name"],
            "accessTypes": ["read", "write", "readWrite"],
            "canPersist": canPersist,
        }
    except Exception as e:
        return {
            "dataId": None,
            "description": f"{e}",
            "accessTypes": ["read", "write", "readWrite"],
            "canPersist": canPersist,
        }


def watchpoint_ids(bps):
    for watchpoint_id in bps:
        yield (
            watchpoint_id["dataId"],
            watchpoint_id["accessType"],
            watchpoint_id.get("condition"),
            watchpoint_id.get("hitCondition"),
        )


def set_wp(dataId, accessType, condition, hitCondition):
    if accessType == "read":
        gdb.execute(f"rwatch -l *{dataId}")
    elif accessType == "write":
        gdb.execute(f"watch -l *{dataId}")
    else:
        gdb.execute(f"awatch -l *{dataId}")
    bp = gdb.breakpoints()[-1]
    bp.condition = condition
    return bp


@request("setDataBreakpoints", Args(["breakpoints"]))
def set_databps(args):
    global watchpoints
    previous_wp_state = watchpoints
    watchpoints = {}
    for wp_key in watchpoint_ids(args["breakpoints"]):
        (dataId, accessType, condition, hitCondition) = wp_key
        if previous_wp_state.get(wp_key) is not None:
            watchpoints[wp_key] = previous_wp_state.get(wp_key)
        else:
            wp = set_wp(dataId, accessType, condition, hitCondition)
            watchpoints[wp_key] = wp

    diff = set(previous_wp_state.keys()) - set(watchpoints.keys())
    for key in diff:
        watchpoints[key].delete()
        del watchpoints[key]

    return {"breakpoints": [bp_to_ui(x) for x in watchpoints.values()]}


# Disassemble backwards from end_pc .. (some address that's offset instructions from end_pc)
def offset_disassemble(arch, end_pc, offset, count):
    ins_at_pc = arch.disassemble(start_pc=end_pc)[0]
    start = end_pc - 8 * offset
    instructions = []
    while len(instructions) < (offset + 1):
        block = gdb.current_progspace().block_for_pc(start)
        if block is None:
            instructions = [
                {"addr": 0, "asm": "unknown"}
                for i in range(0, offset - len(instructions))
            ] + instructions
        else:
            ins = arch.disassemble(start_pc=block.start, end_pc=end_pc)
            instructions = ins + instructions
        start = start - 8 * (offset - len(instructions))
        end_pc = block.start

    diff = len(instructions) - offset
    result = instructions[diff : diff + count]
    if result[-1]["addr"] == ins_at_pc["addr"]:
        result.pop()
        result = [instructions[diff - 1]] + result
    return result[:count]


@request(
    "disassemble",
    Args(
        ["memoryReference", "instructionCount"],
        ["instructionOffset", "resolveSymbols", "offset"],
    ),
)
def disassemble(args):
    pc = int(args["memoryReference"], 16) + safeInt(args.get("offset"))
    inf = gdb.selected_inferior()
    try:
        arch = gdb.selected_frame().architecture()
    except gdb.error:
        arch = inf.architecture()
    result = []
    instructionCount = safeInt(args["instructionCount"])
    instructionOffset = safeInt(args.get("instructionOffset"))
    requestedCount = instructionOffset + instructionCount
    # For now we ignore when instructionOffset < 0, arch.disassemble will fail
    # and we return nothing. It's to error prone currently, to concatenate outputs
    for elt in arch.disassemble(pc, count=requestedCount)[instructionOffset:]:
        insn = {
            "address": hex(elt["addr"]),
            "instruction": elt["asm"]
        }
        result.append(insn)
    return {
        "instructions": result,
    }


@request("disconnect", Args([], ["terminateDebuggee", "restart", "suspendDebuggee"]))
def disconnect(args):
    global session
    session.disconnect(args.get("terminateDebuggee"))
    return {}


@request("exceptionInfo", Args(["threadId"], []))
def exception_info(args):
    global exceptionInfos
    info = exceptionInfos.get(args["threadId"])
    if info is None:
        raise Exception(f"Exception Info {args['threadId']} not found.")
    return info


@request("completions", Args(["text", "column"], ["frameId", "line"]))
def completions(args):
    replace_len = len(args["text"])
    result = [
        {"label": item, "length": replace_len}
        for item in gdb.execute(f"complete {args['text']}", to_string=True).splitlines()
    ]
    return {"targets": result}


@request("initialize", req_args=ArbitraryOptionalArgs())
def initialize(args):
    global logger
    global Handler
    global session

    session = Session(args)

    if args.get("trace") == "Full":
        logger.init_perf_log("perf.log")
        logger.init_debug_log("debug.log")
        Handler = LoggingCommandHandler

    return {
        "supportsVariableType": True,
        "supportsConfigurationDoneRequest": True,
        "supportsFunctionBreakpoints": True,
        "supportsConditionalBreakpoints": True,
        "supportsHitConditionalBreakpoints": False,
        "supportsEvaluateForHovers": False,
        "exceptionBreakpointFilters": [
            {
                "filter": "throw",
                "label": "Thrown exceptions",
                "supportsCondition": False,
            },
            {
                "filter": "rethrow",
                "label": "Re-thrown exceptions",
                "supportsCondition": False,
            },
            {
                "filter": "catch",
                "label": "Caught exceptions",
                "supportsCondition": False,
            },
        ],
        "supportsStepBack": bool(args.get("rr-session")),
        "supportsSetVariable": False,
        "supportsRestartFrame": False,
        "supportsGotoTargetsRequest": False,
        "supportsStepInTargetsRequest": False,
        "supportsCompletionsRequest": True,
        "completionTriggerCharacters": ["."],
        "supportsModulesRequest": False,
        "additionalModuleColumns": False,
        "supportedChecksumAlgorithms": False,
        "supportsRestartRequest": False,
        "supportsExceptionOptions": False,
        "supportsValueFormattingOptions": True,
        "supportsExceptionInfoRequest": True,
        "supportTerminateDebuggee": True,
        "supportSuspendDebuggee": False,
        "supportsDelayedStackTraceLoading": False,
        "supportsLoadedSourcesRequest": False,
        "supportsLogPoints": False,
        "supportsTerminateThreadsRequest": False,
        "supportsSetExpression": not bool(args.get("rr-session")),
        "supportsTerminateRequest": False,
        "supportsDataBreakpoints": True,
        "supportsReadMemoryRequest": True,
        "supportsWriteMemoryRequest": not bool(args.get("rr-session")),
        "supportsDisassembleRequest": True,
        "supportsCancelRequest": False,
        "supportsBreakpointLocationsRequest": False,
        "supportsClipboardContext": False,
        "supportsSteppingGranularity": True,
        "supportsInstructionBreakpoints": True,
        "supportsExceptionFilterOptions": True,
        "supportsSingleThreadExecutionRequests": not bool(args.get("rr-session")),
    }


@request("configurationDone")
def configuration_done(args):
    global session
    if session is None:
        raise Exception("Session has not been configured")
    else:
        session.start_tracee()
    return {}


@request("launch", ArbitraryOptionalArgs(["program"], ["args"]))
def launch(args):
    global session
    session.start_session(
        {
            "type": "launch",
            "program": args["program"],
            "args": args.get("args") or [],
            "stopOnEntry": args.get("stopOnEntry"),
            "noSingleThreadControl": args.get("noSingleThreadControl"),
            "setupCommands": args.get("setupCommands"),
        }
    )
    return {}


@request("attach", ArbitraryOptionalArgs([], ["pid", "target"]))
def attach(args):
    global session
    pid = args.get("pid")
    cmd = None
    if pid is not None:
        cmd = f"attach {pid}"
        session.start_session(
            {
                "type": "attach",
                "command": cmd,
                "setupCommands": args.get("setupCommands"),
            }
        )
    else:
        type = args.get("target")["type"]
        param = args.get("target")["parameter"]
        cmd = f"target {type} {param}"
        session.start_session(
            {
                "type": "attach",
                "command": cmd,
                "noSingleThreadControl": args.get("noSingleThreadControl"),
                "setupCommands": args.get("setupCommands"),
            }
        )
        if bool(args.get("stopOnEntry")):
            gdb.execute("tbreak main")
    return {}


@request("next", Args(["threadId"], ["singleThread", "granularity"]))
def next(args):
    select_thread(args["threadId"])
    cmd = "nexti" if args.get("granularity") == "instruction" else "next"
    gdb.execute(cmd)
    return {}


@request("pause", Args(["threadId"]))
def pause(args):
    global singleThreadControl
    threadId = args.get("threadId")
    cmd = None
    if threadId is not None:
        try:
            gdb.select_thread(threadId)
        except:
            pass
        cmd = "interrupt"
    else:
        cmd = "interrupt -a"

    gdb.execute(cmd)
    return {}

@request("pauseAll", ArbitraryOptionalArgs())
def pauseAll(args):
    gdb.execute("interrupt -a")
    return { "allThreadsStopped": true }


@request("selectThread", ArbitraryOptionalArgs(["threadId"]))
def selectThread(args):
    select_thread(args["threadId"])
    return {}

@request("readMemory", Args(["memoryReference", "count"], ["offset"]))
def read_memory(args):
    offset = args.get("offset")
    if offset is None:
        offset = 0
    try:
        base_address = int(args["memoryReference"], 16) + offset
        data = gdb.selected_inferior().read_memory(base_address, args["count"])
        return {
            "address": hex(base_address),
            "data": base64.b64encode(data).decode("ascii"),
        }
    except:
        return {"address": hex(base_address), "unreadableBytes": args["count"]}


@request("restart", req_args=ArbitraryOptionalArgs())
def restart(args):
    global session
    session.restart()
    return {}


@request("reverseContinue", Args(["threadId"]))
def reverse_continue(args):
    select_thread(args.get("threadId"))
    gdb.execute("reverse-continue")
    # RR will always resume all threads - at least from the perspective of the user (it doesn't really do it)
    return {"allThreadsContinued": True}


@request("reverse-finish", ArbitraryOptionalArgs())
def reverse_finish(args):
    gdb.execute("reverse-finish")
    return {}


def get_checkpoints():
    result_str = gdb.execute("info checkpoints", to_string=True)
    cps = result_str.splitlines()[1:]
    result = []
    for cp_line in cps:
        [id, when, where] = cp_line.split("\t")
        sep = where.rfind(":")
        path = where[0:sep].strip()
        line = where[(sep + 1) :]
        result.append(
            {
                "id": int(id),
                "when": int(when),
                "where": {"path": path, "line": int(line)},
            }
        )
    return result


@request("set-checkpoint", ArbitraryOptionalArgs())
def set_checkpoint(args):
    gdb.execute("checkpoint")
    return {"checkpoints": get_checkpoints()}


# Used to check if we should suppress "exited" event
running_to_event_or_restarting_checkpoint = False


@request("restart-checkpoint", Args(["id"]))
def restart_checkpoint(args):
    global running_to_event_or_restarting_checkpoint
    has_cp = int(args["id"]) in [cp["id"] for cp in get_checkpoints()]
    if not has_cp:
        raise Exception(f"Checkpoint {args['id']} was not found")
    running_to_event_or_restarting_checkpoint = True
    gdb.execute(f"restart {args['id']}")
    return {}


@request("delete-checkpoint", Args(["id"]))
def delete_checkpoint(args):
    id = int(args["id"])
    current_cps = [cp["id"] for cp in get_checkpoints()]
    if id in current_cps:
        gdb.execute(f"delete checkpoint {id}")

    return {"checkpoints": get_checkpoints()}


@request("setBreakpoints", Args(["source"], ["breakpoints", "lines", "sourceModified"]))
def set_bps(args):
    global breakpoints
    src = args.get("source")
    path = src.get("path")
    if path is None:
        return {"breakpoints": []}
    else:
        bps = args.get("breakpoints")
        previous_bp_state = breakpoints.get(path)
        if previous_bp_state is None:
            previous_bp_state = {}
        breakpoints[path] = {}
        if bps is None:
            return {"breakpoints": []}

        for bp_req in bps:
            bp_key = (
                bp_req.get("line"),
                bp_req.get("condition"),
                bp_req.get("hitCondition"),
                bp_req.get("logMessage"),
            )
            if bp_key in previous_bp_state:
                breakpoints[path][bp_key] = previous_bp_state[bp_key]
            elif bp_req.get("logMessage") is not None:
                bp = LogPoint(source=path, line=int(bp_req.get("line")),logString=bp_req.get("logMessage"))
                bp.condition = bp_req.get("condition")
                breakpoints[path][bp_key] = bp
            else:
                bp = gdb.Breakpoint(source=path, line=int(bp_req.get("line")))
                bp.condition = bp_req.get("condition")
                breakpoints[path][bp_key] = bp

        diff = set(previous_bp_state.keys()) - set(breakpoints[path].keys())
        for key in diff:
            previous_bp_state[key].delete()
            del previous_bp_state[key]

    return {"breakpoints": [bp_to_ui(x) for x in breakpoints[path].values()]}


def pull_new_bp(old, new):
    diff = set(new) - set(old)
    if len(diff) > 1:
        raise Exception(
            "Multiple breakpoints were created (probably in parallell). Can't determine newest breakpoint."
        )
    return list(diff)[0] if len(diff) != 0 else None


@request(
    "setExceptionBreakpoints", Args(["filters"], ["filterOptions", "exceptionOptions"])
)
def set_exception_bps(args):
    global exceptionBreakpoints
    ids = []
    for id in args["filters"]:
        ids.append(id)
    if args.get("filterOptions") is not None:
        for opt in args["filterOptions"]:
            ids.append(opt["filterId"])
    current_breakpoints = gdb.breakpoints()
    bps = []
    for id in ids:
        if exceptionBreakpoints.get(id) is None:
            gdb.execute(f"catch {id}")
            new_bplist = gdb.breakpoints()
            new_bp = pull_new_bp(current_breakpoints, new_bplist)
            exceptionBreakpoints[id] = new_bp
            current_breakpoints = gdb.breakpoints()
            bps.append(bp_to_ui(new_bp))

    unset = set(exceptionBreakpoints.keys()) - set(ids)
    for id in unset:
        exceptionBreakpoints[id].delete()
        del exceptionBreakpoints[id]

    return {"breakpoints": bps}


@request("setExpression", Args(["expression", "value"], ["frameId", "format"]))
def set_expression(args):
    expr = args["expression"]
    val = args["value"]
    gdb.execute(f"set variable {expr} = {val}")
    value = gdb.parse_and_eval(f"{expr}")
    return {"value": f"{value}"}


@request("setFunctionBreakpoints", Args(["breakpoints"]))
def set_fn_bps(args):
    global breakpoints
    result = []
    bps = args["breakpoints"]
    previous_bp_state = breakpoints.get("function")
    if previous_bp_state is None:
        previous_bp_state = {}
    breakpoints["function"] = {}

    for bp_req in bps:
        bp_key = (
            bp_req.get("name"),
            bp_req.get("condition"),
            bp_req.get("hitCondition"),
        )
        if bp_key in previous_bp_state:
            breakpoints["function"][bp_key] = previous_bp_state[bp_key]
        else:
            bp = gdb.Breakpoint(function=bp_req.get("name"))
            bp.condition = bp_req.get("condition")
            breakpoints["function"][bp_key] = bp
            result.append(bp_to_ui(bp))

    diff = set(previous_bp_state.keys()) - set(breakpoints["function"].keys())
    for key in diff:
        previous_bp_state[key].delete()
        del previous_bp_state[key]

    return {"breakpoints": [bp_to_ui(x) for x in breakpoints["function"].values()]}


@request("setInstructionBreakpoints", Args(["breakpoints"], []))
def set_ins_bps(args):
    global breakpoints
    result = []
    bps = args["breakpoints"]
    previous_bp_state = breakpoints.get("address")
    if previous_bp_state is None:
        previous_bp_state = {}
    breakpoints["address"] = {}

    for bp_req in bps:
        bp_key = (
            bp_req.get("instructionReference"),
            bp_req.get("offset"),
            bp_req.get("condition"),
            bp_req.get("hitCondition"),
        )
        if bp_key in previous_bp_state:
            breakpoints["address"][bp_key] = previous_bp_state[bp_key]
        else:
            address = int(bp_req.get("instructionReference"), 16) + safeInt(bp_req.get("offset"))
            bp = gdb.Breakpoint(spec=f"*{address}")
            bp.condition = bp_req.get("condition")
            # if bp_req.get("hitCondition") is not None:
            # bp.ignore_count = int(gdb.parse_and_eval(bp_req.get("hitCondition"), global_context=True))
            breakpoints["address"][bp_key] = bp
            result.append(bp_to_ui(bp))

    diff = set(previous_bp_state.keys()) - set(breakpoints["address"].keys())
    for key in diff:
        previous_bp_state[key].delete()
        del previous_bp_state[key]

    return {"breakpoints": [bp_to_ui(x) for x in breakpoints["address"].values()]}


@request("source", Args(["sourceReference"], ["source"]))
def source(args):
    raise Exception("source not implemented")


@request("stepBack", Args(["threadId"], ["singleThread", "granularity"]))
def step_back(args):
    select_thread(args["threadId"])
    granularity = args.get("granularity")

    if granularity == "instruction":
        cmd = "reverse-stepi"
    elif granularity == "statement":
        # this is actually not "next statement" because GDB doesn't understand what that means
        # even though it has the power to do so, or a similar variant of it. Unfortunately my patch is in limbo.
        cmd = "reverse-step"
    else:
        # default to next, although spec says explicitly statement is default. Gdb doesn't understand statements
        # and I sent a patch that made it the equivalent of understanding statements.
        # It wasn't accepted because they couldn't understand it.
        cmd = "reverse-next"

    gdb.execute(cmd)
    return {}


@request("stepIn", Args(["threadId"], ["singleThread", "granularity"]))
def step_in(args):
    select_thread(args["threadId"])
    cmd = "stepi" if args.get("granularity") == "instruction" else "step"
    gdb.execute(cmd)
    return {}


@request("stepOut", Args(["threadId"], ["singleThread", "granularity"]))
def step_out(args):
    global logger
    select_thread(args["threadId"])
    gdb.FinishBreakpoint(gdb.selected_frame())
    if singleThreadControl:
      gdb.execute("continue")
    else:
      cmd = "continue -a" if singleThreadControl else "continue"
      gdb.execute(cmd)

    return {}


@request("terminate", Args([], ["restart"]))
def terminate(args):
    global session
    session.kill_tracee()
    if args.get("restart"):
        session.restart()
    return {}


eventSocket = None
# Socket where we receive requests and send responses on
cmdConn = None


def prep_event(seq, evt):
    evt["seq"] = seq
    payload = json.dumps(evt)
    return f"Content-Length: {len(payload)}\r\n\r\n{payload}"


def event_thread():
    global eventSocket
    global eventSocketPath

    # remove the socket file if it already exists
    try:
        unlink(eventSocketPath)
    except OSError:
        if path.exists(eventSocketPath):
            raise

    eventSocket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    eventSocket.bind(eventSocketPath)
    eventSocket.listen(1)
    event_connection, client_address = eventSocket.accept()
    global seq
    while run:
        res = eventsQueue.get()
        logger.log_msg(msg=f"[evt]: {json.dumps(res)}\n")
        packet = prep_event(seq, res)
        seq += 1
        event_connection.sendall(bytes(packet, "utf-8"))

interpolationPattern = r'\{([^}]+)\}'

class LogPoint (gdb.Breakpoint):
    def __init__(self, source, line, logString):
        super(LogPoint, self).__init__(source=source, line=line)
        global interpolationPattern
        self.logString = logString
        self.evaluations = [(match.group(1), match.start(), match.end()) for match in re.finditer(interpolationPattern, logString)]

    def stop (self):
        buffer = StringIO()
        current_start = 0
        try:
          for (expr, start, end) in self.evaluations:
              value = gdb.parse_and_eval(expr)
              buffer.write(self.logString[current_start:start])
              buffer.write(f"{value}")
              current_start = end

          buffer.write(self.logString[current_start:])
          buffer.write("\n")
          buffer.flush()
          send_event("output", { "category": "console", "output": buffer.getvalue() })
        except Exception as e:
          send_event("output", { "category": "console", "output": f"Exception in logpoint: {e}" })
        return False


def send_event(evt, body):
    eventsQueue.put({"type": "event", "event": evt, "body": body})


def prep_response(seq, request_seq, success, command, message=None, body=None):
    payload = json.dumps(
        {
            "type": "response",
            "seq": seq,
            "request_seq": request_seq,
            "success": success,
            "command": command,
            "message": message,
            "body": body,
        }
    )
    return f"Content-Length: {len(payload)}\r\n\r\n{payload}"


DAPHeader = "Content-Length:"
HeaderLen = len(DAPHeader)


def check_header(header):
    if not header.startswith(DAPHeader):
        raise Exception("Invalid Header for request")


def parse_one_request(data) -> (dict, str):
    global DAPHeader
    global HeaderLen
    res = None
    # we expect newlines to be \r\n as per the DA Protocol
    buffer = StringIO(data, "\r\n")
    content_len = None
    header = buffer.readline().strip()
    try:
        check_header(header)
        header_payload = header[HeaderLen:].strip()
        content_len = int(header_payload)
        buffer.readline()
        current = buffer.tell()
        payload = buffer.read(content_len)
        if buffer.tell() - current != content_len:
            raise
        res = json.loads(payload)
        return (res, buffer.read())
    except:
        # No message can be parsed from the current contents of `data`
        return (None, data)


def LoggingCommandHandler(seq, req_seq, req, args):
    global logger
    global commands
    cmd = commands.get(req)
    try:
        body = logger.perf_log(lambda: cmd(args), req)
        res = {
            "seq": seq,
            "req_seq": req_seq,
            "cmd": req,
            "success": True,
            "message": None,
            "body": body,
        }
    except Exception as e:
        try:
            args_contents = json.dumps(args)
        except:
            args_contents = "Failed to determine args to request"
        res = {
            "seq": seq,
            "req_seq": req_seq,
            "cmd": req,
            "success": False,
            "message": f"Request {req} failed:\n{e}",
            "body": {
                "error": {
                    "stacktrace": f"Request {req} failed with args {args_contents}:\n{traceback.format_exc()}"
                }
            },
        }
    responsesQueue.put(res)


# The CommandHandler callable gets posted via a lambda. That way, we can catch exceptions and place those values on the thread safe queue as well
def CommandHandler(seq, req_seq, req, args):
    global commands
    cmd = commands.get(req)
    try:
        body = cmd(args)
        res = {
            "seq": seq,
            "req_seq": req_seq,
            "cmd": req,
            "success": True,
            "message": None,
            "body": body,
        }
    except Exception as e:
        res = {
            "seq": seq,
            "req_seq": req_seq,
            "cmd": req,
            "success": False,
            "message": f"{e}",
            "body": {"error": {"stacktrace": traceback.format_exc()}},
        }
    responsesQueue.put(res)


Handler = CommandHandler


def start_command_response_thread():
    global run
    global cmdConn
    global responsesQueue
    while run:
        res = responsesQueue.get()
        response = prep_response(
            seq=res["seq"],
            request_seq=res["req_seq"],
            success=res["success"],
            command=res["cmd"],
            message=res["message"],
            body=res["body"],
        )
        cmdConn.sendall(bytes(response, "utf-8"))
    gdb.post_event(lambda: gdb.execute("exit"))


def set_configuration():
    gdb.execute("set confirm off")
    gdb.execute("set pagination off")
    gdb.execute("set python print-stack full")


def handle_request(req):
    global commands
    global Handler
    cmd = req.get("command")
    command_handler = commands.get(cmd)

    if command_handler is None:
        raise gdb.GdbError(
            f"Unknown DAP request: '{req.get('command')}'. Request: '{json.dumps(req)}'"
        )
    args = req.get("arguments")
    req_seq = req.get("seq")
    if req_seq is None:
        raise gdb.GdbError("Request sequence number not found")
    gdb.post_event(lambda: Handler(0, req_seq, cmd, args))


def start_command_thread():
    global commands
    global seq
    global run
    global cmdConn
    global commandSocketPath
    global Handler
    # Must be turned off; otherwise `gdb.execute("kill")` will crash gdb
    gdb.post_event(set_configuration)
    # remove the socket file if it already exists
    try:
        unlink(commandSocketPath)
    except OSError:
        if path.exists(commandSocketPath):
            raise
    cmd_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    cmd_socket.bind(commandSocketPath)
    cmd_socket.listen(1)
    cmdConn, client_address = cmd_socket.accept()
    # TODO(simon): do something better than just using a dumb string as a buffer. For now, it's the simplest solution (though stupid).
    # Re-use the memory instead reducing allocations.
    buffer = ""
    responder_thread = threading.Thread(
        target=start_command_response_thread, name="Responder", daemon=True
    )
    responder_thread.start()
    try:
        while run:
            data = cmdConn.recv(4096)
            buffer = buffer + data.decode("utf-8")
            req = None
            (req, buffer) = parse_one_request(buffer)
            while req is not None:
                handle_request(req)
                (req, buffer) = parse_one_request(buffer)
    finally:
        unlink(commandSocketPath)


def ensure_stopped_handler_last(evt):
    gdb.events.stop.disconnect(stopped)
    gdb.events.stop.connect(stopped)


def continued_event(evt):
    ensure_stopped_handler_last(evt)
    global currentReturnValue
    currentReturnValue.clear()
    send_event(
        "continued",
        {
            "threadId": evt.inferior_thread.global_num
            if evt.inferior_thread is not None
            else gdb.selected_thread().global_num,
            "allThreadsContinued": evt.inferior_thread is None,
        },
    )


gdb.events.new_objfile.connect(ensure_stopped_handler_last)
gdb.events.new_inferior.connect(ensure_stopped_handler_last)

def stopped(evt):
    global exceptionInfos
    global exceptionBreakpoints
    global singleThreadControl
    global currentReturnValue
    stoppedThread = evt.inferior_thread if evt.inferior_thread is not None else gdb.selected_thread()
    body = {
        "threadId": gdb.selected_thread().global_num,
        "allThreadsStopped": not singleThreadControl,
        "reason": "step",
    }

    if isinstance(evt, gdb.BreakpointEvent):
        body["reason"] = "breakpoint"
        body["hitBreakpointIds"] = [bp.number for bp in evt.breakpoints]
        if evt.breakpoint.type == gdb.BP_CATCHPOINT:
            for k, bp in exceptionBreakpoints.items():
                if bp == evt.breakpoint:
                    exc_info = {
                        "exceptionId": f"{k}",
                        "description": f"Catchpoint for {k} hit.",
                        "breakMode": "always",
                    }
                    exceptionInfos[gdb.selected_thread().global_num] = exc_info
            body["reason"] = "exception"
        if isinstance(evt.breakpoint, gdb.FinishBreakpoint):
            currentReturnValue[stoppedThread.global_num] = evt.breakpoint.return_value
    elif isinstance(evt, gdb.SignalEvent):
        exc_info = {
            "exceptionId": f"{evt.stop_signal}",
            "description": f"Signal {evt.stop_signal} was raised by tracee",
            "breakMode": "always",
        }
        exceptionInfos[gdb.selected_thread().global_num] = exc_info
        body["reason"] = "exception"
    send_event("stopped", body=body)


def bp_src_info(bp):
    if hasattr(bp, "locations"):
        if len(bp.locations) == 0:
            return (None, None)
        if bp.locations[0].source is None:
            return (None, None)
        return bp.locations[0].source
    else:
        return (None, None)


def bp_to_ui(bp):
    (source, line) = bp_src_info(bp)
    obj = {"id": bp.number, "verified": not bp.pending}
    if line is not None:
        obj["line"] = line
    if source is not None:
        obj["source"] = {"name": path.basename(source), "path": source}
    if bp.locations is not None and len(bp.locations) != 0:
        obj["instructionReference"] = hex(bp.locations[0].address)

    return obj


def on_exit(evt):
    global running_to_event_or_restarting_checkpoint
    if running_to_event_or_restarting_checkpoint:
        running_to_event_or_restarting_checkpoint = False
    else:
        send_event(
            "exited", {"exitCode": evt.exit_code if hasattr(evt, "exit_code") else 0}
        )


gdb.events.exited.connect(on_exit)

gdb.events.new_thread.connect(
    lambda evt: send_event(
        "thread", {"reason": "started", "threadId": evt.inferior_thread.global_num}
    )
)

gdb.events.cont.connect(continued_event)


def bkpt_created(bp):
    if not isinstance(bp, gdb.FinishBreakpoint):
        send_event("breakpoint", {"reason": "new", "breakpoint": bp_to_ui(bp)})


gdb.events.breakpoint_created.connect(bkpt_created)


def bkpt_modified(bp):
    if not isinstance(bp, gdb.FinishBreakpoint):
        send_event("breakpoint", {"reason": "changed", "breakpoint": bp_to_ui(bp)})


gdb.events.breakpoint_modified.connect(bkpt_modified)


# thread_exited event doesn't exist in version 13.2, but will exist in future versions
if hasattr(gdb.events, "thread_exited"):
    gdb.events.thread_exited.connect(
        lambda evt: send_event(
            "thread", {"reason": "exited", "threadId": evt.inferior_thread.global_num}
        )
    )

gdb.events.gdb_exiting.connect(lambda evt: send_event("terminated", {}))
gdb.events.stop.connect(stopped)


dap_thread = threading.Thread(
    target=start_command_thread, name="DAP-Thread", daemon=True
)

socket_manager_thread = threading.Thread(
    target=event_thread, name="Socket Manager", daemon=True
)

dap_thread.start()
socket_manager_thread.start()

import atexit


def clean_up():
    global eventSocketPath
    global commandSocketPath
    try:
        unlink(eventSocketPath)
    except:
        pass

    try:
        unlink(commandSocketPath)
    except:
        pass


atexit.register(clean_up)
