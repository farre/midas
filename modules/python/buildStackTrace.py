from mimetypes import init
import gdb
import sys
import json
import gdb.types
import traceback
import logging
import time
from os import path

def make_vs_frame(frame):
    sal = frame.find_sal()
    sym = sal.symtab
    logging.info("Frame {}\n\tFunction: {}".format(frame, frame.function()))
    filename = path.basename(sym.filename)
    fullname = sym.fullname()
    line_number = sal.line
    # DebugProtocol.Source
    src = { "name": filename, "path": fullname, "sourceReference": 0 }
    stackStart = frame.read_register("rbp")
    sf = {
        "id": 0,
        "source": src,
        "line": line_number,
        "column": 0,
        "name": "{}".format(frame.function().name),
        "address": "0x{:X}".format(frame.pc()),
        "stackStartAddress": "{}".format(stackStart),
    }
    return sf

def make_vs_frame_from_fn(frame, functionSymbol):
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
        "stackStartAddress": "{}".format(stackStart),
    }
    return sf

class StackFrameManager:
    def __init__(self, threadId):
        self.threadId = threadId
        self.stack = []

    def set(self, frames):
        self.stack = frames

    def seek_pop(self, stackStart, functionName):
        index = 0
        for frame in self.stack:
            if frame["name"] == functionName and frame["address"] == stackStart:
                self.stack = self.stack[index:]
                break
        return index


threads = {}
threads[1] = StackFrameManager(1)

class GetTopFrame(gdb.Command):
    def __init__(self):
        super(GetTopFrame, self).__init__("gdbjs-get-top-frame", gdb.COMMAND_USER)
        self.name = "get-top-frame"

    def invoke(self, threadId, from_tty):
        gdb.execute("thread {}".format(threadId))
        selectThreadAndFrame(int(threadId), 0)
        frame = gdb.newest_frame()
        try:
            res = make_vs_frame_from_fn(frame, frame.function())
            output(self.name, res)
        except:
            output(self.name, None)


getTopFrameCommand = GetTopFrame()


class StackFrameRequest(gdb.Command):
    def __init__(self):
        super(StackFrameRequest, self).__init__("gdbjs-request-stackframes", gdb.COMMAND_USER)
        self.name = "request-stackframes"

    def invoke(self, arguments, from_tty):
        [threadId, start, levels] = parseStringArgs(arguments)
        threadId = int(threadId)
        levels = int(levels)
        start = int(start)
        currentFrame = gdb.selected_frame()
        try:
            selectThreadAndFrame(threadId, start)
        except:
            output(self.name, [])
            return

        result = []
        f = gdb.selected_frame()
        try:
            for x in range(levels + 1):
                fn = f.function()
                if fn is not None:
                    # result.append(make_vs_frame(f))
                    item = make_vs_frame_from_fn(f, f.function())
                    result.append(item)
                f = f.older()
        except Exception as e:
            logging.info("Stack trace build exception: {}".format(e))
        output(self.name, result)
        currentFrame.select()

stackFrameRequestCommand = StackFrameRequest()
