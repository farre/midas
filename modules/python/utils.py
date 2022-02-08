import gdb
import sys
import json
import gdb.types

def parse_string_args(arg):
    return gdb.string_to_argv(arg)

def prepare_output(cmdName, contents):
    return '<gdbjs:cmd:{0} {1} {0}:cmd:gdbjs>'.format(cmdName, contents)

def getMembersRecursively(field, memberList):
    if hasattr(field, 'bitpos'):
        if field.is_base_class:
            for f in field.type.fields():
                getMembersRecursively(f, memberList)
        else:
            if field.name is not None and not field.name.startswith("_vptr$"):
                memberList.append(field.name)


def recursivelyBuild(value, lst):
    tmp = value
    if memberIsReference(value.type) and value != 0:
        try:
            v = value.referenced_value()
            value = v
        except gdb.MemoryError:
            value = tmp
    
    membersOfValue = getMembersList(value)
    for member in membersOfValue:
        subt = value[member].type
        try:
            subt.fields()
            lst.append({ "name": member, "display": "{0}".format(value[member].type), "isPrimitive": False, "payload":  recursivelyBuild(value[member], []) })
        except TypeError:
            lst.append({ "name": member, "display": "{0}".format(value[member]), "isPrimitive": True })

    return lst

def getStructMembers(path, value):
    members = []
    fields = value.type.fields()
    for f in fields:
        if hasattr(f, "bitpos"):
            if f.name is not None and not f.name.startswith("_vptr$"):
                members.append(f.name)
    return members


def getMembersList(value):
    members = []
    fields = value.type.fields()
    for f in fields:
        getMembersRecursively(f, members)
    return members

def memberIsReference(type):
    code = type.code
    return code == gdb.TYPE_CODE_PTR or code == gdb.TYPE_CODE_REF or code == gdb.TYPE_CODE_RVALUE_REF

def typeIsPrimitive(valueType):
    try:
        valueType.fields()
        return False
    except TypeError:
        return True

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