import gdb
import midas_utils
import config

# serializes string input according to the gdb protocol
def gdb_protocol_serialize(string):
    result = ""
    pos = 0
    for curr_char in string:
        result += format(ord(curr_char), '02x')
    return result

# serializes command
def prepare_command(command):
  return "maint packet qRRCmd:{}".format(gdb_protocol_serialize(command))

def gdb_protocol_deserialize(result):
    result = result.split("received: ")[1]
    return bytearray.fromhex(result.replace('"', "")).decode()


class SetCheckpointRequest(gdb.Command):

    def __init__(self):
      super(SetCheckpointRequest, self).__init__("gdbjs-rr-checkpoint", gdb.COMMAND_USER)
      self.name = "rr-checkpoint"

    def invoke(self, arg, from_tty):
      frame = gdb.newest_frame()
      sal = frame.find_sal()
      where = "{}:{}".format(sal.symtab.filename, sal.line)
      cmd = prepare_command("checkpoint")
      cmd_with_params = "{}:{}".format(cmd, gdb_protocol_serialize(where))
      result = gdb.execute(cmd_with_params, to_string=True)
      result = gdb_protocol_deserialize(result)
      if " at " in result:
        midas_utils.send_response(self.name, {"checkpoint-set": True }, midas_utils.prepare_command_response)
      else:
        midas_utils.send_response(self.name, {"checkpoint-set": False }, midas_utils.prepare_command_response)


class InfoCheckpoints(gdb.Command):

    def __init__(self):
      super(InfoCheckpoints, self).__init__('gdbjs-rr-info-checkpoints', gdb.COMMAND_USER)
      self.name = "rr-info-checkpoints"

    def invoke(self, arg, from_tty):
      try:
        cmd = prepare_command("info checkpoints")
        result = gdb.execute(cmd, to_string=True)
        result = gdb_protocol_deserialize(result)
        fromRepl = bool(arg)
        if fromRepl:
          midas_utils.send_response(self.name, result.replace("\n", "\n\r"), midas_utils.prepare_command_response)
        else:
          try:
            cps = result.splitlines()[1:]
            result = []
            for cp_line in cps:
              [id, when, where] = cp_line.split("\t")
              sep = where.rfind(":")
              path = where[0:sep]
              line = where[(sep+1):]
              result.append({"id": id, "when": when, "where": { "path": path, "line": line }})
            midas_utils.send_response(self.name, {"checkpoints": result }, midas_utils.prepare_command_response)
          except Exception as e:
            midas_utils.send_response(self.name, {"checkpoints": [] }, midas_utils.prepare_command_response)
            raise e
      except Exception as e:
        config.error_logger().error("Failed to invoke info checkpoints command: {}".format(e))
        raise e

class DeleteCheckpoint(gdb.Command):

    def __init__(self):
        super(DeleteCheckpoint, self).__init__('gdbjs-rr-delete-checkpoint', gdb.COMMAND_USER)
        self.name = "rr-delete-checkpoints"

    def invoke(self, arg, from_tty):
        # we must stop here; otherwise rr crashes.
        if len(arg) == 0:
          midas_utils.send_response(self.name, False, midas_utils.prepare_command_response)
        cmd = prepare_command("delete checkpoint")
        cmd_with_param = "{}:{}".format(cmd, gdb_protocol_serialize(arg))
        result = gdb.execute(cmd_with_param, to_string=True)
        midas_utils.send_response(self.name, True, midas_utils.prepare_command_response)


class RRWhen(gdb.Command):

    def __init__(self):
      super(RRWhen, self).__init__("gdbjs-rr-when", gdb.COMMAND_USER)
      self.name = "rr-when"

    def invoke(self, arg, from_tty):
      cmd = prepare_command("when")
      result = gdb.execute(cmd, to_string=True)
      result = gdb_protocol_deserialize(result)
      if arg is None or len(arg) == 0:
        first_whitespace = result.rfind(" ")
        evt = result[(first_whitespace+1):]
        midas_utils.send_response(self.name, { "event": evt }, midas_utils.prepare_command_response)
      else:
        midas_utils.send_response(self.name, result, midas_utils.prepare_command_response)