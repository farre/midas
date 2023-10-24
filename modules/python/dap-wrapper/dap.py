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
import time

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

from variables_reference import (
    can_var_ref,
    variableReferences,
    exceptionInfos,
    StackFrame,
    clear_variable_references,
    VariablesReference,
    VariableValueReference
)

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

session = None
event_socket_path = "/tmp/midas-events"
command_socket_path = "/tmp/midas-commands"


class LogFile:
    def __init__(self, name):
        global stdlibpath
        self.name = name
        self.path = f"{stdlibpath}/{name}"
        self.file = open(self.path, "w")

    def log(self, msg):
        self.file.write(msg)

    def __del__(self):
        print(f"Flushing contents to {self.path}")
        self.file.flush()
        self.file.close()


class Logger:
    def __init__(self):
        self.perf = None
        self.debug = None

    def init_perf_log(self, log_name):
        self.perf = LogFile(log_name)

    def init_debug_log(self, log_name):
        self.debug = LogFile(log_name)

    def log_request(self, fn, args, res):
        if self.debug is not None:
            self.debug.log(msg=f"[req]: [{fn}] <- {json.dumps(args)}\n[res]: [{fn}] -> {json.dumps(res)}\n")

    def log_msg(self, msg):
        if self.debug is not None:
            self.debug.log(msg)

    def perf_log(self, fn, msg):
        start = time.perf_counter_ns()
        res = fn()
        end = time.perf_counter_ns()
        self.perf.log(msg=f"[{msg}]: {(end-start) / 1000_0000} ms\n")
        return res


logger = Logger()


def iterate_options(opts):
    if opts is not None:
        for opt in opts:
            yield opt
    return


# All requests use post_event; so here we _must_ use gdb.execute, so that we don't create weird out-of-order scenarios.
class Session:
    def __init__(self, type):
        self.type = type
        self.started = False

    def is_rr_session(self):
        return self.type == "midas-rr"

    def start_session(self, sessionArgs):
        global logger
        if self.started:
            raise Exception("Session already started")
        self.started = True

        self.sessionArgs = sessionArgs
        if sessionArgs["type"] == "launch":
            if sessionArgs.get("program") is None:
                raise Exception("No program was provided for gdb to launch")
            gdb.execute(f"file {sessionArgs['program']}")
        elif sessionArgs["type"] == "attach":
            gdb.execute(sessionArgs["command"])
        else:
            raise Exception(f"Unknown session type {sessionArgs['type']}")
        for opt in iterate_options(self.sessionArgs.get("setupCommands")):
            logger.log_msg(f"[cfg]: '{opt}'\n")
            gdb.execute(opt)

    def start_tracee(self):
        global singleThreadControl
        allStop = (
            True
            if self.sessionArgs.get("allStopMode") is None
            else self.sessionArgs.get("allStopMode")
        )
        if self.sessionArgs["type"] == "launch":
          if not allStop:
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
                raise Exception(f"Missing required argument: {arg}. Required args: {self.required}")


def request(name, req_args=Args()):
    """Wraps a request and verifies that the required parameters have been passed into the dictionary `args`.
    Only optional parameters need to be checked if they're None or not (using args.get(..))"""

    def dec(fn):
        global commands

        @functools.wraps(fn)
        def wrap(args):
            global logger
            req_args.check_args(args)
            result = fn(args)
            logger.log_request(name, args, result)
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
    if args["context"] == "repl":
        result = gdb.execute(args["expression"], from_tty=False, to_string=True)
        return {"result": result, "variablesReference": 0}
    elif args["context"] == "watch":
        try:
          value = gdb.parse_and_eval(args["expression"])
          if can_var_ref(value):
              ref = VariableValueReference(args["expression"], value)
              res = ref.ui_data()
              res["result"] = res.pop("value")
              return res
          else:
              return { "result": f"{value}", "variablesReference": 0, "memoryReference": hex(int(value.address)) }
        except:
            return { "result": "couldn't be evaluated", "variablesReference": 0 }
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


@request("stackTrace", Args(["threadId"], ["levels", "startFrame"]))
def stacktrace(args):
    res = []
    thread = select_thread(args["threadId"])
    for frame in iterate_frames(
        frame=gdb.newest_frame(),
        count=args.get("levels"),
        start=args.get("startFrame"),
    ):
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


@request("continue-all", ArbitraryOptionalArgs())
def continueAll(args):
    gdb.execute("continue -a")
    return {"allThreadsContinued": True}


@request("dataBreakpointInfo", Args(["name", "variablesReference"], ["frameId"]))
def databreakpoint_info(args):
    global variableReferences
    global session
    canPersist = session.is_rr_session()
    try:
        container = variableReferences.get(args["variablesReference"])
        value = container.find_value(args["name"])
        return { "dataId": hex(int(value.address)), "description": args["name"], "accessTypes": ["read", "write", "readWrite"], "canPersist": canPersist }
    except Exception as e:
        return { "dataId": None, "description": f"{e}", "accessTypes": ["read", "write", "readWrite"], "canPersist": canPersist }

def watchpoint_ids(bps):
    for watchpoint_id in bps:
        yield(watchpoint_id["dataId"], watchpoint_id["accessType"], watchpoint_id.get("condition"), watchpoint_id.get("hitCondition"))

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

    return { "breakpoints": [ bp_to_ui(x) for x in watchpoints.values() ] }


@request(
    "disassemble",
    Args(
        ["memoryReference", "instructionCount"],
        ["instructionOffset", "resolveSymbols", "offset"],
    ),
)
def disassemble(args):
    addr = args.get("memoryReference")
    offset = args.get("offset")
    ins_offset = args.get("instructionOffset")
    ins_count = args.get("instructionCount")
    resolve = args.get("resolveSymbols")
    raise Exception("disassemble not implemented")


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


@request("initialize", req_args=ArbitraryOptionalArgs())
def initialize(args):
    global logger
    global Handler
    global session

    sessionType = "midas-gdb"
    if args.get("type") is not None:
        sessionType = args.get("type")

    session = Session(sessionType)

    if args.get("trace") == "Full":
        logger.init_perf_log("perf.log")
        logger.init_debug_log("debug.log")
        Handler = LoggingCommandHandler

    return {
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
        "supportsCompletionsRequest": False,
        "completionTriggerCharacters": None,
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


@request("launch", ArbitraryOptionalArgs(["program"]))
def launch(args):
    global session
    session.start_session({
            "type": "launch",
            "program": args["program"],
            "stopOnEntry": args.get("stopOnEntry"),
            "allStopMode": args.get("allStopMode"),
            "setupCommands": args.get("setupCommands"),
    })
    return {}


@request("attach", ArbitraryOptionalArgs([], ["pid", "target", "isExtended"]))
def attach(args):
    global session
    pid = args.get("pid")
    cmd = None
    if pid is not None:
        cmd = f"attach {pid}"
        session.start_session({ "type": "attach", "command": cmd, "setupCommands": args.get("setupCommands") })
    else:
        target = args.get("target")
        isExtended = args.get("extended")
        param = "remote" if not isExtended else "extended-remote"
        cmd = f"target {param} {target}"
        session.start_session({ "type": "attach", "command": cmd, "allStopMode": args.get("allStopMode"), "setupCommands": args.get("setupCommands") })
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
    cmd = "interrupt -a" if singleThreadControl else "interrupt"
    gdb.execute(cmd)
    return {}


@request("readMemory", Args(["memoryReference", "count"], ["offset"]))
def read_memory(args):
    offset = args.get("offset")
    if offset is None:
        offset = 0
    base_address = int(args["memoryReference"], 16) + offset
    data = gdb.selected_inferior().read_memory(base_address, args["count"])
    return {
        "address": hex(base_address),
        "data": base64.b64encode(data).decode("ascii"),
    }


@request("restart", req_args=ArbitraryOptionalArgs())
def restart(args):
    global session
    session.restart()
    return {}


@request("reverseContinue", Args(["threadId"]))
def reverse_continue(args):
    select_thread(args.get("threadId"))
    gdb.execute("reverse-continue")
    # RR will always resume all threads.
    return {"allThreadsContinued": True}


@request("setBreakpoints", Args(["source"], ["breakpoints", "lines", "sourceModified"]))
def set_bps(args):
    global breakpoints
    src = args.get("source")
    path = src.get("path")
    if path is None:
        return { "breakpoints": [] }
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
            else:
                bp = gdb.Breakpoint(source=path, line=int(bp_req.get("line")))
                bp.condition = bp_req.get("condition")
                # if bp_req.get("hitCondition") is not None:
                # bp.ignore_count = int(gdb.parse_and_eval(bp_req.get("hitCondition"), global_context=True))
                breakpoints[path][bp_key] = bp
        
        diff = set(previous_bp_state.keys()) - set(breakpoints[path].keys())
        for key in diff:
            previous_bp_state[key].delete()
            del previous_bp_state[key]

    return { "breakpoints": [bp_to_ui(x) for x in breakpoints[path].values()] }


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
    raise Exception("setExpression not supported")


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

    return { "breakpoints": [bp_to_ui(x) for x in breakpoints["function"].values()] }

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
            address = int(bp_req.get("instructionReference"), 16)
            bp = gdb.Breakpoint(spec=f"*0x{address}")
            bp.condition = bp_req.get("condition")
            # if bp_req.get("hitCondition") is not None:
            # bp.ignore_count = int(gdb.parse_and_eval(bp_req.get("hitCondition"), global_context=True))
            breakpoints["address"][bp_key] = bp
            result.append(bp_to_ui(bp))

    diff = set(previous_bp_state.keys()) - set(breakpoints["address"].keys())
    for key in diff:
        previous_bp_state[key].delete()
        del previous_bp_state[key]

    return { "breakpoints": [bp_to_ui(x) for x in breakpoints["address"].values()] }

@request("source", Args(["sourceReference"], ["source"]))
def source(args):
    raise Exception("source not implemented")


@request("stepBack", Args(["threadId"], ["singleThread", "granularity"]))
def step_back(args):
    select_thread(args["threadId"])
    granularity = args.get("granularity")
    if granularity == "instruction":
        cmd = "reverse-stepi"
    elif granularity == "line":
        cmd = "reverse-next"
    else:
        cmd = "reverse-step"
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
    select_thread(args["threadId"])
    gdb.execute("finish")
    return {}


@request("terminate", Args([], ["restart"]))
def terminate(args):
    global session
    session.kill_tracee()
    if args.get("restart"):
        session.restart()
    return {}


event_socket = None
# Socket where we receive requests and send responses on
cmdConn = None


def prep_event(seq, evt):
    evt["seq"] = seq
    payload = json.dumps(evt)
    return f"Content-Length: {len(payload)}\r\n\r\n{payload}"


def event_thread():
    global event_socket
    global event_socket_path

    # remove the socket file if it already exists
    try:
        unlink(event_socket_path)
    except OSError:
        if path.exists(event_socket_path):
            raise

    event_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    event_socket.bind(event_socket_path)
    event_socket.listen(1)
    event_connection, client_address = event_socket.accept()
    global seq
    while run:
        res = eventsQueue.get()
        packet = prep_event(seq, res)
        seq += 1
        event_connection.sendall(bytes(packet, "utf-8"))


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
        res = {
            "seq": seq,
            "req_seq": req_seq,
            "cmd": req,
            "success": False,
            "message": f"{e}",
            "body": {"error": {"stacktrace": traceback.format_exc()}},
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
    global command_socket_path
    global Handler
    # Must be turned off; otherwise `gdb.execute("kill")` will crash gdb
    gdb.post_event(set_configuration)
    # remove the socket file if it already exists
    try:
        unlink(command_socket_path)
    except OSError:
        if path.exists(command_socket_path):
            raise
    cmd_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    cmd_socket.bind(command_socket_path)
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
        unlink(command_socket_path)


def continued_event(evt):
    send_event(
        "continued",
        {
            "threadId": evt.inferior_thread.global_num
            if evt.inferior_thread is not None
            else gdb.selected_thread().global_num,
            "allThreadsContinued": evt.inferior_thread is None,
        },
    )


def stopped(evt):
    global exceptionInfos
    global exceptionBreakpoints
    global singleThreadControl
    body = {
        "threadId": gdb.selected_thread().global_num,
        "allThreadsStopped": not singleThreadControl,
        "reason": "step",
    }

    if isinstance(evt, gdb.BreakpointEvent):
        body["reason"] = "breakpoint"
        body["hitBreakpointIds"] = [bp.number for bp in evt.breakpoints]
        if evt.breakpoint.type == gdb.BP_CATCHPOINT:
            for (k, bp) in exceptionBreakpoints.items():
                if bp == evt.breakpoint:
                    exc_info = {
                        "exceptionId": f"{k}",
                        "description": f"Catchpoint for {k} hit.",
                        "breakMode": "always",
                    }
                    exceptionInfos[gdb.selected_thread().global_num] = exc_info
            body["reason"] = "exception"
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
    obj = {"id": bp.number, "verified": not bp.pending }
    if line is not None:
        obj["line"] = line
    if source is not None:
        obj["source"] = {"name": path.basename(source), "path": source}
    if bp.locations is not None and len(bp.locations) != 0:
        obj["instructionReference"] = hex(bp.locations[0].address)

    return obj


gdb.events.exited.connect(
    lambda evt: send_event(
        "exited", {"exitCode": evt.exit_code if hasattr(evt, "exit_code") else 0}
    )
)
gdb.events.new_thread.connect(
    lambda evt: send_event(
        "thread", {"reason": "started", "threadId": evt.inferior_thread.global_num}
    )
)

gdb.events.cont.connect(continued_event)

gdb.events.breakpoint_created.connect(
    lambda bp: send_event("breakpoint", {"reason": "new", "breakpoint": bp_to_ui(bp)})
)
gdb.events.breakpoint_modified.connect(
    lambda bp: send_event("breakpoint", {"reason": "changed", "breakpoint": bp_to_ui(bp)})
)
gdb.events.breakpoint_deleted.connect(
    lambda bp: send_event(
        "breakpoint", {"reason": "removed", "breakpoint": {"id": bp.number}}
    )
)

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
    global event_socket_path
    global command_socket_path
    global logger
    del logger
    try:
        unlink(event_socket_path)
    except:
        pass

    try:
        unlink(command_socket_path)
    except:
        pass


atexit.register(clean_up)
