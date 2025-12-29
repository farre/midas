import pyalpm
import configparser
from collections import UserDict
from pyalpm import Handle
import platform
import signal
from functools import reduce
from enum import IntFlag
import os
import json

from midas_report import get_logger, MidasSocket, COMMS_ADDRESS

def log(str):
    get_logger().debug(str)

USER_CANCELLED = False

# we install a signal handler for SIGUSR1, that we call from Midas (with sudo)
def sig(sig, frame):
  global USER_CANCELLED
  USER_CANCELLED = True
  get_logger().debug('User cancelled!')

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

class MidasProgress:
  def __init__(self, socket: MidasSocket, handle: Handle, packages) -> None:
    self.socket = socket
    self.bytes_downloaded = 0
    self.packages = set(packages)
    self.in_progress = set([package.filename for package in packages])
    self.downloaded = set()
    self.names = set([package.name for package in packages])

    self.logcb = self.logCallback()
    self.eventcb = self.eventCallback()
    self.dlcb = self.downloadCallback()
    self.progresscb = self.progressCallback()
    self.install_started = False
    self.done = False

    # handle.logcb = self.logcb
    handle.eventcb = self.eventcb
    handle.dlcb = self.dlcb
    handle.progresscb = self.progresscb

    data =  { "pid": os.getpid(), "ppid": os.getppid() }
    self.report('setup', 'download', data)
    self.report('setup', 'install', data)

  def logCallback(self):
    def closure(level, message):
      print('event: {} {}'.format(level, message))
    return closure

  def eventCallback(self):
    def closure(id, message):
      if id == 12 and self.done:
        self.report('finish', 'install', { 'bytes': 0 })
    return closure

  def downloadCallback(self):
    # Unfortunately there is a version conflict between pyalpm and libalpm where
    # libalpm has updated it's API. pyalpm want's sii here, whereas libalpm
    # actually sends filename, a struct and a void*
    def closure(filename, type, event):
      if type == 0:
        self.report("start", 'download', {"packages": self.names, "bytes": 0})
        self.in_progress.add(filename)
      if type == 1:
        self.report('update', 'download', { 'bytes': 0, 'increment': 0, 'progress': 0, 'pkg': '{}'.format(filename) })
      elif type == 3:
        try:
          self.in_progress.discard(filename)
          self.downloaded.add(filename)
          if len(self.in_progress) == 0:
            self.report('finish', 'download', { 'bytes': 0, 'pkgs': '{}'.format(self.downloaded)})
        except:
          return

    return closure

  def progressCallback(self):
    def closure(name, percentage, num_targets, target_number):
      if not self.install_started:
        self.report('start', 'install')
        self.install_started = True

      if name != '' and name not in self.names:
        self.names.add(name)

      if percentage == 100 and num_targets == target_number and name in self.names:
        self.done = True

      self.report('update', 'install', {'package': name, 'increment': percentage})
    return closure

  def fetchCallback(self):
    def closure(url, path, force):
      print('progress {} {} {}'.format(url, path, force))
    return closure

  def start(self):
    self.report("start", 'download', {"packages": list(self.names), "bytes": 0})
    self.report('start', 'install')

  def stop(self):
    self.report('finish', 'download', { "bytes": 0, "pkgs": "{}".format(self.names)})
    self.report('finish', 'install', 0)

  def report(self, type, action, data=None):
    self.socket.send_payload({'type': type, 'action': action, 'data': data})

class MultiDict(UserDict):
  def __setitem__(self, key, value):
    if isinstance(value, list):
      str = ','.join(value)
      if key in self:
        str = self[key] + ',' + str
      super().__setitem__(key, str)
    else:
      super().__setitem__(key, value)

def is_list_option(option):
  match option:
    case 'cachedir' | 'hookdir' | 'cacheserver' | 'server':
      return True
    case _:
      return False

def is_multi_option(option):
  match option:
    case 'holdpkg' | 'ignorepkg' | 'ignoregroup' | 'noupgrade' | 'noextract' :
      return True
    case _:
      return False

def get_config(path):
  converters = {'list': lambda x: [i.strip() for i in ([] if x == None else x.split(','))]}

  pacman_conf = configparser.ConfigParser(allow_no_value=True, empty_lines_in_values=False, strict=False, dict_type=MultiDict, converters=converters)
  pacman_conf.read(path)

  config = dict([('options', dict([('rootdir', '/'),
                                   ('dbpath', '/var/lib/pacman'),
                                   ('gpgdir', '/etc/pacman.d/gnupg/'),
                                   ('logfile', '/var/log/pacman.log')]))])

  for section_conf in pacman_conf.sections():
    section = config.setdefault(section_conf, dict())

    options = []
    for option in pacman_conf.options(section_conf):
      options.append((option, pacman_conf.getlist(section_conf, option, fallback='')))

    while len(options) > 0:
      option, value = options.pop(0)
      if option == 'include':
        inner_conf = configparser.ConfigParser(empty_lines_in_values=False, strict=False, allow_unnamed_section=True, dict_type=MultiDict, converters=converters)
        inner_conf.read(value)
        for inner_option in inner_conf.options(configparser.UNNAMED_SECTION):
          options.append((inner_option, inner_conf.getlist(configparser.UNNAMED_SECTION, inner_option, fallback='')))
      elif len(value) < 2 and not is_list_option(option):
        section[option] = True if len(value) == 0 else value[0]
      elif is_multi_option(option):
        section[option] = ' '.join(value).split(' ')
      elif option not in section:
        section[option] = value
      else:
        log('Warning! Skipping multiple {}'.format(option))

  return config

def translate_key(key):
  match key:
    case 'architecture':
      return 'arch'
    case 'cachedir':
      return 'cachedirs'
    case 'ignoregroup':
      return 'ignoregrps'
    case 'ignorepkg':
      return 'ignorepkgs'
    case 'noextract':
      return 'noextract'
    case 'noupgrade':
      return 'noupgrades'
    case _:
      return key

class SignatureLevel(IntFlag):
  Required = pyalpm.SIG_DATABASE
  Optional = pyalpm.SIG_DATABASE_OPTIONAL
  MarginalOK = pyalpm.SIG_DATABASE_MARGINAL_OK
  UnknownOK = pyalpm.SIG_DATABASE_UNKNOWN_OK

  def DEFAULT():
    return SignatureLevel.Required | SignatureLevel.Optional

def signature_level(options, current):
  if 'siglevel' not in options:
    return current

  siglevel = current
  for value in ','.join(options['siglevel'].split(' ')).split(','):
    if value.startswith('Package'):
      continue
    match value.replace('Database', ''):
      case 'Never':
        siglevel = siglevel & ~SignatureLevel.Required
      case 'Optional':
        siglevel = siglevel | SignatureLevel.Required | SignatureLevel.Optional
      case 'Required':
        siglevel = (siglevel & ~SignatureLevel.Optional) | SignatureLevel.Required
      case 'TrustedOnly':
        siglevel = siglevel & ~(SignatureLevel.MarginalOK | SignatureLevel.UnknownOK)
      case 'TrustAll':
        siglevel = siglevel | SignatureLevel.MarginalOK | SignatureLevel.UnknownOK
      case _:
        raise ValueError('Uknown signature level {}'.format(value))
  return siglevel

def initialize_alpm(config):
  handle = pyalpm.Handle(config['options']['rootdir'], config['options']['dbpath'])

  keys = ['cachedir', 'logfile', 'gpgdir', 'arch', 'usesyslog', 'checkspace',
          'noupgrades', 'noextract', 'ignoregroup', 'ignorepkg'];
  defaults = dict([('CacheDir', ['/var/cache/pacman/pkg'])])

  options = config['options']
  for option in keys:
    if option in options:
      setattr(handle, translate_key(option), options[option])
    elif option in defaults:
      setattr(handle, translate_key(option), defaults[option])

  default_siglevel = SignatureLevel.DEFAULT()
  siglevel = signature_level(options, default_siglevel)
  repos = { name : section for name, section in config.items() if name != 'options'}
  servers = [] if not 'servers' in options else options['servers']
  arch = options.get('Architecture', 'auto')
  if arch == 'auto':
    arch = os.uname()[-1]
  cachedir = options.get('cachedir', 'auto')

  for repo, options in repos.items():
    db_siglevel = signature_level(options, siglevel)
    db = handle.register_syncdb(repo, signature_level(options, db_siglevel.value))
    db_servers = []
    for server in [*servers, *([] if 'server' not in options else options['server'])]:
      db_servers.append(server.replace('$repo', repo).replace('$arch', arch))
    db.servers = db_servers

  return handle

def log_and_exit(str):
  print(str)
  raise ValueError(str)

def run():
  unused_socket = MidasSocket(COMMS_ADDRESS)
  midas_socket = MidasSocket(COMMS_ADDRESS)
  try:
    RAW_DEPENDENCIES = midas_socket.wait_for_packages()

    config = get_config('/etc/pacman.conf')
    handle = initialize_alpm(config)

    localdb = handle.get_localdb()

    DEPENDENCIES = [dep for dep in RAW_DEPENDENCIES if not localdb.get_pkg(dep)]

    packages = []

    for db in handle.get_syncdbs():
      for item in DEPENDENCIES:
        pkg = db.get_pkg(item)
        if pkg:
          packages.append(pkg)

    progress = MidasProgress(socket=midas_socket, handle=handle, packages=packages)

    # get_logger().debug('Begin download & install')
    log('Begin download & install')
    if len(packages) == 0:
      log('No dependencies need installing...')
      progress.start()
      progress.stop()
      return

    transaction = handle.init_transaction()

    for package in packages:
      transaction.add_pkg(package)

    transaction.sysupgrade(False)

    try:
      transaction.prepare()
      transaction.commit()
    except pyalpm.error as e:
      transaction.release()
      raise e
    transaction.release()

  except Exception as e:
    import traceback
    log('Exception: {}'.format(e))
    log('Traceback: {}'.format(traceback.format_exc()))

run()