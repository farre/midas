import socket
import json
import sys
import os
import logging
import logging.handlers

COMMS_ADDRESS = "/tmp/rr-build-progress"

def resolveExtensionFile(fileName):
    extensionPath = os.path.dirname(os.path.realpath(__file__))
    return "{}/../../{}".format(extensionPath, fileName)

install_logger_handler = logging.handlers.WatchedFileHandler(resolveExtensionFile("rr-dependency-manager.log"), mode="w")
install_logger_fmt = logging.Formatter(logging.BASIC_FORMAT)
install_logger_handler.setFormatter(install_logger_fmt)

install_logger = logging.getLogger("install-logger")
install_logger.setLevel(logging.DEBUG)
install_logger.addHandler(install_logger_handler)

def get_logger():
    return logging.getLogger("install-logger")

def process_info_payload():
  return { "pid": os.getpid(), "ppid": os.getppid() }

class UserCancelledException(Exception):
  pass

class MidasSocket():
  requested_pkgs = None
  def __init__(self, addr: str) -> None:
    self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    self.socket.connect(addr)

  def close(self):
    self.socket.close()

  def send_payload(self, json_: dict):
    payload = json.dumps(json_).encode("UTF-8")
    get_logger().debug("Sending payload {}".format(payload))
    self.socket.send(payload)
    self.socket.send(b"\n")

  @staticmethod
  def has_received_pkglist_info():
    return MidasSocket.requested_pkgs is not None

  def wait_for_packages(self) -> list[str]:
    get_logger().debug("Waiting for packages...")
    if MidasSocket.has_received_pkglist_info():
      return MidasSocket.requested_pkgs
    header = self.socket.recv(4)
    payload_length = int.from_bytes(header, sys.byteorder)
    buffer = self.socket.recv(payload_length)
    res = buffer.decode("UTF-8").strip()
    get_logger().debug("Received payload: {}".format(res))
    MidasSocket.requested_pkgs = res.split(" ")
    return MidasSocket.requested_pkgs

class MidasReport():
  def __init__(self, action: str, socket: MidasSocket):
    self.action = action
    self.socket = socket
    self.report("setup", process_info_payload())

  def report(self, type, data=None):
    """ Send a report to Midas """
    self.socket.send_payload({"type": type, "action": self.action, "data": data})