import gdb
import traceback
from http.server import HTTPServer
from os import path, unlink
import socket
import time

import json
import sys
import random
import string
import threading

from http.server import BaseHTTPRequestHandler


def generate_socket_path():
    return "/tmp/midas-" + "".join(
        random.choice(string.ascii_uppercase) for i in range(10)
    )


stdlibpath = path.dirname(path.realpath(__file__))
if sys.path.count(stdlibpath) == 0:
    sys.path.append(stdlibpath)

from variables_reference import variable_references, StackFrame

def select_thread(threadId):
  for t in gdb.selected_inferior().threads():
      if t.global_num == threadId:
          t.switch()
          return t
  raise gdb.GdbError(f"Found no thread with id {threadId}")

def iterate_frames(frame, count, start=None):
    if start is not None:
        iterated = 0
        while frame is not None and iterated != start:
            frame = frame.older()
            iterated += 1

    while frame is not None and count > 0:
        yield frame
        frame = frame.older()
        count -= 1


commands = {}
seq = 1

def threads_request(args):
    res = []
    for t in gdb.selected_inferior().threads():
        thr_name = "No thread name"
        if t.name is not None:
            thr_name = t.name
        if t.details is not None:
            thr_name = t.details
        res.append({"id": t.global_num, "name": thr_name})
    return res


commands["threads"] = threads_request


def stacktrace(args):
    res = []
    select_thread(args["threadId"])
    for frame in iterate_frames(
                frame=gdb.selected_frame(),
                count=args["levels"],
                start=args.get("start"),
            ):
                sf = StackFrame(frame)
                res.append(sf.contents())
    return res


commands["stacktrace"] = stacktrace


def scopes(args):
    global variable_references
    sf = variable_references.get(args["frameId"])
    if sf is None:
        raise gdb.GdbError(f"Failed to get frame with id {args['frameId']}")
    return sf.scopes()


commands["scopes"] = scopes


def variables(args):
    global variable_references
    container = variable_references.get(args["variablesReference"])
    if container is None:
        raise gdb.GdbError(
            f"Failed to get variablesReference {args['variablesReference']}"
        )

    return container.contents()


commands["variables"] = variables

def continue_(args):
    continueOneThread = args.get("singleThread")
    if continueOneThread is not None and continueOneThread:
      thread = select_thread(args.get("threadId"))
      gdb.execute("continue ")
    else:
      gdb.execute("continue -a")

socket_path = generate_socket_path()
event_socket: socket = None
event_connection: socket = None


def event_thread():
    global socket_path
    global event_socket
    global event_connection

    # remove the socket file if it already exists
    try:
        unlink(socket_path)
    except OSError:
        if path.exists(socket_path):
            raise

    print(f"Opening event socket at {socket_path}")
    event_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    event_socket.bind(socket_path)
    event_socket.listen(1)
    event_connection, client_address = event_socket.accept()
    print(f"Client connected to event socket. Closing thread.")


def prep_response(seq, request_seq, success, command, message=None, body=None):
    return {
        "type": "response",
        "seq": seq,
        "request_seq": request_seq,
        "success": success,
        "command": command,
        "message": message,
        "body": body,
    }


class DAP(BaseHTTPRequestHandler):
    def do_HEAD(self):
        return

    def do_GET(self):
        global socket_path
        if socket_path is None:
            raise Exception("Event socket has not been setup")
        self.send_response(200)
        self.send_header("Content-type", "text/json")
        self.end_headers()
        self.wfile.write(bytes(socket_path, "utf8"))

    def do_POST(self):
        global commands
        global seq
        self.send_response(200)
        self.send_header("Content-type", "text/json")
        self.end_headers()
        len = int(self.headers.get("Content-length"))
        if len is not None and len != 0:
            payload = self.rfile.read(len)
            obj = json.loads(payload)
            cmd = obj.get("command")
            command_handler = commands.get(cmd)
            if command_handler is None:
                raise gdb.GdbError(
                    f"Unknown DAP request: {obj.get('command')}. Request: {json.dumps(obj)} | Payload: '{payload}'"
                )
            success = True
            message = None
            body = None
            try:
                body = command_handler(obj.get("arguments"))
            except Exception as e:
                success = False
                message = f"Failed: {traceback.format_exc()}"

            response = json.dumps(
                prep_response(
                    seq=seq,
                    request_seq=obj.get("seq"),
                    success=success,
                    command=cmd,
                    message=message,
                    body=body,
                )
            )
            self.wfile.write(bytes(response, "utf8"))
            seq += 1


def start_dap_thread():
    HOST_NAME = "localhost"
    PORT_NUMBER = 8000
    httpd = HTTPServer((HOST_NAME, PORT_NUMBER), DAP)
    print(time.asctime(), "Server Starts - %s:%s" % (HOST_NAME, PORT_NUMBER))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    httpd.server_close()


dap_thread = threading.Thread(target=start_dap_thread, name="DAP-Thread")
socket_manager_thread = threading.Thread(target=event_thread, name="Socket Manager")

dap_thread.start()
socket_manager_thread.start()
