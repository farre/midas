import gdb
from os import path
import re

# Copied from the output of `rr gdbinit`

def gdb_unescape(string):
    str_len = len(string)
    if str_len % 2:
        return ""
    result = bytearray()
    try:
        pos = 0
        while pos < str_len:
            hex_char = string[pos:pos+2]
            result.append(int(hex_char, 16))
            pos += 2
    except:
        return ""
    return result.decode('utf-8')

def gdb_escape(string):
    result = ""
    for curr_char in string.encode('utf-8'):
        result += format(curr_char, '02x')
    return result

rr_suppress_run_hook = False

class RRHookRun(gdb.Command):
    def __init__(self):
        gdb.Command.__init__(self, 'rr-hook-run',
                             gdb.COMMAND_USER, gdb.COMPLETE_NONE, False)

    def invoke(self, arg, from_tty):
      thread = int(gdb.parse_and_eval("$_thread"))
      if thread != 0 and not rr_suppress_run_hook:
        gdb.execute("stepi")

class RRSetSuppressRunHook(gdb.Command):
    def __init__(self):
        gdb.Command.__init__(self, 'rr-set-suppress-run-hook',
                             gdb.COMMAND_USER, gdb.COMPLETE_NONE, False)

    def invoke(self, arg, from_tty):
      global rr_suppress_run_hook
      rr_suppress_run_hook = arg == '1'

class RRWhere(gdb.Command):
    """Helper to get the location for checkpoints/history. Used by auto-args"""
    def __init__(self):
        gdb.Command.__init__(self, 'rr-where',
                             gdb.COMMAND_USER, gdb.COMPLETE_NONE, False)

    def invoke(self, arg, from_tty):
        try:
            rv = gdb.execute('frame 0', to_string=True)
        except:
            rv = "???" # This may occurs if we're not running
        m = re.match("#0\w*(.*)", rv);
        if m:
            rv = m.group(1)
        else:
            rv = rv + "???"
        gdb.write(rv)

class RRDenied(gdb.Command):
    """Helper to prevent use of breaking commands. Used by auto-args"""
    def __init__(self):
        gdb.Command.__init__(self, 'rr-denied',
                             gdb.COMMAND_USER, gdb.COMPLETE_NONE, False)

    def invoke(self, arg, from_tty):
        raise gdb.GdbError("Execution of '" + arg + "' is not possible in recorded executions.")



class RRCmd(gdb.Command):
    def __init__(self, name, auto_args):
        gdb.Command.__init__(self, name,
                             gdb.COMMAND_USER, gdb.COMPLETE_NONE, False)
        self.cmd_name = name
        self.auto_args = auto_args

    def invoke(self, arg, from_tty):
        args = gdb.string_to_argv(arg)
        self.rr_cmd(args)

    def rr_cmd(self, args):
        cmd_prefix = "maint packet qRRCmd:" + gdb_escape(self.cmd_name)
        argStr = ""
        for auto_arg in self.auto_args:
            argStr += ":" + gdb_escape(gdb.execute(auto_arg, to_string=True))
        for arg in args:
            argStr += ":" + gdb_escape(arg)
        rv = gdb.execute(cmd_prefix + argStr, to_string=True);
        rv_match = re.search('received: "(.*)"', rv, re.MULTILINE);
        if not rv_match:
            gdb.write("Response error: " + rv)
            return
        response = gdb_unescape(rv_match.group(1))
        if response != '\n':
            gdb.write(response)

# End of copy from `rr gdbinit`

def initialize_rr():
    print("Initializing rr session")
    RRHookRun()
    RRSetSuppressRunHook()
    RRWhere()
    RRDenied()
    RRCmd("when", [])
    RRCmd("when-ticks", [])
    RRCmd("when-tid", [])
    RRCmd("checkpoint", ["rr-where"])
    RRCmd("delete checkpoint", [])
    RRCmd("info checkpoints", [])
    rrinit = f"{path.dirname(path.realpath(__file__))}/rrinit"
    gdb.execute(f"source {rrinit}")