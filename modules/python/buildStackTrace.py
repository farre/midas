from mimetypes import init
import gdb
import sys
import json
import gdb.types
import traceback
import logging
import time
from os import path
import functools

def time_command_invocation(f):
    if not isDevelopmentBuild:
        return f
    """Measure performance (time) of command or function"""
    @functools.wraps(f)
    def timer_decorator(*args, **kwargs):
        invokeBegin = time.perf_counter_ns()
        f(*args, **kwargs)
        invokeEnd = time.perf_counter_ns()
        logger = logging.getLogger("time-logger")
        elapsed_time = int((invokeEnd - invokeBegin) / 1000) # we don't need nano-second measuring, but the accuracy of the timer is nice.
        logger.info("{:<30} executed in {:>10,} microseconds".format(f.__qualname__, elapsed_time))
        # note, we're not returning anything from Command invocations, as these are meant to be sent over the wire
    return timer_decorator


def makeVSCodeFrameFromFn(frame, functionSymbol):
    sal = frame.find_sal()
    functionSymbolTab = functionSymbol.symtab
    filename = path.basename(functionSymbolTab.filename)
    fullname = functionSymbolTab.fullname()
    line_number = sal.line
    # DebugProtocol.Source
    src = { "name": filename, "path": fullname, "sourceReference": 0 }
    stackStart = frame.read_register("rbp")
    sf = {
        "id": 0,
        "source": src,
        "line": line_number,
        "column": 0,
        "name": "{}".format(functionSymbol.name),
        "address": frame.pc(),
        "stackAddressStart": int(stackStart),
    }
    return sf

def makeVSCodeFrameNoAssociatedFnName(name, frame):
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
        "id": 0,
        "source": src,
        "line": line_number,
        "column": 0,
        "name": name,
        "address": frame.pc(),
        "stackAddressStart": int(stackStart),
    }
    return sf

class GetTopFrame(gdb.Command):
    def __init__(self):
        super(GetTopFrame, self).__init__("gdbjs-get-top-frame", gdb.COMMAND_USER)
        self.name = "get-top-frame"

    @time_command_invocation
    def invoke(self, threadId, from_tty):
        gdb.execute("thread {}".format(threadId))
        frame = gdb.newest_frame()
        try:
            res = makeVSCodeFrameFromFn(frame, frame.function())
            output(self.name, res)
        except:
            output(self.name, None)


getTopFrameCommand = GetTopFrame()

class StackFrameRequest(gdb.Command):
    def __init__(self):
        super(StackFrameRequest, self).__init__("gdbjs-request-stackframes", gdb.COMMAND_USER)
        self.name = "request-stackframes"

    @time_command_invocation
    def invoke(self, arguments, from_tty):
        [threadId, start, levels] = parseStringArgs(arguments)
        threadId = int(threadId)
        levels = int(levels)
        start = int(start)
        currentFrame = gdb.selected_frame()
        logging.info("selecting frame level {} and getting {} more frames for thread {}".format(start, levels, threadId))
        try:
            selectThreadAndFrame(threadId, start)
            f = gdb.selected_frame()
            result = []
            try:
                for x in range(levels + 1):
                    fn = f.function()
                    if fn is not None:
                        item = makeVSCodeFrameFromFn(f, f.function())
                        result.append(item)
                    else:
                        logging.info("Frame does not have a function associated with it: {}: {}".format(f.name(), f))
                        item = makeVSCodeFrameNoAssociatedFnName(f.name(), f)
                        result.append(item)
                    f = f.older()
            except Exception as e:
                logging.info("Stack trace build exception for frame {}: {}".format(start + x, e))
            output(self.name, result)
            currentFrame.select()
        except:
            # means selectThreadAndFrame failed; we have no frames from `start` and down
            output(self.name, [])

stackFrameRequestCommand = StackFrameRequest()
