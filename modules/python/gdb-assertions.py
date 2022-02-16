#
# Commands that are used to validate output in VSCode.
#
# Usage: at a stop, call these commands from the debug console to verify that the output is correct.
# Yes, this is technically user-testing, and not TDD, but you take what you can get. And right now, this is it.
#

class ExecutionContextState:
    def __init__(self, tid, frame):
        self.tid = tid
        self.frame = frame

class CountFrames(gdb.Command):
    def __init__(self):
        super(CountFrames, self).__init__("gdbassert-frames", gdb.COMMAND_USER)
        self.name = "gdbassert-frames"

    def invoke(self, threadId, from_tty):
        # we have to restore execution context state, after running this command
        currentThread = gdb.selected_thread()
        gdb.execute("thread {}".format(threadId))
