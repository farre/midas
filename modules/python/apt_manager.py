import apt
import apt_pkg
import apt.progress.base
import apt.progress
import os
import json
import socket
import signal

pid = os.getpid()
ppid = os.getppid()

USER_CANCELLED = False
install_begun = False

# we install a signal handler for SIGUSR1, that we call from Midas (with sudo)
def sig(sig, frame):
  global USER_CANCELLED
  USER_CANCELLED = True

signal.signal(signal.SIGUSR1, sig)

def did_cancel():
  global USER_CANCELLED
  return USER_CANCELLED

RR_REQUIRED_DEPENDENCIES = ["ccache", "cmake", "make", "g++-multilib", "gdb", "pkg-config", "coreutils", "python3-pexpect", "manpages-dev", "git", "ninja-build", "capnproto", "libcapnp-dev", "zlib1g-dev"]
comms_address = "/tmp/rr-build-progress"

TEST_PKGS = [
  "libmbedx509-1",
  "libb2-1",
  "libfdk-aac2",
  "libmbedcrypto7",
  "libmbedtls14",
  "libqt6core6",
  "libqt6dbus6",
  "libqt6gui6",
  "libqt6network6",
  "libqt6opengl6",
  "libqt6qml6",
  "libqt6qmlmodels6",
  "libqt6quick6",
  "libqt6svg6",
  "libqt6waylandclient6",
  "libqt6waylandcompositor6",
  "libqt6waylandeglclienthwintegration6",
  "libqt6waylandeglcompositorhwintegration6",
  "libqt6widgets6",
  "libqt6wlshellintegration6",
  "libqt6xml6",
  "libts0",
  "qt6-gtk-platformtheme",
  "qt6-qpa-plugins",
  "qt6-wayland",
  "obs-studio",
]

class MidasReport():
  def __init__(self, action, socket):
    self.action = action
    self.socket = socket
    self.socket.connect(comms_address)

  def report_to_midas(self, json_like):
    """ Reports to Midas the progress as a JSON packet { package: name, progress: percent } """
    payload = json.dumps(json_like).encode("UTF-8")
    self.socket.send(payload)
    self.socket.send(b"\n")

  def report(self, type, data=None):
    self.report_to_midas({"type": type, "action": self.action, "data": data})

install_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
fetch_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)

class MidasInstallProgress(apt.progress.base.InstallProgress, MidasReport):
  def __init__(self, socket):
    MidasReport.__init__(self, "install", socket)
    self.last_known_progress = 0

  def conffile(self, current: str, new: str) -> None:
    self.report("conffile", { "current": current, "new": new })

  def error(self, pkg: str, errormsg: str) -> None:
    self.report("error", { "package": pkg, "msg": errormsg })

  def processing(self, pkg: str, stage: str) -> None:
    self.report("processing", { "package": pkg, "stage": stage })

  def dpkg_status_change(self, pkg: str, status: str) -> None:
    self.report("dpkg", { "package": pkg, "status": status })

  def status_change(self, pkg: str, percent: float, status: str) -> None:
    if did_cancel():
      self.report("cancel", "start")
      raise Exception
    increment = percent - self.last_known_progress
    self.last_known_progress = percent
    self.report("update", { "package": pkg, "progress": percent, "increment": increment })

  def start_update(self) -> None:
    global install_begun
    install_begun = True
    self.report("start")

  def finish_update(self) -> None:
    self.report("finish")

class MidasFetchProgress(apt.progress.base.AcquireProgress, MidasReport):
  def __init__(self, socket, packages, total_download_bytes):
    MidasReport.__init__(self, "download", socket)
    self.total_required = total_download_bytes
    self.packages = packages
    self.last_known_progress = 0
    self.report("setup", {"pid": pid, "ppid": ppid})
    self.was_cancelled = False

  def done(self, item: apt_pkg.AcquireItemDesc) -> None:
    done_package = item.shortdesc
    self.report("done", { "done": done_package })

  def fail(self, item: apt_pkg.AcquireItemDesc) -> None:
    self.report("error", { "package": item.shortdesc })

  def fetch(self, item: apt_pkg.AcquireItemDesc) -> None:
    return super().fetch(item)

  def ims_hit(self, item: apt_pkg.AcquireItemDesc) -> None:
    return super().ims_hit(item)

  def media_change(self, media: str, drive: str) -> bool:
    return super().media_change(media, drive)

  def pulse(self, owner: apt_pkg.Acquire) -> bool:
    if did_cancel():
      self.was_cancelled = True
      self.report("cancel", "start")
      return False
    download_progress = round((self.current_bytes / self.total_required) * 100.0, 2)
    increment = download_progress - self.last_known_progress
    self.last_known_progress = download_progress
    self.report("update", { "bytes": self.current_bytes, "progress": download_progress, "increment": increment })
    return super().pulse(owner)

  def start(self) -> None:
    self.report("start", { "packages": self.packages, "bytes" : self.total_required })
    return super().start()

  def stop(self) -> None:
    if not self.was_cancelled:
      self.report("finish", { "bytes" : self.current_bytes })
    return super().stop()

cache = apt.Cache()
cache.update()
cache.open()

packages = []

for package in TEST_PKGS:
  pkg = cache[package]
  if not pkg.is_installed:
    pkg.mark_install()
    packages.append(package)

fetch_progress = MidasFetchProgress(socket=fetch_socket, packages=packages, total_download_bytes=cache.required_download)
install_progress = MidasInstallProgress(socket=install_socket)

try:
  cache.commit(fetch_progress=fetch_progress, install_progress=install_progress)
except Exception as e:
  cache.close()
  # installerProgress send kill `pidof this`, which sends a signal that interrupts this script
  # causing it to throw. We don't even need two-way communication
  cache = apt.Cache()
  cache.update()
  cache.open()
  for package in packages:
    pkg = cache[package]
    pkg.mark_delete()
  cache.commit()
  cache.close()
  action = "download" if not install_begun else "install"
  payload_data = {"type": "cancel", "action": action, "data": "done" }
  payload = json.dumps(payload_data).encode("UTF-8")
  if not install_begun:
    fetch_socket.send(payload)
    fetch_socket.send(b"\n")
  else:
    install_socket.send(payload)
    install_socket.send(b"\n")

  fetch_socket.close()
  install_socket.close()