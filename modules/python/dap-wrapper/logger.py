import time
import json
import traceback
from os import path
import sys

stdlibpath = path.dirname(path.realpath(__file__))
if sys.path.count(stdlibpath) == 0:
    sys.path.append(stdlibpath)

this = sys.modules[__name__]


class LogFile:
    def __init__(self, name):
        global stdlibpath
        self.name = name
        self.path = f"{stdlibpath}/{name}"
        self.file = open(self.path, "w")

    def log(self, msg):
        self.file.write(msg)

    def close(self):
        print(f"Flushing contents to {self.path}")
        self.file.flush()
        self.file.close()


class Logger:
    def __init__(self):
        self.perf = None
        self.debug = None
        self.custom = {}

    def init_custom(self, log_name):
        self.custom[log_name] = LogFile(log_name)

    def init_perf_log(self, log_name):
        self.perf = LogFile(log_name)

    def init_debug_log(self, log_name):
        self.debug = LogFile(log_name)

    def log_request(self, fn, args):
        if self.debug is not None:
            self.debug.log(msg=f"[req]: [{fn}] <- {json.dumps(args)}\n")

    def log_response(self, fn, res):
        if self.debug is not None:
            self.debug.log(msg=f"[res]: [{fn}] -> {json.dumps(res)}\n")

    def log_exception(self, fn, exc):
        if self.debug is not None:
            self.debug.log(
                msg=f"[req exception]: [{fn}] -> {exc}\nStacktrace:\n{traceback.format_exc()}"
            )

    def log_to(self, custom, msg):
        log = self.custom.get(custom)
        print(f"custom={msg}")
        if log is not None:
            log.log(msg)

    def log_msg(self, msg):
        if self.debug is not None:
            self.debug.log(msg)

    def perf_log(self, fn, msg):
        start = time.perf_counter_ns()
        res = fn()
        end = time.perf_counter_ns()
        self.perf.log(msg=f"[{msg}]: {(end-start) / (1000 * 1000)} ms\n")
        return res

    def atexit(self):
        self.perf.close()
        self.debug.close()
        for log in self.custom.values():
            log.close()


if not hasattr(this, "logger"):
    this.logger = Logger()

import atexit
def clean_up():
    print("Closing & flushing potential logs")
    global this
    this.logger.atexit()


atexit.register(clean_up)