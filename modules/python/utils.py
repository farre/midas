import gdb
import sys
import json
import gdb.types
import traceback
import logging


def getFunctionBlock(frame) -> gdb.Block:
    block = frame.block()
    while not block.superblock.is_static and not block.superblock.is_global:
        block = block.superblock
    if block.is_static or block.is_global:
        return None
    return block

def logExceptionBacktrace(errmsg, exception):
        logging.error("{} Exception info: {}".format(errmsg, exception))
        logging.error(traceback.format_exc())

def selectThreadAndFrame(threadId, frameLevel):
    try:
        gdb.execute("thread {}".format(threadId))
        gdb.execute("frame {}".format(frameLevel))
    except Exception as e:
        logExceptionBacktrace("Selecting thread and frame failed.", e)

def parseStringArgs(arg):
    return gdb.string_to_argv(arg)

def prepareOutput(cmdName, contents):
    return '<gdbjs:cmd:{0} {1} {0}:cmd:gdbjs>'.format(cmdName, contents)

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
        logging.info("field {} is possibly a bitfield of size {}".format(field.name, field.bitsize))
    if hasattr(field, 'bitpos'):
        if field.is_base_class:
            for f in field.type.fields():
                getMembersRecursively(f, memberList=memberList, statics=statics)
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

def getValue(value):
    print("Trying to get value of {0}".format(value))
    if memberIsReference(value.type):
        try:
            v = value.referenced_value()
            return v
        except gdb.MemoryError:
            return value
    else:
        return value

def getElement(key, map):
    try:
        r = map[key]
        return r
    except KeyError:
        return None

def display(name, value, isPrimitive):
    if value.is_optimized_out:
        # we set all optimized values to primitives, because we don't want a scope for them in VSCode
        return { "name": name, "display": "<optimized out>", "isPrimitive": True, "static": False }
    try:
        if value.type.code == gdb.TYPE_CODE_PTR:
            if isPrimitive:
                return { "name": name, "display": "<{}> {}".format(value.dereference().address, value), "isPrimitive": isPrimitive, "static": False }
            else:
                return { "name": name, "display": "<{}> {}".format(value.dereference().address, value.type), "isPrimitive": isPrimitive, "static": False }
        else:
            if isPrimitive:
                return { "name": name, "display": "{}".format(value), "isPrimitive": isPrimitive, "static": False }
            else:
                return { "name": name, "display": "{}".format(value.type), "isPrimitive": isPrimitive, "static": False }
    except:
        return { "name": name, "display": "<invalid address> {}".format(value.type), "isPrimitive": isPrimitive, "static": False }

def base_class_display(name, type):
    return { "name": name, "display": "{} (base)".format(type) }

def static_display(name, type):
    isPrimitive = True if type.tag is None else False
    typeName = type.tag if type.tag is not None else type
    return { "name": name, "display": "static {}".format(typeName), "isPrimitive": isPrimitive, "static": True }