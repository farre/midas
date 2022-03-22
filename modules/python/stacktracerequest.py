import gdb
import json
import config
import logging

from os import path
from midas_utils import logExceptionBacktrace, prepareCommandResponse, parseCommandArguments, sendResponse, timeInvocation

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
                ec = config.ExecutionContext(threadId)
                config.executionContexts[threadId] = ec
            stack_frames = ec.get_frames(start, levels)
            logging.getLogger("update-logger").debug(json.dumps(stack_frames, ensure_ascii=False))
            sendResponse(self.name, stack_frames, prepareCommandResponse)
        except Exception as e:
            # means selectThreadAndFrame failed; we have no frames from `start` and down
            err_logger = logging.getLogger("error-logger")
            logExceptionBacktrace(err_logger, "Error occured in StackTraceRequest: {}".format(e), e)
            sendResponse(self.name, [], prepareCommandResponse)
