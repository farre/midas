import gdb
import sys
import json
import gdb.types
import traceback
import logging
import logging.handlers
import functools
import time

# Midas sets this, when Midas DA has been initialized
if isDevelopmentBuild:
    time_handler = logging.handlers.WatchedFileHandler(
        "performance_time.log", mode="w")
    formatter = logging.Formatter(logging.BASIC_FORMAT)
    time_handler.setFormatter(formatter)
    time_logger = logging.getLogger("time-logger")
    time_logger.setLevel(logging.DEBUG)
    time_logger.addHandler(time_handler)

misc_handler = logging.handlers.WatchedFileHandler("debug.log", mode="w")
misc_formatter = logging.Formatter(logging.BASIC_FORMAT)
misc_handler.setFormatter(misc_formatter)

misc_logger = logging.getLogger("update-logger")
misc_logger.setLevel(logging.DEBUG)
misc_logger.addHandler(misc_handler)

err_handler = logging.handlers.WatchedFileHandler("error.log", mode="w")
err_formatter = logging.Formatter(logging.BASIC_FORMAT)
err_handler.setFormatter(err_formatter)

err_logger = logging.getLogger("error-logger")
err_logger.addHandler(err_handler)

def getFunctionBlock(frame) -> gdb.Block:
    block = frame.block()
    while not block.superblock.is_static and not block.superblock.is_global:
        block = block.superblock
    if block.is_static or block.is_global:
        return None
    return block


def logExceptionBacktrace(errmsg, exception):
    misc_logger.error("{} Exception info: {}".format(errmsg, exception))
    misc_logger.error(traceback.format_exc())


def selectThreadAndFrame(threadId, frameLevel):
    gdb.execute("thread {}".format(threadId))
    gdb.execute("frame {}".format(frameLevel))


def parseStringArgs(arg):
    return gdb.string_to_argv(arg)


def prepareOutput(cmdName, contents):
    return '<gdbjs:cmd:{0} {1} {0}:cmd:gdbjs>'.format(cmdName, contents)


def output(name, result):
    res = json.dumps(result, ensure_ascii=False)
    msg = prepareOutput(name, res)
    sys.stdout.write(msg)
    sys.stdout.flush()


def typeIsPrimitive(valueType):
    try:
        for f in valueType.fields():
            if hasattr(f, "enumval"):
                return True
            else:
                return False
    except TypeError:
        return True


def memberIsReference(type):
    code = type.code
    return code == gdb.TYPE_CODE_PTR or code == gdb.TYPE_CODE_REF or code == gdb.TYPE_CODE_RVALUE_REF


def getMembersRecursively(field, memberList, statics):
    if field.bitsize > 0:
        misc_logger.info("field {} is possibly a bitfield of size {}".format(
            field.name, field.bitsize))
    if hasattr(field, 'bitpos'):
        if field.is_base_class:
            for f in field.type.fields():
                getMembersRecursively(
                    f, memberList=memberList, statics=statics)
        else:
            if field.name is not None and not field.name.startswith("_vptr"):
                memberList.append(field.name)
    else:
        statics.append(field.name)


def getMembers(field, memberList, statics, baseclasses):
    if hasattr(field, 'bitpos') and field.name is not None and not field.name.startswith("_vptr") and not field.is_base_class:
        memberList.append(field.name)
    elif field.is_base_class:
        baseclasses.append(field.name)
    elif not hasattr(field, "bitpos"):
        statics.append(field.name)


def variable_display(name, display, isPrimitive, static, synthetic):
    return {"name": name, "display": display, "isPrimitive": isPrimitive, "static": static, "synthetic": synthetic}


def display(name, value, isPrimitive, synthetic=False):
    if value.is_optimized_out:
        # we set all optimized values to primitives, because we don't want a scope for them in VSCode
        return variable_display(name=name, display="<optimized out>", isPrimitive=True, static=False, synthetic=True)
    try:
        if value.type.code == gdb.TYPE_CODE_PTR:
            if isPrimitive:
                return variable_display(name=name, display="<{}> {}".format(value.dereference().address, value), isPrimitive=isPrimitive, static=False, synthetic=synthetic)
            else:
                return variable_display(name=name, display="<{}> {}".format(value.dereference().address, value.type), isPrimitive=isPrimitive, static=False, synthetic=synthetic)
        else:
            if isPrimitive:
                return variable_display(name=name, display="{}".format(value), isPrimitive=isPrimitive, static=False, synthetic=synthetic)
            else:
                return variable_display(name=name, display="{}".format(value.type), isPrimitive=isPrimitive, static=False, synthetic=synthetic)
    except:
        return variable_display(name=name, display="<invalid address> {}".format(value.type), isPrimitive=isPrimitive, static=False, synthetic=True)

def pp_display_simple(name, value):
    return variable_display(name=name, display="{}".format(value), isPrimitive=True, static=False, synthetic=True)

def base_class_display(name, type):
    return {"name": name, "display": "{} (base)".format(type)}


def static_display(name, type):
    isPrimitive = True if type.tag is None else False
    typeName = type.tag if type.tag is not None else type
    return {"name": name, "display": "static {}".format(typeName), "isPrimitive": isPrimitive, "static": True, "synthetic": False}
