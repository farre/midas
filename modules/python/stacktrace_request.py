import gdb
import json
import logging
import execution_context

from os import path
import midas_utils
import config

class StackTraceRequest(gdb.Command):
    def __init__(self, executionContexts):
        super(StackTraceRequest, self).__init__("gdbjs-stacktrace-request", gdb.COMMAND_USER)
        self.name = "stacktrace-request"
        self.executionContexts = executionContexts

    @config.timeInvocation
    def invoke(self, arguments, from_tty):
        [threadId, start, levels] = midas_utils.parseCommandArguments(arguments)
        threadId = int(threadId)
        levels = int(levels)
        start = int(start)
        try:
            ec = self.executionContexts.get(threadId)
            if ec is None:
                ec = execution_context.ExecutionContext(threadId)
                self.executionContexts[threadId] = ec
            stack_frames = ec.get_frames(start, levels)
            total_frames = ec.get_stack_depth()
            if stack_frames is None:
                stack_frames = []
            result = { "stackFrames": stack_frames, "totalFrames": total_frames }
            midas_utils.sendResponse(self.name, result, midas_utils.prepareCommandResponse)
        except Exception as e:
            # means selectThreadAndFrame failed; we have no frames from `start` and down
            err_logger = config.error_logger()
            config.log_exception(err_logger, "Error occured in StackTraceRequest(threadId={}, start={}, levels={}) {}".format(threadId, start, levels, e), e)
            midas_utils.sendResponse(self.name, {"stackFrames": [] }, midas_utils.prepareCommandResponse)
