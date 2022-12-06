import apt
import apt_pkg
import apt.progress.base
import apt.progress
import apt.cache
import json
import signal

import midas_report

USER_CANCELLED = False
install_begun = False
comms_address = "/tmp/rr-build-progress"

# we install a signal handler for SIGUSR1, that we call from Midas (with sudo)
def sig(sig, frame):
  global USER_CANCELLED
  USER_CANCELLED = True
  midas_report.get_logger().debug("User cancelled!")

signal.signal(signal.SIGUSR1, sig)
signal.signal(signal.SIGUSR2, sig)

def did_cancel():
  global USER_CANCELLED
  return USER_CANCELLED

class MidasInstallProgress(apt.progress.base.InstallProgress, midas_report.MidasReport):
  def __init__(self, socket):
    midas_report.MidasReport.__init__(self, "install", socket)
    apt.progress.base.InstallProgress.__init__(self)
    self.last_known_progress = 0

  def conffile(self, current: str, new: str) -> None:
    super().conffile(current, new)
    self.report("conffile", { "current": current, "new": new })

  def error(self, pkg: str, errormsg: str) -> None:
    super().error(pkg,errormsg)
    self.report("error", { "package": pkg, "msg": errormsg })

  def processing(self, pkg: str, stage: str) -> None:
    super().processing(pkg=pkg,stage=stage)
    self.report("processing", { "package": pkg, "stage": stage })

  def dpkg_status_change(self, pkg: str, status: str) -> None:
    super().dpkg_status_change(pkg=pkg, status=status)
    midas_report.get_logger().debug("pkg: {} - status: {}".format(pkg, status))
    self.report("dpkg", { "package": pkg, "status": status })

  def status_change(self, pkg: str, percent: float, status: str) -> None:
    super().status_change(pkg=pkg, percent=percent, status=status)
    if did_cancel():
      self.report("cancel", "start")
      raise Exception
    increment = percent - self.last_known_progress
    self.last_known_progress = percent
    self.report("update", { "package": pkg, "increment": increment })

  def start_update(self) -> None:
    super().start_update()
    global install_begun
    install_begun = True
    self.report("start")

  def finish_update(self) -> None:
    super().finish_update()
    self.report("finish")

class MidasFetchProgress(apt.progress.base.AcquireProgress, midas_report.MidasReport):
  def __init__(self, socket, packages: list[str], total_download_bytes: int):
    midas_report.MidasReport.__init__(self, "download", socket)
    self.total_required = total_download_bytes
    self.packages = packages
    self.last_known_progress = 0
    self.was_cancelled = False

  def done(self, item: apt_pkg.AcquireItemDesc) -> None:
    super().done(item)
    done_package = item.shortdesc
    self.report("done", { "done": done_package })

  def fail(self, item: apt_pkg.AcquireItemDesc) -> None:
    super().fail(item)
    self.report("error", { "package": item.shortdesc })

  def fetch(self, item: apt_pkg.AcquireItemDesc) -> None:
    return super().fetch(item)

  def ims_hit(self, item: apt_pkg.AcquireItemDesc) -> None:
    return super().ims_hit(item)

  def media_change(self, media: str, drive: str) -> bool:
    return super().media_change(media, drive)

  def pulse(self, owner: apt_pkg.Acquire) -> bool:
    super().pulse(owner)
    if did_cancel():
      self.was_cancelled = True
      self.report("cancel", "start")
      return False
    download_progress = round((self.current_bytes / self.total_required) * 100.0, 2)
    increment = download_progress - self.last_known_progress
    self.last_known_progress = download_progress
    self.report("update", { "bytes": self.current_bytes, "progress": download_progress, "increment": increment })
    return True

  def start(self) -> None:
    super().start()
    self.report("start", { "packages": self.packages, "bytes" : self.total_required })

  def stop(self) -> None:
    super().stop()
    if not self.was_cancelled:
      self.report("finish", { "bytes" : self.current_bytes })

fetch_socket = midas_report.MidasSocket(comms_address)
install_socket = midas_report.MidasSocket(comms_address)
DEPS = install_socket.wait_for_packages()

cache = apt.Cache()
cache.update()
cache.open()

for package in DEPS:
  pkg = cache[package]
  if not pkg.is_installed:
    pkg.mark_install()

packages = [x.name for x in cache.get_changes()]

fetch_progress = MidasFetchProgress(socket=fetch_socket, packages=packages, total_download_bytes=cache.required_download)
install_progress = MidasInstallProgress(socket=install_socket)

try:
  cache.commit(fetch_progress=fetch_progress, install_progress=install_progress)
except Exception as e:
  midas_report.get_logger().debug("Exception or cancelled operation. {} Message: {}".format(type(e), e))
  resolver = apt.cache.ProblemResolver(cache)
  midas_report.get_logger().debug("Deleting packages...")
  for package in packages:
    pkg = cache[package]
    resolver.remove(pkg)
  midas_report.get_logger().debug("Delete count: {}".format(cache.delete_count))
  cache.commit()
  cache.close()
  action = "download" if not install_begun else "install"
  payload_data = {"type": "cancel", "action": action, "data": "done" }
  payload = json.dumps(payload_data).encode("UTF-8")
  if not install_begun:
    fetch_socket.send_payload(payload)
    fetch_socket.send_payload(b"\n")
  else:
    install_socket.send_payload(payload)
    install_socket.send_payload(b"\n")

  fetch_socket.close()
  install_socket.close()
