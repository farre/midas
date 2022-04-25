import gdb
import config
import midas_utils


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


# todo(simon): make watch-variable request take a `STOP` parameter;
#  this is so that we can say from VSCode that we want to watch for a variable up to scope `SCOPE`
#  this is for performance reasons; if we're watching a variable that we know is not a global, then the user should
#  be able to say that, that way we won't scan the entire scope every time which can be pretty costly.


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
            it = find_variable(frame, components[0])
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
                sf = ec.get_stackframe(frameId)
                v = sf.add_watched_variable(expr, it)
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
