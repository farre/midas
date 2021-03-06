import gdb
import execution_context
import midas_utils
import config


class StackTraceRequest(gdb.Command):

    def __init__(self, executionContexts):
        super(StackTraceRequest, self).__init__("gdbjs-stacktrace-request", gdb.COMMAND_USER)
        self.name = "stacktrace-request"
        self.executionContexts = executionContexts

    @config.timeInvocation
    def invoke(self, arguments, from_tty):
        [threadId, start, levels] = midas_utils.parse_command_args(arguments, int, int, int)
        try:
            ec = self.executionContexts.get(threadId)
            if ec is None:
                thread = None
                for t in gdb.selected_inferior().threads():
                    if t.num == threadId:
                        thread = t
                        break
                ec = execution_context.ExecutionContext(thread)
                self.executionContexts[threadId] = ec
            else:
                if not ec.is_valid():
                    del self.executionContexts[threadId]
                    thread = None
                    for t in gdb.selected_inferior().threads():
                        if t.num == threadId:
                            thread = t
                            break
                    ec = execution_context.ExecutionContext(thread)
                    self.executionContexts[threadId] = ec
            stack_frames = ec.get_frames(start, levels)
            total_frames = ec.get_stack_depth()
            if stack_frames is None:
                stack_frames = []
            result = {"stackFrames": stack_frames, "totalFrames": total_frames}
            midas_utils.send_response(self.name, result, midas_utils.prepare_command_response)
        except Exception as e:
            # means selectThreadAndFrame failed; we have no frames from `start` and down
            err_logger = config.error_logger()
            config.log_exception(
                err_logger, "Error occured in StackTraceRequest(threadId={}, start={}, levels={}) {}".format(
                    threadId, start, levels, e), e)
            midas_utils.send_response(self.name, {"stackFrames": []}, midas_utils.prepare_command_response)
