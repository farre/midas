import gdb
import midas_utils
import subprocess
import os

def rustSysRoot():
    res = subprocess.run(["rustc", "--print=sysroot"], capture_output=True, text=True)
    return res.stdout.strip()

def rustPythonModuleDir(rustcsysroot):
    return f"{rustcsysroot}/lib/rustlib/etc"

def rustSrc(rustcsysroot):
    return ("/builddir/build/BUILD/rustc-1.69.0-src/library/", f"{rustcsysroot}/lib/rustlib/rust/library/")



class SetupRustGdb(gdb.Command):

    def __init__(self):
        super(SetupRustGdb, self).__init__("gdbjs-rust", gdb.COMMAND_USER)
        self.name = "r"

    def invoke(self, args, from_tty):

        sysroot = rustSysRoot()
        gdb_mod_dir = rustPythonModuleDir(sysroot)

        if "PYTHONPATH" in os.environ:
            print(f"PYTHONPATH: {os.environ['PYTHONPATH']}")
            os.environ["PYTHONPATH"] = f"{os.environ['PYTHONPATH']}:{gdb_mod_dir}"
        else:
            print(f"Setting PYTHONPATH TO: {gdb_mod_dir}")
            os.environ["PYTHONPATH"] = gdb_mod_dir
        (std_build, std_src) = rustSrc(sysroot)
        print(f"--directory {gdb_mod_dir}")
        gdb.execute(f"directory {gdb_mod_dir}")
        print(f"add-auto-load-safe-path {gdb_mod_dir}")
        gdb.execute(f"add-auto-load-safe-path {gdb_mod_dir}")
        print(f"set substitute-path {std_build} {std_src}")
        gdb.execute(f"set substitute-path {std_build} {std_src}")

SetupRustGdb()