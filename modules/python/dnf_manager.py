from midas_report import get_logger, MidasReport, MidasSocket, COMMS_ADDRESS
import dnf, dnf.base, dnf.callback, dnf.package, dnf.exceptions, dnf.transaction
import platform
import signal
from functools import reduce

USER_CANCELLED = False

# we install a signal handler for SIGUSR1, that we call from Midas (with sudo)
def sig(sig, frame):
  global USER_CANCELLED
  USER_CANCELLED = True
  get_logger().debug("User cancelled!")

signal.signal(signal.SIGUSR1, sig)
signal.signal(signal.SIGUSR2, sig)

class UserCancelled(Exception):
  pass

def throw_if_cancelled():
  global USER_CANCELLED
  if USER_CANCELLED:
    raise UserCancelled()

class MidasDownloadProgress(dnf.callback.DownloadProgress, MidasReport):
  def __init__(self, socket: MidasSocket, packages) -> None:
    MidasReport.__init__(self, "download", socket=socket)
    self.packages = packages
    self.install_size = reduce(lambda a, b:a + b, [x.installsize for x in packages])
    self.total_size = 0
    self.downloaded_lookup = {}
    self.last_total = 0
    # started_first means we're using this to multiple calls of base.download_packages
    self.started_first = False
    self.downloaded = 0

  def start(self, total_files, total_size, total_drpms=0):
    if not self.started_first:
      self.total_size = total_size
      self.report("start", {"packages": [x.name for x in self.packages], "bytes": total_size})
      self.started_first = True
      self.downloaded += 1
    else:
      self.downloaded += 1
    return super().start(total_files, total_size, total_drpms)

  def progress(self, payload, done):
    self.downloaded_lookup["{}".format(payload)] = done
    new_total = 0
    for k, v in self.downloaded_lookup.items():
      new_total += v
    if new_total == self.last_total:
      return
    increment = ((new_total - self.last_total) / self.install_size) * 100.0
    self.last_total = new_total
    self.report("update", { "bytes": self.last_total, "increment": increment, "progress": (new_total / self.install_size) * 100.0, "pkg": "{}".format(payload) })
    return super().progress(payload, done)

  def end(self, payload, status, msg):
    if self.downloaded == len(self.packages):
      downloaded = 0
      for k, v in self.downloaded_lookup.items():
        downloaded += v
      self.report("finish", { "bytes": downloaded, "pkg": "{}".format(payload)})
    return super().end(payload, status, msg)

class MidasInstallProgress(dnf.callback.TransactionProgress, MidasReport):
  def __init__(self, socket: MidasSocket, packages):
    MidasReport.__init__(self, "install", socket)
    self.packages = packages
    self.processed = {}
    self.last_total = 0
    self.total_size = 0
    self.collected_total_size = 0
    # unfortunately, this total_size does not represent actual total install size
    # there seems to be some bug here.
    for pkg in self.packages:
      self.total_size += pkg.installsize

  def progress(self, package, action, ti_done, ti_total, ts_done, ts_total):
    if package is not None and action == dnf.transaction.PKG_INSTALL:
      self._installing(package, ti_done=ti_done, ti_total=ti_total)
    elif action == dnf.transaction.TRANS_POST:
      self.report("finish")
    return super().progress(package, action, ti_done, ti_total, ts_done, ts_total)

  def _installing(self, package, ti_done, ti_total):
    self._update_transaction_size_info(package, ti_done, ti_total)
    if not self._has_changed(package=package):
      return
    new_total = 0
    for k, v in self.processed.items():
      new_total += v["done"]
    increment = ((new_total - self.last_total) / self.total_size) * 100.0
    self.last_total = new_total
    self.report("update", {"package": package.name, "increment": increment})

  def _update_transaction_size_info(self, package, ti_done, ti_total):
    item = self.processed.get(package)
    if item is not None:
      last_reported = item["done"]
      self.processed[package] = {"done": ti_done, "total": ti_total, "last_reported": last_reported }
    else:
      self.collected_total_size += ti_total
      self.processed[package] = {"done": ti_done, "total": ti_total, "last_reported": 0 }

  def _has_changed(self, package):
    return self.processed[package]["done"] != self.processed[package]["last_reported"]

download_socket = MidasSocket(COMMS_ADDRESS)
install_socket = MidasSocket(COMMS_ADDRESS)

DEPENDENCIES = install_socket.wait_for_packages()

get_logger().debug("Dependencies requested: {}".format(DEPENDENCIES))

with dnf.base.Base() as base:
  base.read_all_repos()
  base.fill_sack()
  query = base.sack.query()
  architecture = platform.processor()
  filtered_query = query.filter(name=DEPENDENCIES, arch=[architecture, "noarch"]).latest()
  filtered = list(filtered_query)
  installed = list(filtered_query.installed())
  final = []
  for item in filtered:
    found = False
    for i in installed:
      if item.name == i.name:
        found = True
    if not found:
      final.append(item)
      base.package_install(item)
  base.resolve()
  get_logger().debug("Resolved dependencies: {}".format(" ".join([x.name for x in base.transaction.install_set])))
  progress = MidasDownloadProgress(socket=download_socket, packages=base.transaction.install_set)
  install_progress = MidasInstallProgress(socket=install_socket, packages=base.transaction.install_set)

  try:
    for item in base.transaction.install_set:
      base.download_packages([item], progress)
      throw_if_cancelled()
    base.do_transaction(install_progress)
  except UserCancelled:
    install_socket.send_payload({"type": "cancel", "action": "install"})
  except dnf.exceptions.DownloadError as e:
    download_socket.send_payload({"type": "error", "action": "download", "data": {"message": "{}".format(e)}})
  except Exception as ex:
    install_socket.send_payload({"type": "error", "action": "install", "data": {"message": "{}".format(ex)}})