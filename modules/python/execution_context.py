import gdb
import logging
# Midas Terminology
# Execution Context: Thread (id) and Frame (level)
# Registers the current execution context
import frame_operations
import stackframe
import config
import midas_utils
from variable import Variable

class CurrentExecutionContext:
    inferior = None

    def __init__(self):
        self.threadId = -1
        self.frameLevel = -1
        CurrentExecutionContext.inferior = gdb.selected_inferior()
        self.threads = []

    def set_thread(self, threadId):
        if self.threadId != threadId:
            for t in CurrentExecutionContext.inferior.threads():
                if t.num == threadId:
                    t.switch()
                    self.threadId = t.num
                    return t
        else:
            return gdb.selected_thread()

    def set_frame(self, level):
        if self.frameLevel != int(level):
            level_num = 0
            f = gdb.newest_frame()
            while f is not None and level_num != level:
                f = f.older()
                level_num += 1
            self.frameLevel = level_num
            return f
        else:
            return gdb.selected_frame()

    def set_context(self, threadId, frameLevel):
        t = self.set_thread(threadId=int(threadId))
        f = self.set_frame(level=int(frameLevel))
        return (t, f)

    def add_thread(self, thread):
        self.threads.append(thread)


class ExecutionContext:

    def __init__(self, thread):
        self.thread = thread
        # Hallelujah (ironic) for type info. I miss Rust.
        self.stack: list[stackframe.StackFrame] = []
        self.last_calculated_stack_depth = -1
        self.free_floating_watch_variables = {}

    def free_floating_watchvariable(self, expr) -> Variable:
        return self.free_floating_watch_variables.get(expr)

    @config.timeInvocation
    def set_free_floating(self, expr, var):
        self.free_floating_watch_variables[expr] = var

    @config.timeInvocation
    def set_context(self, frame_level):
        self.thread.switch()
        f = gdb.newest_frame()
        idx = 0
        while f is not None:
            if idx == frame_level:
                f.select()
                return f
            f = f.older()
            idx += 1
        return None

    @config.timeInvocation
    def set_known_context(self, frame_id):
        self.thread.switch()
        for sf in self.stack:
            if sf.frame_id() == frame_id:
                sf.frame.select()
                return sf.frame

    def thread_id(self):
        return self.thread.num

    @config.timeInvocation
    def get_frames(self, start, levels):
        f = self.set_context(start)
        result = []
        try:
            if len(self.stack) > 0:
                if self.stack[0].is_same_frame(f):
                    for sf in self.stack:
                        result.append(sf.get_vs_frame())
                    return result
                res = frame_operations.find_first_identical_frames(self.stack, f, 10)
                if res is not None:
                    (x, newFrames) = res
                    self.stack = self.stack[x:]
                    tmp = self.stack
                    threadId = self.thread_id()
                    self.stack = [stackframe.StackFrame(f, threadId, self) for f in newFrames]
                    self.stack.extend(tmp)
                else:
                    self.clear_frames()
                    threadId = self.thread_id()
                    for frame in frame_operations.take_n_frames(f, levels):
                        sf = stackframe.StackFrame(frame, threadId, self)
                        self.stack.append(sf)
            else:
                threadId = self.thread_id()
                for frame in frame_operations.take_n_frames(f, levels):
                    sf = stackframe.StackFrame(frame, threadId, self)
                    self.stack.append(sf)
        except:
            # stack frame chain was invalidated somewhere. try rebuilding it.
            self.stack = []
            threadId = self.thread_id()
            for frame in frame_operations.take_n_frames(f, levels):
                sf = stackframe.StackFrame(frame, threadId, self)
                self.stack.append(sf)

        if len(self.stack) < start + levels:
            remainder = (start + levels) - len(self.stack)
            threadId = self.thread_id()
            for frame in frame_operations.take_n_frames(self.stack[-1].frame.older(), remainder):
                sf = stackframe.StackFrame(frame, threadId, self)
                self.stack.append(sf)
        for sf in self.stack:
            result.append(sf.get_vs_frame())
        return result

    @config.timeInvocation
    def get_stack_depth(self):
        if self.last_calculated_stack_depth != -1:
            if self.stack[0].is_same_frame(gdb.newest_frame()):
                return self.last_calculated_stack_depth

        last_visited = self.stack[-1]
        count = len(self.stack)
        f = last_visited.frame.older()
        while f is not None:
            count += 1
            f = f.older()
        self.last_calculated_stack_depth = count
        return count

    def get_stackframe(self, frameId) -> stackframe.StackFrame:
        for sf in self.stack:
            if sf.frame_id() == frameId:
                return sf
        return None

    def clear_frames(self):
        self.stack.clear()

    def is_valid(self):
        return self.thread.is_valid()


class InvalidateExecutionContext(gdb.Command):

    def __init__(self, executionContexts):
        super(InvalidateExecutionContext, self).__init__("gdbjs-thread-died", gdb.COMMAND_USER)
        self.name = "thread-died"
        self.executionContexts = executionContexts

    @config.timeInvocation
    def invoke(self, args, from_tty):
        try:
            [threadId] = midas_utils.parse_command_args(args, str)
            del self.executionContexts[threadId]
        except Exception as e:
            err_logger = config.error_logger()
            config.log_exception(err_logger, "Removing execution context failed: {}".format(e), e)
        midas_utils.send_response(self.name, {"ok": True}, midas_utils.prepare_command_response)
