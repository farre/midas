import gdb
import config
import midas_utils
from execution_context import ExecutionContext


def response(success,
             message,
             result,
             type=None,
             variableReference=0,
             namedVariables=None,
             indexedVariables=None,
             memoryReference=None):
    return {
        "body": {
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


def find_variable(frame, name):
    """ Find variable by scanning from current block to global returning first found. """
    it = midas_utils.get_closest(frame, name)
    if it is not None:
        return it
    it = midas_utils.get_static(frame, name)
    if it is not None:
        return it
    it = midas_utils.get_global(frame, name)
    return it

class WatchVariable(gdb.Command):
    """Not to be confused with watch point."""

    def __init__(self, executionContexts):
        super(WatchVariable, self).__init__("gdbjs-watch-variable", gdb.COMMAND_USER)
        self.name = "watch-variable"
        self.executionContexts: ExecutionContext = executionContexts

    @config.timeInvocation
    def invoke(self, args, from_tty):
        try:
            [expr, frameId, begin, end, scope] = midas_utils.parse_command_args(args, str, int, int, int, str)
            refId = config.variableReferences.get_context(frameId)
            if refId is None:
                raise gdb.GdbError("No variable reference mapping for frame id {} exists".format(frameId))
            ec = self.executionContexts.get(refId.threadId)
            if ec is None:
                raise gdb.GdbError("Execution context does not exist")
            var = ec.free_floating_watchvariable(expr)
            if var is not None:
                var.start = begin
                var.end = end
                res = var.to_vs()
                result = response(success=True,
                                    message=None,
                                    result=res["value"],
                                    type="{}".format(var.get_type()),
                                    variableReference=var.get_variable_reference())
                midas_utils.send_response(self.name, result, midas_utils.prepare_command_response)
                return

            frame = ec.set_known_context(frameId)
            components = expr.split(".")
            foundFrameId = None
            it = find_variable(frame, components[0])
            if scope == "first" and it is None:
                for sf in ec.stack:
                    it = find_variable(sf.frame, components[0])
                    if it is not None:
                        for comp in components[1:]:
                            it = it[comp]
                            if it is None:
                                break
                        foundFrameId = sf.frame_id()
                    if foundFrameId is not None:
                        # when this stack frame goes out of scope, it removes `expr` free floating variable from ec
                        if begin != -1 and end != -1 and gdb.default_visualizer(it) is None:
                            it = it[begin]
                            bound = max((end - begin) - 1, 0)
                            it = it.cast(it.type.array(bound))
                            expr = "{}[{}:{}]".format(expr, begin, end)
                        elif begin == -1 and end == -1:
                            begin = 0
                            end = None
                        sf = ec.get_stackframe(foundFrameId)
                        var = sf.add_free_floating_watched_variable(expr, it, begin, end)
                        res = var.to_vs()
                        result = response(success=True,
                                    message=None,
                                    result=res["value"],
                                    type="{}".format(var.get_type()),
                                    variableReference=var.get_variable_reference())
                        midas_utils.send_response(self.name, result, midas_utils.prepare_command_response)
                        return
                raise gdb.GdbError("{} Could not be evaluated".format(expr))

            for comp in components[1:]:
                it = it[comp]
                if it is None:
                    break
            if it is None:
                midas_utils.send_response(
                    self.name,
                    response(result="no symbol with that name in context",
                                success=False,
                                message="could not evaluate"), midas_utils.prepare_command_response)
            else:
                if begin != -1 and end != -1 and gdb.default_visualizer(it) is None:
                    it = it[begin]
                    bound = max((end - begin) - 1, 0)
                    it = it.cast(it.type.array(bound))
                    expr = "{}[{}:{}]".format(expr, begin, end)
                elif begin == -1 and end == -1:
                    begin = 0
                    end = None

                sf = ec.get_stackframe(frameId)
                v = sf.add_watched_variable(expr, it, begin, end)
                res = v.to_vs()
                result = response(success=True,
                                  message=None,
                                  result=res["value"],
                                  type="{}".format(v.get_type()),
                                  variableReference=v.get_variable_reference())
                midas_utils.send_response(self.name, result, midas_utils.prepare_command_response)
        except Exception as e:
            config.log_exception(config.error_logger(), "{} failed: {}".format(self.name, e), e)
            midas_utils.send_response(self.name,
                                      response(success=False, message="Could not be evaluated", result=None),
                                      midas_utils.prepare_command_response)
