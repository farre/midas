from mimetypes import init
import gdb
import sys
import json
import gdb.types
import traceback
import logging
import time
from os import path

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

class GetTopFrame(gdb.Command):
    def __init__(self):
        super(GetTopFrame, self).__init__("gdbjs-get-top-frame", gdb.COMMAND_USER)
        self.name = "get-top-frame"

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
                    item = makeVSCodeFrameFromFn(f, f.function())
                    result.append(item)
                f = f.older()
        except Exception as e:
            logging.info("Stack trace build exception: {}".format(e))
        output(self.name, result)
        currentFrame.select()

stackFrameRequestCommand = StackFrameRequest()
