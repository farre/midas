import gdb
import config
import logging

from os import path
from midas_utils import prepareCommandResponse, parseCommandArguments, sendResponse, timeInvocation

def createVSCStackFrame(frame):
    try:
        res = vscFrameFromFn(frame, frame.function())
        return res
    except:
        res = vscFrameFromNoSymtab(frame.name(), frame)
        return res

def vscFrameFromFn(frame, functionSymbol):
    sal = frame.find_sal()
    functionSymbolTab = functionSymbol.symtab
    filename = path.basename(functionSymbolTab.filename)
    fullname = functionSymbolTab.fullname()
    line_number = sal.line
    # DebugProtocol.Source
    src = { "name": filename, "path": fullname, "sourceReference": 0 }
    stackStart = frame.read_register("rbp")
    sf = {
        "id": config.nextVariableReference(),
        "source": src,
        "line": line_number,
        "column": 0,
        "name": "{}".format(functionSymbol.name),
        "address": frame.pc(),
        "stackAddressStart": int(stackStart),
    }
    return sf

def vscFrameFromNoSymtab(name, frame):
    sal = frame.find_sal()
    line_number = sal.line
    # DebugProtocol.Source
    src = None
    try:
        src = { "name": path.basename(sal.symtab.filename), "path": sal.symtab.fullname(), "sourceReference": 0 }
    except:
        pass

    stackStart = frame.read_register("rbp")
    sf = {
        "id": config.nextVariableReference(),
        "source": src,
        "line": line_number,
        "column": 0,
        "name": name,
        "address": frame.pc(),
        "stackAddressStart": int(stackStart),
    }
    return sf

class StackTraceRequest(gdb.Command):
    def __init__(self):
        super(StackTraceRequest, self).__init__("gdbjs-stacktrace-request", gdb.COMMAND_USER)
        self.name = "stacktrace-request"

    @timeInvocation
    def invoke(self, arguments, from_tty):
        [threadId, start, levels] = parseCommandArguments(arguments)
        threadId = int(threadId)
        levels = int(levels)
        start = int(start)
        try:
            ec = config.executionContexts.get(threadId)
            if ec is None:
                misc_logger = logging.getLogger("update-logger")
                misc_logger.debug("Created execution context for thread num {}".format(threadId))
                ec = config.ExecutionContext(threadId)
                config.executionContexts[threadId] = ec
            stack_frames = ec.get_frames(start, levels)
            sendResponse(self.name, stack_frames, prepareCommandResponse)
        except:
            # means selectThreadAndFrame failed; we have no frames from `start` and down
            sendResponse(self.name, [], prepareCommandResponse)

