import gdb
import json
import logging
import execution_context

from os import path
import midas_utils
import config

class ScopesRequest(gdb.Command):
    def __init__(self, executionContexts):
        super(ScopesRequest, self).__init__("gdbjs-scopes-request", gdb.COMMAND_USER)
        self.name = "scopes-request"
        self.executionContexts: dict[int, execution_context.ExecutionContext] = executionContexts

    @config.timeInvocation
    def invoke(self, frameId, from_tty):
        frameId = int(frameId)
        refId = config.variableReferences.get_context(frameId)
        if refId is None:
            raise gdb.GdbError("No mapping from {} to thread found".format(frameId))
        ec = self.executionContexts.get(refId.threadId)
        if ec is None:
            raise gdb.GdbError("No execution context for thread {} created".format(refId.threadId))

        for sf in ec.stack:
            if sf.frame_id() == frameId:
                midas_utils.sendResponse(self.name, sf.get_scopes(), midas_utils.prepareCommandResponse)
                return

        raise gdb.GdbError("No scopes found for frameId {} in execution context {}".format(frameId, refId.threadId))