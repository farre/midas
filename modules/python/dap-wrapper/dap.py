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
    variable_references,
    StackFrame,
    clear_variable_references,
)


class Session:
    def __init__(self, sessionArgs):
        self.sessionArgs = sessionArgs
        if sessionArgs["type"] == "launch":
            if sessionArgs.get("program") is None:
                raise Exception("No program was provided for gdb to launch")
            gdb.execute(f"file {sessionArgs['program']}")
        elif sessionArgs["type"] == "attach":
            gdb.execute(sessionArgs["command"])
        else:
            raise Exception(f"Unknown session type {sessionArgs['type']}")

    def start_tracee(self):
        global singleThreadControl
        if self.sessionArgs["allStopMode"]:
            singleThreadControl = True
            gdb.execute("set non-stop on")
        if self.sessionArgs["stopOnEntry"]:
            gdb.post_event(lambda: gdb.execute(f"start"))
        else:
            gdb.post_event(lambda: gdb.execute(f"run"))

    def restart(self):
        clear_variable_references()
        if self.sessionArgs["stopOnEntry"]:
            gdb.post_event(lambda: gdb.execute(f"start"))
        else:
            gdb.post_event(lambda: gdb.execute(f"run"))

    def kill_tracee(self):
        gdb.execute("kill")

    def disconnect(self, kill_tracee):
        global run
        run = False
        if kill_tracee:
            session.kill_tracee()


# DAP "Interpreter" State
commands = {}
seq = 1
run = True
breakpoints = {}
singleThreadControl = False
responsesQueue = Queue()
session = None


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

class ArbitraryArgs(Args):
    def __init__(self, required=[], optional=[]):
        0
    def check_args(self, args):
        return

protocol = {}
protocol["breakpointLocations"] = Args(
    ["source", "line"], ["column", "endLine", "endColumn"]
)
protocol["completions"] = Args(["text", "column"], ["frameId", "line"])
protocol["evaluate"] = Args(["expression"], ["frameId", "context", "format"])


def check_args(args={}, optional={}, required={}):
    supported = optional.union(required)
    keys = args.keys()
    for arg in keys:
        if arg not in supported:
            raise Exception(
                f"Argument {arg} not supported. Supported args: {supported}"
            )
    for arg in required:
        if arg not in keys:
            raise Exception(
                f"Missing required argument: {arg}. Required args: {required}"
            )


def request(name, req_args=Args()):
    """Wraps a request and verifies that the required parameters have been passed into the dictionary `args`.
    Only optional parameters need to be checked if they're None or not (using args.get(..))"""

    def dec(fn):
        global commands

        @functools.wraps(fn)
        def wrap(args):
            global protocol
            req_args.check_args(args)
            # protocol[name].check_args(args)
            return fn(args)

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


@request("threads", Args())
def threads_request(args):
    res = []
    for t in gdb.selected_inferior().threads():
        thr_name = "No thread name"
        if t.name is not None:
            thr_name = t.name
        if t.details is not None:
            thr_name = t.details
        res.append({"id": t.global_num, "name": thr_name})
    return {"threads": res}


@request("stackTrace", Args(["threadId"], ["levels", "startFrame"]))
def stacktrace(args):
    res = []
    select_thread(args["threadId"])
    for frame in iterate_frames(
        frame=gdb.selected_frame(),
        count=args.get("levels"),
        start=args.get("startFrame"),
    ):
        sf = StackFrame(frame)
        res.append(sf.contents())
    return {"stackFrames": res}


@request("scopes", Args(["frameId"]))
def scopes(args):
    global variable_references
    sf = variable_references.get(args["frameId"])
    if sf is None:
        raise Exception(f"Failed to get frame with id {args['frameId']}")
    return {"scopes": sf.scopes()}


@request("variables", Args(["variablesReference"], ["start", "count", "format"]))
def variables(args):
    global variable_references
    container = variable_references.get(args["variablesReference"])
    if container is None:
        raise Exception(
            f"Failed to get variablesReference {args['variablesReference']}"
        )
    return {"variables": container.contents()}


@request("continue", Args(["threadId"], ["singleThread"]))
def continue_(args):
    global singleThreadControl
    continueOneThread = args.get("singleThread")
    thread = select_thread(args.get("threadId"))
    allThreadsContinued = True
    if continueOneThread and singleThreadControl:
        gdb.execute("continue")
        allThreadsContinued = False
    else:
        cmd = "continue -a" if singleThreadControl else "continue"
        gdb.execute(cmd)

    return {"allThreadsContinued": allThreadsContinued}


@request("dataBreakpointInfo", Args(["name"], ["frameId", "variablesReference"]))
def databreakpoint_info(args):
    raise Exception("dataBreakpointInfo not implemented")


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


@request("disconnect", Args([], ["terminateDebuggee"]))
def disconnect(args):
    global session
    # restart = args.get("restart")
    # suspend = args.get("suspendDebuggee")
    session.disconnect(args.get("terminateDebuggee"))
    return {}


@request(
    "exceptionInfo", Args(["exceptionId", "breakMode"], ["description", "details"])
)
def exception_info(args):
    raise Exception("exceptionInfo not implemented")


@request("initialize", req_args=ArbitraryArgs())
def initialize(args):
    # args to request:
    # clientID = args.get("clientID")
    # clientName = args.get("clientName")
    # adapterI = args.get("adapterI")
    # locale = args.get("locale")
    # linesStartAt1 = args.get("linesStartAt1")
    # columnsStartAt1 = args.get("columnsStartAt1")
    # pathFormat = args.get("pathFormat")
    # supportsVariableType = args.get("supportsVariableType")
    # supportsVariablePaging = args.get("supportsVariablePaging")
    # supportsRunInTerminalRequest = args.get("supportsRunInTerminalRequest")
    # supportsMemoryReferences = args.get("supportsMemoryReferences")
    # supportsProgressReporting = args.get("supportsProgressReporting")
    # supportsInvalidatedEvent = args.get("supportsInvalidatedEvent")
    # supportsMemoryEvent = args.get("supportsMemoryEvent")
    # supportsArgsCanBeInterpretedByShell = args.get("supportsArgsCanBeInterpretedByShell")
    # supportsStartDebuggingRequest = args.get("supportsStartDebuggingRequest")

    # Currently just return false, until important stuff is working
    return {
            "supportsConfigurationDoneRequest": True,
            "supportsFunctionBreakpoints": True,
            "supportsConditionalBreakpoints": True,
            "supportsHitConditionalBreakpoints": False,
            "supportsEvaluateForHovers": False,
            "exceptionBreakpointFilters": False,
            "supportsStepBack": False,
            "supportsSetVariable": False,
            "supportsRestartFrame": False,
            "supportsGotoTargetsRequest": False,
            "supportsStepInTargetsRequest": False,
            "supportsCompletionsRequest": False,
            "completionTriggerCharacters": False,
            "supportsModulesRequest": False,
            "additionalModuleColumns": False,
            "supportedChecksumAlgorithms": False,
            "supportsRestartRequest": True,
            "supportsExceptionOptions": False,
            "supportsValueFormattingOptions": False,
            "supportsExceptionInfoRequest": False,
            "supportTerminateDebuggee": True,
            "supportSuspendDebuggee": False,
            "supportsDelayedStackTraceLoading": False,
            "supportsLoadedSourcesRequest": False,
            "supportsLogPoints": False,
            "supportsTerminateThreadsRequest": False,
            "supportsSetExpression": False,
            "supportsTerminateRequest": False,
            "supportsDataBreakpoints": False,
            "supportsReadMemoryRequest": True,
            "supportsWriteMemoryRequest": False,
            "supportsDisassembleRequest": True,
            "supportsCancelRequest": False,
            "supportsBreakpointLocationsRequest": False,
            "supportsClipboardContext": False,
            "supportsSteppingGranularity": True,
            "supportsInstructionBreakpoints": True,
            "supportsExceptionFilterOptions": False,
            "supportsSingleThreadExecutionRequests": False,
    }


def start_tracee(program, allStopMode, setBpAtMain):
    global singleThreadControl
    if allStopMode:
        singleThreadControl = True
        gdb.execute("set non-stop on")
    if program is None:
        raise Exception("No program was provided for gdb to launch")
    gdb.execute(f"file {program}")
    if setBpAtMain:
        gdb.post_event(lambda: gdb.execute(f"start"))


@request("configurationDone")
def configuration_done(args):
    global session
    if session is None:
        raise Exception("Session has not been configured")
    else:
        session.start_tracee()


@request("launch", Args(["program"], ["allStopMode", "stopOnEntry"]))
def launch(args):
    global session
    session = Session(
        {
            "type": "launch",
            "program": args["program"],
            "stopOnEntry": args.get("stopOnEntry"),
            "allStopMode": args.get("allStopMode"),
        }
    )
    return {}


@request("attach", Args([], ["pid", "target", "isExtended"]))
def attach(args):
    global session
    pid = args.get("pid")
    if pid is not None:
        cmd = f"attach {pid}"
        session = Session({"type": "attach", "command": cmd})
    else:
        target = args.get("target")
        isExtended = args.get("extended")
        param = "remote" if not isExtended else "extended-remote"
        cmd = f"target {param} {target}"
        session = Session({"type": "attach", "command": cmd})
    raise {}


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
    offset = int(args.get("offset"), 0) if args.get("offset") is not None else 0
    base_address = int(args["memoryReference"], 16) + offset
    data = gdb.selected_inferior().read_memory(base_address, int(args["count"], 0))
    return {"address": base_address, "data": base64.b64encode(data).decode("ascii")}


@request("restart")
def restart(args):
    # DAP Implementation Specific (we decide)
    raise Exception("restart not implemented")


@request("reverseContinue", Args(["threadId"]))
def reverse_continue(args):
    thread = select_thread(args.get("threadId"))
    gdb.execute("reverse-continue")
    # RR will always resume all threads.
    return {"allThreadsContinued": True}


@request("setBreakpoints", Args(["source"], ["breakpoints", "lines", "sourceModified"]))
def set_bps(args):
    global breakpoints
    src = args.get("source")
    path = src.get("path")
    if path is None:
        result = []
    else:
        result = []
        bps = args.get("breakpoints")
        current_bps = breakpoints.get(path)
        if current_bps is None:
            current_bps = {}
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
            if bp_key in current_bps:
                breakpoints[path][bp_key] = current_bps[bp_key]
            else:
                bp = gdb.Breakpoint(source=path, line=int(bp_req.get("line")))
                bp.condition = bp_req.get("condition")
                # if bp_req.get("hitCondition") is not None:
                # bp.ignore_count = int(gdb.parse_and_eval(bp_req.get("hitCondition"), global_context=True))
                breakpoints[path][bp_key] = bp
                result.append(bp_obj(bp))

    return {"breakpoints": result}


@request("setDataBreakpoints", Args(["breakpoints"]))
def set_databps(args):
    raise Exception("setDataBreakpoints not implemented")


@request(
    "setExceptionBreakpoints", Args(["filters"], ["filterOptions", "exceptionOptions"])
)
def set_exception_bps(args):
    raise Exception("setExceptionBreakpoints not implemented")


@request("setExpression", Args(["expression", "value"], ["frameId", "format"]))
def set_expression(args):
    raise Exception("setExpression not supported")


@request("setFunctionBreakpoints", Args(["breakpoints"]))
def set_fn_bps(args):
    global breakpoints
    result = []
    bps = args["breakpoints"]
    current_bps = breakpoints.get("function")
    if current_bps is None:
        current_bps = {}
    breakpoints["function"] = {}
    if len(bps) == 0:
        return {"breakpoints": []}

    for bp_req in bps:
        bp_key = (
            bp_req.get("name"),
            bp_req.get("condition"),
            bp_req.get("hitCondition"),
        )
        if bp_key in current_bps:
            breakpoints["function"][bp_key] = current_bps[bp_key]
        else:
            bp = gdb.Breakpoint(function=bp_req.get("name"))
            bp.condition = bp_req.get("condition")
            # if bp_req.get("hitCondition") is not None:
            # bp.ignore_count = int(gdb.parse_and_eval(bp_req.get("hitCondition"), global_context=True))
            breakpoints["function"][bp_key] = bp
            result.append(bp_obj(bp))

    return {"breakpoints": result}


@request("setInstructionBreakpoints", Args(["breakpoints"], []))
def set_ins_bps(args):
    global breakpoints
    result = []
    bps = args["breakpoints"]
    current_bps = breakpoints.get("address")
    if current_bps is None:
        current_bps = {}
    breakpoints["address"] = {}
    if len(bps) == 0:
        return {"breakpoints": []}

    for bp_req in bps:
        bp_key = (
            bp_req.get("instructionReference"),
            bp_req.get("offset"),
            bp_req.get("condition"),
            bp_req.get("hitCondition"),
        )
        if bp_key in current_bps:
            breakpoints["address"][bp_key] = current_bps[bp_key]
        else:
            address = int(bp_req.get("instructionReference"), 16)
            bp = gdb.Breakpoint(spec=f"*0x{address}")
            bp.condition = bp_req.get("condition")
            # if bp_req.get("hitCondition") is not None:
            # bp.ignore_count = int(gdb.parse_and_eval(bp_req.get("hitCondition"), global_context=True))
            breakpoints["address"][bp_key] = bp
            result.append(bp_obj(bp))

    return {"breakpoints": result}


@request("source", Args(["sourceReference"], ["source"]))
def source(args):
    raise Exception("source not implemented")


@request("stepBack", Args(["threadId"], ["singleThread", "granularity"]))
def step_back(args):
    select_thread(args["threadId"])
    cmd = (
        "reverse-stepi" if args.get("granularity") == "instruction" else "reverse-step"
    )
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


event_socket: socket = None
event_connection = None
# Socket where we receive requests and send responses on
cmdConn = None


def event_thread():
    socket_path = "/tmp/midas-events"
    global event_socket
    global event_connection

    # remove the socket file if it already exists
    try:
        unlink(socket_path)
    except OSError:
        if path.exists(socket_path):
            raise

    event_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    event_socket.bind(socket_path)
    event_socket.listen(1)
    event_connection, client_address = event_socket.accept()


def send_event(evt, body):
    global seq
    packet = prep_event(seq, evt, body)
    seq += 1
    event_connection.sendall(bytes(packet, "utf-8"))


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


def prep_event(seq, event, body):
    payload = json.dumps({"type": "event", "seq": seq, "event": event, "body": body})
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


# The CommandHandler callable gets posted via a lambda. That way, we can catch exceptions and place those values on the thread safe queue as well
def CommandHandler(seq, req_seq, req, cmd, args):
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


def start_command_thread():
    global commands
    global seq
    global run
    global cmdConn
    print("Starting command server...")
    # Must be turned off; otherwise `gdb.execute("kill")` will crash gdb
    gdb.execute("set confirm off")
    # remove the socket file if it already exists
    command_socket_path = "/tmp/midas-commands"
    try:
        unlink(command_socket_path)
    except OSError:
        if path.exists(command_socket_path):
            raise

    cmd_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    cmd_socket.bind(command_socket_path)
    cmd_socket.listen(1)
    cmdConn, client_address = cmd_socket.accept()
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
                cmd = req.get("command")
                command_handler = commands.get(cmd)

                if command_handler is None:
                    raise gdb.GdbError(
                        f"Unknown DAP request: '{req.get('command')}'. Request: '{json.dumps(req)}' | Buffer: '{buffer}'"
                    )
                args = req.get("arguments")
                req_seq = req.get("seq")
                gdb.post_event(
                    lambda: CommandHandler(0, req_seq, cmd, command_handler, args)
                )
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
    body = {
        "threadId": gdb.selected_thread().global_num,
        "allThreadsStopped": True,
        "reason": "breakpoint",
    }
    if isinstance(evt, gdb.BreakpointEvent):
        body["hitBreakpointIds"] = [bp.number for bp in evt.breakpoints]
    else:
        body["reason"] = "exception"
    send_event("stopped", body=body)


def bp_src_info(bp):
    if len(bp.locations) == 0:
        return (None, None)
    return bp.locations[0].source


def bp_obj(bp):
    (source, line) = bp_src_info(bp)
    return {
        "id": bp.number,
        "verified": not bp.pending,
        "line": line,
        "source": {
            "name": path.basename(source) if source is not None else None,
            "path": source,
        },
        "instructionReference": hex(bp.locations[0].address) if bp.locations else None,
    }


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
# gdb.events.thread_exited.connect(lambda evt: send_event("thread", { "reason": "exited", "threadId": evt.inferior_thread.global_num }))
gdb.events.cont.connect(continued_event)

# gdb.events.breakpoint_created.connect(bp_created)
gdb.events.breakpoint_created.connect(
    lambda bp: send_event("breakpoint", {"reason": "new", "breakpoint": bp_obj(bp)})
)
gdb.events.breakpoint_created.connect(
    lambda bp: send_event(
        "breakpoint", {"reason": "modified", "breakpoint": bp_obj(bp)}
    )
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
