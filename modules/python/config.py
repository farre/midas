"""the config module holds settings for Midas but it also keeps global state for the backend."""

import gdb
import functools
import time
import logging
import traceback

global isDevelopmentBuild
global setTrace
global currentExecutionContext

variableReferenceCounter = 0


def next_variable_reference():
    global variableReferenceCounter
    res = variableReferenceCounter + 1
    variableReferenceCounter += 1
    return res


isDevelopmentBuild = False
setTrace = False
currentExecutionContext = None


class ReferenceKey:
    def __init__(self, threadId, stackFrameId):
        self.threadId = threadId
        self.frameId = stackFrameId


class VariableReferenceMap:
    def __init__(self):
        self.lookup = {}

    def add_mapping(self, variableReference, threadId, stackFrameId):
        self.lookup[variableReference] = ReferenceKey(threadId, stackFrameId)

    def get_context(self, variableReference) -> ReferenceKey:
        return self.lookup.get(variableReference)


variableReferences = VariableReferenceMap()


def timeInvocation(f):
    if not isDevelopmentBuild:
        return f
    """Measure performance (time) of command or function"""
    @functools.wraps(f)
    def timer_decorator(*args, **kwargs):
        invokeBegin = time.perf_counter_ns()
        result = f(*args, **kwargs)
        invokeEnd = time.perf_counter_ns()
        logger = logging.getLogger("time-logger")
        # we don't need nano-second measuring, but the accuracy of the timer is nice.
        elapsed_time = int((invokeEnd - invokeBegin) / 1000)
        logger.info("{:<30} executed in {:>10,} microseconds".format(
            f.__qualname__, elapsed_time))
        return result
    return timer_decorator


def error_logger():
    return logging.getLogger("error-logger")


def update_logger():
    return logging.getLogger("update-logger")


def timing_logger():
    return logging.getLogger("time-logger")


def log_exception(logger, errmsg, exception):
    logger.error("{} Exception info: {}".format(errmsg, exception))
    logger.error(traceback.format_exc())
    logger.error("Current dev setting: {}".format(isDevelopmentBuild))
