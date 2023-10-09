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
    return { "threads": res }


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
    return { "stackFrames": res }


commands["stacktrace"] = stacktrace


def scopes(args):
    global variable_references
    sf = variable_references.get(args["frameId"])
    if sf is None:
        raise gdb.GdbError(f"Failed to get frame with id {args['frameId']}")
    return { "scopes": sf.scopes() }


commands["scopes"] = scopes


def variables(args):
    global variable_references
    container = variable_references.get(args["variablesReference"])
    if container is None:
        raise gdb.GdbError(
            f"Failed to get variablesReference {args['variablesReference']}"
        )
    return { "variables": container.contents() }


commands["variables"] = variables

def continue_(args):
    continueOneThread = args.get("singleThread")
    if continueOneThread is not None and continueOneThread:
      thread = select_thread(args.get("threadId"))
      gdb.post_event(lambda: gdb.execute("continue"))
    else:
      gdb.post_event(lambda: gdb.execute("continue -a"))
    return { "allThreadsContinued": not continueOneThread }

commands["continue"] = continue_

socket_path = generate_socket_path()
event_socket: socket = None
event_connection: socket = None


def event_thread():
    socket_path = "/tmp/midas-events"
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

from io import StringIO

DAPHeader = "Content-Length:"
HeaderLen = len(DAPHeader)

def check_header(header):
    if not header.startswith(DAPHeader):
        raise

def parse_one_request(data) -> (dict, str):
    global DAPHeader
    global HeaderLen
    res = None
    # we expect newlines to be \r\n as per the DA Protocol
    buffer = StringIO(data, "\r\n")
    content_len = None
    header = buffer.readline().strip()
    try:
        check_header(header)
        header_payload = header[HeaderLen:].strip()
        content_len = int(header_payload)
        buffer.readline()
        current = buffer.tell()
        payload = buffer.read(content_len)
        if buffer.tell() - current != content_len:
            raise
        res = json.loads(payload)
        return (res, buffer.read())
    except:
        # No message can be parsed from the current contents of `data`
        return (None, data)    

def start_command_thread():
    global commands
    global seq
    # remove the socket file if it already exists
    command_socket_path = "/tmp/midas-commands"
    try:
        unlink(command_socket_path)
    except OSError:
        if path.exists(command_socket_path):
            raise

    cmd_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    cmd_socket.bind(command_socket_path)
    cmd_socket.listen(1)
    cmd_conn, client_address = cmd_socket.accept()
    buffer = ""
    try:
        while True:
            data = cmd_conn.recv(4096)
            buffer = buffer + data.decode("utf-8")
            req = None
            (req, buffer) = parse_one_request(buffer)
            while req is not None:
                cmd = req.get("command")
                command_handler = commands.get(cmd)
                if command_handler is None:
                    raise gdb.GdbError(
                        f"Unknown DAP request: '{req.get('command')}'. Request: '{json.dumps(req)}' | Buffer: '{buffer}'"
                    )
                success = True
                message = None
                body = None
                try:
                    body = command_handler(req.get("arguments"))
                except Exception as e:
                    success = False
                    message = f"Failed: {traceback.format_exc()}"

                response = json.dumps(
                    prep_response(
                        seq=seq,
                        request_seq=req.get("seq"),
                        success=success,
                        command=cmd,
                        message=message,
                        body=body,
                    )
                )
                cmd_conn.sendall(response)
                (req, buffer) = parse_one_request(buffer)
    finally:
        unlink(command_socket_path)


dap_thread = threading.Thread(target=start_command_thread, name="DAP-Thread")
socket_manager_thread = threading.Thread(target=event_thread, name="Socket Manager")

dap_thread.start()
socket_manager_thread.start()
