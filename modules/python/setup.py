import sys
import os

# Setup code that needs to be excuted, so that GDB can know where to look for our python modules
# We grab the path to the folder containing this file and append it to sys.
stdlibpath = os.path.dirname(os.path.realpath(__file__))
if sys.path.count(stdlibpath) == 0:
    sys.path.append(stdlibpath)

# Imported here; so that we can set config.isDevelopmentBuild etc after this file has been loaded by GDB
import config