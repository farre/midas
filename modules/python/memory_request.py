import gdb
import base64

from os import path
import midas_utils
import config


class ReadMemoryRequest(gdb.Command):

    def __init__(self):
        super(ReadMemoryRequest, self).__init__("gdbjs-read-memory", gdb.COMMAND_USER)
        self.name = "read-memory"

    @config.timeInvocation
    def invoke(self, args, from_tty):
        [memoryReference, offset, count] = midas_utils.parse_command_args(args, str, int, int)
        addr = int(memoryReference, base=16) + offset
        view = gdb.selected_inferior().read_memory(address=addr, length=count)
        result = base64.b64encode(view).decode("ASCII")
        midas_utils.send_response(self.name, {"address": memoryReference, "data": result }, midas_utils.prepare_command_response)
