"""the config module holds settings for Midas but it also keeps global state for the backend."""

import gdb
global isDevelopmentBuild
global setTrace
global executionContext

isDevelopmentBuild = False
setTrace = False

# Midas Terminology
# Execution Context: Thread (id) and Frame (level)

# Registers the current execution context
class ExecutionContextRegister:
    inferior = None
    def __init__(self):
        self.threadId = -1
        self.frameLevel = -1
        ExecutionContextRegister.inferior = gdb.selected_inferior()

    def set_thread(self, threadId):
        if self.threadId != threadId:
            for t in ExecutionContextRegister.inferior.threads():
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

executionContext = ExecutionContextRegister()