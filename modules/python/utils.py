import gdb
import sys
import json
import gdb.types
import traceback
import logging

logging.basicConfig(filename='update.log', filemode="w", encoding='utf-8', level=logging.DEBUG)

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
    if hasattr(field, 'bitpos'):
        if field.is_base_class:
            for f in field.type.fields():
                getMembersRecursively(f, memberList=memberList, statics=statics)
        else:
            if field.name is not None and not field.name.startswith("_vptr"):
                memberList.append(field.name)
    else:
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

def getMemberValue(path):
    pathComponents = path.split(".")
    parent = pathComponents[0]
    try:
        it = gdb.parse_and_eval(parent)
        pathComponents = pathComponents[1:]
        if len(pathComponents):
            return it
        for path in pathComponents:
            curr = getElement(path, it)
            if curr is None:
                return None
            it = curr
        
        return it
    except gdb.error:
        return None

def display(name, value, isPrimitive):
    try:
        if value.type.code == gdb.TYPE_CODE_PTR:
            if isPrimitive:
                return { "name": name, "display": "<{}> {}".format(value.dereference().address, value), "isPrimitive": isPrimitive }
            else:
                return { "name": name, "display": "<{}> {}".format(value.dereference().address, value.type), "isPrimitive": isPrimitive }
        else:
            if isPrimitive:
                return { "name": name, "display": "{}".format(value), "isPrimitive": isPrimitive }
            else:
                return { "name": name, "display": "{}".format(value.type), "isPrimitive": isPrimitive }
    except:
        return { "name": name, "display": "<invalid address> {}".format(value.type), "isPrimitive": isPrimitive }
