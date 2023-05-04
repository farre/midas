import gdb
import midas_utils

def pid(line:str):
  idx = 0
  found_at = 0
  for ch in line:
    if ch == ' ':
        found_at = idx
    elif ch != ' ' and found_at != 0:
        return (line[0:found_at], idx)
    idx += 1
  return None

def user(line: str, next: int):
    idx = next
    found_at = idx
    for ch in line[next:]:
        if ch == ' ':
            found_at = idx
        elif ch != ' ' and found_at != next:
            return (line[next:idx], idx)
        idx += 1
    return None

def command(line: str, start):
    idx = len(line)
    cores_parsed = False
    for ch in reversed(line):
        if ch == ' ' and not cores_parsed:
            cores_parsed = True
        elif ch != ' ' and cores_parsed:
            return line[start:idx]
        idx -= 1
    return None


def process_line(line: str) -> dict:
    (pid_, next) = pid(line)
    (user_, next_) = user(line, next)
    command_ = command(line, next_)
    return { "pid" : pid_.strip(), "user": user_.strip(), "label" : command_.strip() }



class GetAllPids(gdb.Command):
    def __init__(self):
        super(GetAllPids, self).__init__("gdbjs-get-all-pids", gdb.COMMAND_USER)
        self.name = "get-all-pids"

    def invoke(self, args, from_tty):
        res = gdb.execute("info os processes", to_string=True)
        processes = []
        for line in res.splitlines()[1:]:
          proc = process_line(line)
          processes.append(proc)

        midas_utils.send_response(self.name, { "processes": processes }, midas_utils.prepare_command_response)
