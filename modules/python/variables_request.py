import gdb
from os import path

import midas_utils
import config

class VariableRequest(gdb.Command):
    def __init__(self, executionContexts):
        import execution_context
        super(VariableRequest, self).__init__("gdbjs-variable-request", gdb.COMMAND_USER)
        self.name = "variable-request"
        self.executionContexts: dict[int, execution_context.ExecutionContext] = executionContexts

    @config.timeInvocation
    def invoke(self, variableReference, from_tty):
        try:
            variableReference = int(variableReference)
            refId = config.variableReferences.get_context(variableReference)
            if refId is None:
                raise gdb.GdbError("No refId referenced by {} exists".format(variableReference))
            ec = self.executionContexts.get(refId.threadId)
            if ec is None:
                raise gdb.GdbError("No execution context is referencing {}".format(variableReference))
            sf = ec.get_stackframe(refId.frameId)
            if sf.manages_variable_reference(variableReference):
                res = sf.get(variableReference)
                result = { "variables": res }
                midas_utils.sendResponse(self.name, result, midas_utils.prepareCommandResponse)
            else:
                midas_utils.sendResponse(self.name, { "variables": [] }, midas_utils.prepareCommandResponse)
        except Exception as e:
            config.log_exception(config.error_logger(), "Variable Request failed for variable reference {}: {}".format(variableReference, e), e)
            midas_utils.sendResponse(self.name, { "variables": [] }, midas_utils.prepareCommandResponse)
