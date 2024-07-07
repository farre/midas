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
  def __init__(self, action: str):
    super().__init__()
    self.action = action

  def __str__(self):
    return self.action


def throw_if_cancelled(action: str):
  global USER_CANCELLED
  if USER_CANCELLED:
    raise UserCancelled(action)

class MidasDownloadProgress(dnf.callback.DownloadProgress, MidasReport):
  def __init__(self, socket: MidasSocket, packages) -> None:
    MidasReport.__init__(self, "download", socket=socket)
    self.packages = packages
    self.install_size = 0
    for pkg in packages:
      self.install_size += pkg.installsize
    # self.install_size = reduce(lambda a, b:a + b, [x.installsize for x in packages])
    get_logger().debug("Total install size: {}".format(self.install_size))
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
      self.stop(downloaded, [x.name for x in self.packages])
    return super().end(payload, status, msg)

  def stop(self, bytes_downloaded, packages):
    self.report("finish", { "bytes": bytes_downloaded, "pkgs": "{}".format(packages)})

class MidasInstallProgress(dnf.callback.TransactionProgress, MidasReport):
  def __init__(self, socket: MidasSocket, packages):
    MidasReport.__init__(self, "install", socket=socket)
    self.packages = packages
    self.processed = {}
    self.last_total = 0
    self.total_size = 0
    self.collected_total_size = 0
    # unfortunately, this total_size does not represent actual total install size
    # there seems to be some bug here.
    for pkg in self.packages:
      self.total_size += pkg.installsize
    self.started = False

  def progress(self, package, action, ti_done, ti_total, ts_done, ts_total):
    if not self.started:
      self.start()
      self.started = True
    if package is not None and action == dnf.transaction.PKG_INSTALL:
      self._installing(package, ti_done=ti_done, ti_total=ti_total)
    elif action == dnf.transaction.TRANS_POST:
      self.stop(self.total_size)
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

  def start(self):
    self.report("start")

  def stop(self, bytes_installed):
    self.report("finish", { "bytes": bytes_installed })

download_socket = MidasSocket(COMMS_ADDRESS)
install_socket = MidasSocket(COMMS_ADDRESS)

try:
  DEPENDENCIES = install_socket.wait_for_packages()
  x86_64_deps = []
  i686_deps = []
  for item in DEPENDENCIES:
    if item.endswith(".i686"):
      i686_deps.append(item.removesuffix(".i686"))
    else:
      x86_64_deps.append(item)
  PLATFORM_PROCESSOR_BUG_FIX = platform.processor() if platform.processor() != "" else "x86_64"
  DEPS = [{"arch": [PLATFORM_PROCESSOR_BUG_FIX , "noarch"], "deps": x86_64_deps }, {"arch": ["i686"], "deps": i686_deps } ]
  get_logger().debug("Dependencies requested: {}".format(DEPS))
  with dnf.base.Base() as base:
    base.read_all_repos()
    base.fill_sack()
    for deplist in DEPS:
      query = base.sack.query()
      get_logger().debug("Processing for arch {}: {}".format(deplist["arch"], deplist["deps"]))
      filter_query = query.filter(name=deplist["deps"], arch=deplist["arch"]).latest()
      filtered = list(filter_query)
      installed = list(filter_query.installed())
      for item in filtered:
        get_logger().debug("Processing requested item: {} : {}".format(item.name, item.arch))
        found = False
        for i in installed:
          if item.name == i.name:
            found = True
        if not found:
          base.package_install(item)
    base.resolve()
    get_logger().debug("Resolved dependencies: {}".format(" ".join([x.name for x in base.transaction.install_set])))
    progress = MidasDownloadProgress(socket=download_socket, packages=base.transaction.install_set)
    install_progress = MidasInstallProgress(socket=install_socket, packages=base.transaction.install_set)

    try:
      get_logger().debug("Begin download & install")
      if len(base.transaction.install_set) == 0:
        get_logger().debug("No dependencies need installing...")
        progress.start(0, 0, 0)
        progress.stop(0, [])
        install_progress.start()
        install_progress.stop(0)
      else:
        for item in base.transaction.install_set:
          base.download_packages([item], progress)
          throw_if_cancelled("download")
        base.do_transaction(install_progress)
    except UserCancelled as e:
      install_socket.send_payload({"type": "cancel", "action": "{}".format(e)})
    except dnf.exceptions.DownloadError as e:
      download_socket.send_payload({"type": "error", "action": "download", "data": {"message": "{}".format(e)}})
    except Exception as ex:
      install_socket.send_payload({"type": "error", "action": "install", "data": {"message": "{}".format(ex)}})
except Exception as e:
  import traceback
  get_logger().error("Exception: {}".format(e))
  get_logger().error("Traceback: {}".format(traceback.format_exc()))