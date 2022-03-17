import sys
import os

# Setup code that needs to be excuted, so that GDB can know where to look for our python modules
# We grab the path to the folder containing this file and append it to sys.
stdlibpath = os.path.dirname(os.path.realpath(__file__))
if sys.path.count(stdlibpath) == 0:
    sys.path.append(stdlibpath)

# We import this here; so that we can set the global variables from VSCode *before* any of the functionality from python is loaded in
# that way we can set logging, tracing, debug msgs so on and so forth.
import config