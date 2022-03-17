import gdb
import json
import sys
import logging
import functools
import time
import traceback
import modules.python.config as config

def getFunctionBlock(frame) -> gdb.Block:
    block = frame.block()
    while not block.superblock.is_static and not block.superblock.is_global:
        block = block.superblock
    if block.is_static or block.is_global:
        return None
    return block

def parseCommandArguments(arg):
    return gdb.string_to_argv(arg)

def prepareCommandResponse(cmdName, contents):
    return '<gdbjs:cmd:{0} {1} {0}:cmd:gdbjs>'.format(cmdName, contents)

def prepareEventResponse(name, payload):
    return '<gdbjs:event:{0} {1} {0}:event:gdbjs>'.format(name, payload)

def sendResponse(name, result, prepareFnPtr):
    """Writes result of an operation to client stream."""
    res = json.dumps(result, ensure_ascii=False)
    packet = prepareFnPtr(name, res)
    sys.stdout.write(packet)
    sys.stdout.flush()

def timeInvocation(f):
    if not config.isDevelopmentBuild:
        return f
    """Measure performance (time) of command or function"""
    @functools.wraps(f)
    def timer_decorator(*args, **kwargs):
        invokeBegin = time.perf_counter_ns()
        f(*args, **kwargs)
        invokeEnd = time.perf_counter_ns()
        logger = logging.getLogger("time-logger")
        elapsed_time = int((invokeEnd - invokeBegin) / 1000) # we don't need nano-second measuring, but the accuracy of the timer is nice.
        logger.info("{:<30} executed in {:>10,} microseconds".format(f.__qualname__, elapsed_time))
        # note, we're not returning anything from Command invocations, as these are meant to be sent over the wire
    return timer_decorator

def logExceptionBacktrace(logger, errmsg, exception):
    logger.error("{} Exception info: {}".format(errmsg, exception))
    logger.error(traceback.format_exc())
    logger.error("Current dev setting: {}".format(config.isDevelopmentBuild))

def memberIsReference(type):
    code = type.code
    return code == gdb.TYPE_CODE_PTR or code == gdb.TYPE_CODE_REF or code == gdb.TYPE_CODE_RVALUE_REF

# When parsing closely related blocks, this is faster than gdb.parse_and_eval on average.
def getClosest(frame, name):
    block = frame.block()
    while (not block.is_static) and (not block.superblock.is_global):
        for symbol in block:
            if symbol.name == name:
                return symbol.value(frame)
        block = block.superblock
    return None

# Function that is able to utilize pretty printers, so that we can resolve
# a value (which often does _not_ have the same expression path as regular structured types).
# For instance used for std::tuple, which has a difficult member "layout", with ambiguous names.
# Since ContentsOf command always takes a full "expression path", now it doesn't matter if the sub-paths of the expression
# contain non-member names; because if there's a pretty printer that rename the members (like in std::tuple, it's [1], [2], ... [N])
# these will be found and traversed properly, anyway
def resolveGdbValue(value, components):
    it = value
    while len(components) > 0:
        if memberIsReference(it.type):
            it = it.referenced_value()
        pp = gdb.default_visualizer(it)
        component = components.pop(0)
        if pp is not None:
            found = False
            for child in pp.children():
                (name, val) = child
                if component == name:
                    it = val
                    found = True
                    break
            if not found:
                raise NotImplementedError()
        else:
            it = it[component]
    return it