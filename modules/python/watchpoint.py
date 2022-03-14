import gdb

class SetWatchPoint(gdb.Command):
    def __init__(self):
        super(SetWatchPoint, self).__init__("gdbjs-watchpoint", gdb.COMMAND_USER)
        self.name = "watchpoint"

    def invoke(self, args, from_tty):
        [type, expression] = parseStringArgs(args)
        misc_logger.error("set wp for {} and {}".format(type, expression))
        if type == "access":
            gdb.execute(f"awatch -l {expression}")
        elif type == "read":
            gdb.execute(f"rwatch -l {expression}")
        elif type == "write":
            gdb.execute(f"watch -l {expression}")
        else:
            raise RuntimeError("Unknown watchpoint class")
        bp = gdb.breakpoints()[-1]
        output(self.name, { "number": bp.number })

setWatchPointCommand = SetWatchPoint()

