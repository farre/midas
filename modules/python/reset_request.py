import gdb
import execution_context
import midas_utils
import config

class ResetStateRequest(gdb.Command):
    def __init__(self, executionContexts, variableReferenceCounter, variableReferences):
        super(ResetStateRequest, self).__init__("gdbjs-reset-request", gdb.COMMAND_USER)
        self.name = "reset-request"
        self.executionContexts: dict[int, execution_context.ExecutionContext] = executionContexts
        self.variableReferenceCounter = variableReferenceCounter
        self.variableReferences = variableReferences

    @config.timeInvocation
    def invoke(self, args, from_tty):
        gdb.execute("interrupt")
        self.executionContexts = {}
        self.variableReferences = config.VariableReferenceMap()
        self.variableReferenceCounter = 0
        config.currentExecutionContext = execution_context.CurrentExecutionContext()
        midas_utils.send_response(self.name, {"ok": True}, midas_utils.prepare_command_response)