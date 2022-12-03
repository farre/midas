import apt
import apt_pkg
import apt.progress.base
import apt.progress
import io
import json
import socket

RR_REQUIRED_DEPENDENCIES = ["ccache", "cmake", "make", "g++-multilib", "gdb", "pkg-config", "coreutils", "python3-pexpect", "manpages-dev", "git", "ninja-build", "capnproto", "libcapnp-dev", "zlib1g-dev"]
comms_address = "/tmp/rr-build-progress"

class MidasInstallProgress(apt.progress.base.InstallProgress):
  def __init__(self):
    super(MidasInstallProgress, self).__init__()
    self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    self.socket.connect(comms_address)

  def conffile(self, current: str, new: str) -> None:
    self.report_to_midas({"type": "conffile", "data": { "current": current, "new": new }})

  def error(self, pkg: str, errormsg: str) -> None:
    self.report_to_midas({"type": "error", "action": "install", "data": { "package": pkg, "msg": errormsg }})

  def processing(self, pkg: str, stage: str) -> None:
    self.report_to_midas({"type": "processing", "data": { "package": pkg, "stage": stage }})

  def dpkg_status_change(self, pkg: str, status: str) -> None:
    self.report_to_midas({"type": "dpkg", "data": { "package": pkg, "status": status }})

  def status_change(self, pkg: str, percent: float, status: str) -> None:
    self.report_to_midas({ "type": "installing", "data": { "package": pkg, "progress": percent } })

  def start_update(self) -> None:
    self.report_to_midas({ "type": "start", "action": "install" })

  def finish_update(self) -> None:
    self.report_to_midas({ "type": "finish", "action": "install" })

  def report_to_midas(self, json_like):
    """ Reports to Midas the progress as a JSON packet { package: name, progress: percent } """
    payload = json.dumps(json_like).encode("UTF-8")
    self.socket.send(payload)
    self.socket.send(b"\n")

class MidasFetchProgress(apt.progress.base.AcquireProgress):
  def __init__(self, packages, total_download_bytes):
    super(MidasFetchProgress, self).__init__()
    self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    self.socket.connect(comms_address)
    self.total_required = total_download_bytes
    self.packages = packages

  def done(self, item: apt_pkg.AcquireItemDesc) -> None:
    done_package = item.shortdesc
    self.report_to_midas({"type": "download", "data": { "done": done_package }})

  def fail(self, item: apt_pkg.AcquireItemDesc) -> None:
    self.report_to_midas({"type": "error", "action": "download", "data": { "package": item.shortdesc }})

  def fetch(self, item: apt_pkg.AcquireItemDesc) -> None:
    return super().fetch(item)

  def ims_hit(self, item: apt_pkg.AcquireItemDesc) -> None:
    return super().ims_hit(item)

  def media_change(self, media: str, drive: str) -> bool:
    return super().media_change(media, drive)

  def pulse(self, owner: apt_pkg.Acquire) -> bool:
    download_progress = round((self.current_bytes / self.total_required) * 100.0, 2)
    self.report_to_midas({ "type": "download", "data": { "bytes": self.current_bytes, "percent": download_progress } })
    return super().pulse(owner)

  def start(self) -> None:
    self.report_to_midas({ "type": "start", "action": "download", "data": { "packages": self.packages, "bytes" : self.total_required } })
    return super().start()

  def stop(self) -> None:
    self.report_to_midas({ "type": "finish", "action": "download", "data": { "bytes" : self.current_bytes } })
    return super().stop()

  def report_to_midas(self, json_like):
    """ Reports to Midas the progress as a JSON packet { package: name, progress: percent } """
    payload = json.dumps(json_like).encode("UTF-8")
    self.socket.send(payload)
    self.socket.send(b"\n")

cache = apt.Cache()
cache.update()
cache.open()

packages = []

for package in TEST_PKGS:
  pkg = cache[package]
  if not pkg.is_installed:
    pkg.mark_install()
    packages.append(package)

cache.commit(fetch_progress=MidasFetchProgress(packages, cache.required_download), install_progress=MidasInstallProgress())