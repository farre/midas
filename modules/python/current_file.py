import gdb
import execution_context
import midas_utils
import config


class CurrentFileAndLine(gdb.Command):

  def __init__(self):
      super(CurrentFileAndLine, self).__init__("gdbjs-current-file-line", gdb.COMMAND_USER)
      self.name = "current-file-line"

  @config.timeInvocation
  def invoke(self, arguments, from_tty):
    try:
      f = gdb.selected_frame()
      sal = f.find_sal()
      file = sal.symtab.filename
      line = sal.line
      midas_utils.send_response(self.name, {"file": file, "line": line }, midas_utils.prepare_command_response)
    except Exception as e:
      config.error_logger().error("Failed to get current file and line number info for selected frame: {}".format(e))
      midas_utils.send_response(self.name, {"file": None, "line": 0 }, midas_utils.prepare_command_response)
