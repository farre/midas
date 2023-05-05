import gdb
import gdb.types
import os
import sys
import json

import logging
import logging.handlers
from os import path


def resolveExtensionFile(fileName):
    extensionPath = os.path.dirname(os.path.realpath(__file__))
    return "{}/../../{}".format(extensionPath, fileName)


misc_handler = logging.handlers.WatchedFileHandler(resolveExtensionFile("debug.log"), mode="w")
misc_formatter = logging.Formatter(logging.BASIC_FORMAT)
misc_handler.setFormatter(misc_formatter)

misc_logger = logging.getLogger("update-logger")
misc_logger.setLevel(logging.DEBUG)
misc_logger.addHandler(misc_handler)

err_handler = logging.handlers.WatchedFileHandler(resolveExtensionFile("error.log"), mode="w")
err_formatter = logging.Formatter(logging.BASIC_FORMAT)
err_handler.setFormatter(err_formatter)

err_logger = logging.getLogger("error-logger")
err_logger.addHandler(err_handler)

time_handler = logging.handlers.WatchedFileHandler(resolveExtensionFile("performance_time.log"), mode="w")
time_formatter = logging.Formatter(logging.BASIC_FORMAT)
time_handler.setFormatter(time_formatter)
time_logger = logging.getLogger("time-logger")
time_logger.setLevel(logging.DEBUG)
time_logger.addHandler(time_handler)

# Setup code that needs to be excuted, so that GDB can know where to look for our python modules
# We grab the path to the folder containing this file and append it to sys.
extensionPath = os.path.dirname(os.path.realpath(__file__))
if sys.path.count(extensionPath) == 0:
    err_logger.error("Module path not set. Setting it")
    sys.path.append(extensionPath)
import config
# Order of imports - highly important here. Do not change.
import execution_context
config.currentExecutionContext = execution_context.CurrentExecutionContext()
executionContexts = {}
# Order of imports not important below

invalidateExecutionContextCommand = execution_context.InvalidateExecutionContext(executionContexts)

import stacktrace_request
stackFrameRequestCommand = stacktrace_request.StackTraceRequest(executionContexts)

import variables_request
variableRequestCommand = variables_request.VariableRequest(executionContexts)

import scopes_request
scopesRequestCommand = scopes_request.ScopesRequest(executionContexts)

import watchpoint_request
setWatchPointCommand = watchpoint_request.SetWatchPoint()

import watch_variable
watchVariableCommand = watch_variable.WatchVariable(executionContexts)

# Request that is Midas only; it resets all backend state (for when for instance the user wants to restart a debug session).
import reset_request
resetRequestCommand = reset_request.ResetStateRequest(executionContexts, config.variableReferenceCounter,
                                                      config.variableReferences)

import data_breakpoint_info_request
dataBreakpointInfoRequest = data_breakpoint_info_request.DataBreakpointInfoRequest(executionContexts)

import get_os_pids
getPids = get_os_pids.GetAllPids()

import rr_commands

setCheckpointRequestCommand = rr_commands.SetCheckpointRequest()
infoCheckpointCommand = rr_commands.InfoCheckpoints()
deleteCheckpointCommand = rr_commands.DeleteCheckpoint()
whenCommand = rr_commands.RRWhen()

# Midas sets this, when Midas DA has been initialized
if config.isDevelopmentBuild:
    misc_logger.debug("Development mode is set. Logging enabled.")