import gdb
import config
import midas_utils

"""
        body: {
            result: string;
            type?: string;
            variablesReference: number;
            namedVariables?: number;
            indexedVariables?: number;
            memoryReference?: string;
        }
"""

def response(success, message, result, type=None, variableReference=0, namedVariables=None, indexedVariables=None, memoryReference=None):
    return {
            "body":
                {
                    "result": result,
                    "type": type,
                    "variablesReference": variableReference,
                    "namedVariables": namedVariables,
                    "indexedVariables": indexedVariables,
                    "memoryReference": memoryReference
                },
                "success": success,
                "message": message
            }

class WatchVariable(gdb.Command):
    """Not to be confused with watch point."""
    def __init__(self, executionContexts):
        super(WatchVariable, self).__init__("gdbjs-watch-variable", gdb.COMMAND_USER)
        self.name = "watch-variable"
        self.executionContexts = executionContexts

    @config.timeInvocation
    def invoke(self, args, from_tty):
        try:
            [expr, frameId] = midas_utils.parse_command_args(args, str, int)
            refId = config.variableReferences.get_context(frameId)
            if refId is None:
                raise gdb.GdbError("No variable reference mapping for frame id {} exists".format(frameId))
            ec = self.executionContexts.get(refId.threadId)
            if ec is None:
                raise gdb.GdbError("Execution context does not exist")
            frame = ec.set_known_context(frameId)
            components = expr.split(".")
            it = midas_utils.get_closest(frame, components[0])
            if it is None:
                midas_utils.send_response(self.name,response(result="no symbol with that name in context", success=False, message="could not evaluate"), midas_utils.prepare_command_response)
            else:
                sf = ec.get_stackframe(frameId)
                v = sf.add_watched_variable(expr, it)
                res = v.to_vs()
                result = response(success=True, message=None, result=res["value"], type="{}".format(v.get_type()), variableReference=v.get_variable_reference())
                midas_utils.send_response(self.name, result, midas_utils.prepare_command_response)
        except Exception as e:
            config.log_exception(config.error_logger(), "{} failed: {}".format(self.name, e), e)
            midas_utils.send_response(self.name, response(success=False, message="Could not be evaluated", result=None), midas_utils.prepare_command_response)