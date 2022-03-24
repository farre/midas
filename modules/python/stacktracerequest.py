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
        log = logging.getLogger("update-logger")
        try:
            ec = self.executionContexts.get(threadId)
            if ec is None:
                log.debug("No execution context for this thread. Creating one")
                ec = execution_context.ExecutionContext(threadId)
                self.executionContexts[threadId] = ec
            stack_frames = ec.get_frames(start, levels)
            midas_utils.sendResponse(self.name, stack_frames, midas_utils.prepareCommandResponse)
        except Exception as e:
            # means selectThreadAndFrame failed; we have no frames from `start` and down
            err_logger = logging.getLogger("error-logger")
            config.logExceptionBacktrace(err_logger, "Error occured in StackTraceRequest(threadId={}, start={}, levels={}) {}".format(threadId, start, levels, e), e)
            midas_utils.sendResponse(self.name, [], midas_utils.prepareCommandResponse)