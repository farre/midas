import gdb
import logging
# Midas Terminology
# Execution Context: Thread (id) and Frame (level)
# Registers the current execution context
import frame_operations
import stackframe
import config

class CurrentExecutionContext:
    inferior = None
    def __init__(self):
        self.threadId = -1
        self.frameLevel = -1
        CurrentExecutionContext.inferior = gdb.selected_inferior()

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
            gdb.execute("frame {}".format(level))
            frame = gdb.selected_frame()
            self.frameLevel = frame.level()
            return frame
        else:
            return gdb.selected_frame()

    def set_context(self, threadId, frameLevel):
        t = self.set_thread(threadId=int(threadId))
        f = self.set_frame(level=int(frameLevel))
        return (t, f)

class ExecutionContext:
    def __init__(self, threadId):
        self.threadId: int = threadId
        # Hallelujah (ironic) for type info. I miss Rust.
        self.stack: list[stackframe.StackFrame] = []

    def get_frames(self, start, levels):
        (t, f) = config.currentExecutionContext.set_context(self.threadId, start)
        result = []
        if len(self.stack) > 0:
            if self.stack[0].is_same_frame(f):
                for sf in self.stack:
                    result.append(sf.get_vs_frame())
                return result
            res = frame_operations.find_first_identical_frames(self.stack, f, 10)
            if res is not None:
                (x, y) = res
                if x < y:
                    frames_to_add = [f for f in frame_operations.take_n_frames(f, y - x)]
                    for f in reversed(frames_to_add):
                        sf = stackframe.StackFrame(f, self.threadId)
                        self.stack.insert(0, sf)
                elif x > y:
                    self.stack = self.stack[y:]
                    if len(self.stack) < start + levels:
                        remainder = (start + levels) - len(self.stack)
                        for frame in frame_operations.take_n_frames(self.stack[-1].frame, remainder):
                            sf = stackframe.StackFrame(f, self.threadId)
                            self.stack.append(sf)
                else:
                    raise gdb.GdbError("This should not be possible.")
            else:
                self.clear_frames()
                for frame in frame_operations.take_n_frames(f, levels):
                    sf = stackframe.StackFrame(frame, self.threadId)
                    self.stack.append(sf)
        else:
            for frame in frame_operations.take_n_frames(f, levels):
                sf = stackframe.StackFrame(frame, self.threadId)
                self.stack.append(sf)
        for sf in self.stack:
            result.append(sf.get_vs_frame())
        return result

    def get_stackframe(self, frameId) -> stackframe.StackFrame:
        for sf in self.stack:
            if sf.frame_id() == frameId:
                return sf
        return None

    def clear_frames(self):
        self.stack.clear()
