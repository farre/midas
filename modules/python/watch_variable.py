from pydoc import resolve
import gdb

import config as config
from midas_utils import parse_command_args, timeInvocation, getClosest, resolve_gdb_value

class WatchVariable(gdb.Command):
    """Not to be confused with watch point."""
    def __init__(self):
        super(WatchVariable, self).__init__("gdbjs-watch-variable", gdb.COMMAND_USER)
        self.name = "watch-variable"

    @timeInvocation
    def invoke(self, args, from_tty):
        [expr, threadId, frameLevel] = parse_command_args(args)
        (thread, frame) = config.currentExecutionContext.set_context(threadId=threadId, frameLevel=frameLevel)
        components = expr.split(".")
        it = getClosest(frame, components[0])
        it = resolve_gdb_value(it, components=components[1:])
        pp = gdb.default_visualizer(it)
        if pp is None:
            0
        else:
            0

