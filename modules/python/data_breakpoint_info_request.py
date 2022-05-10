import gdb
import midas_utils
import config

# Resolves full evaluate path since setDataBreakpointRequest has a pretty bad design flaw


class DataBreakpointInfoRequest(gdb.Command):

    def __init__(self, executionContexts):
        super(DataBreakpointInfoRequest, self).__init__("gdbjs-data-breakpoint-info", gdb.COMMAND_USER)
        self.name = "data-breakpoint-info"
        self.executionContexts = executionContexts

    def invoke(self, args, from_tty):
        [name, variableReference] = midas_utils.parse_command_args(args, str, int)
        refId = config.variableReferences.get_context(variableReference)
        if refId is None:
            # todo(simon): this is where we start checking for watch variables, as they are context-independent and re-evaluated in every context that gets selected
            raise gdb.GdbError("No refId referenced by {} exists".format(variableReference))
        ec = self.executionContexts.get(refId.threadId)
        if ec is None:
            raise gdb.GdbError("No execution context is referencing {}".format(variableReference))
        sf = ec.get_stackframe(refId.frameId)
        v = None
        dataId = None
        if refId.frameId == variableReference:
            v = sf.get_variable_by_name(name)
            dataId = name
        else:
            v = sf.get_variable(variableReference)
            if v is not None:
                evalName = v.evaluateName
                v = v.get_member(name)
                dataId = "{}.{}".format(evalName, name)
        body = {
            "dataId":
            dataId,
            "description":
            "Could not resolve {} for variable referece {}".format(name, variableReference) if v is None else "",
            "accessTypes": [
                "read",
                "write",
                "readWrite",
            ],
            "canPersist":
            False
        }
        midas_utils.send_response(self.name, body, midas_utils.prepare_command_response)
