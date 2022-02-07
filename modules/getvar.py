import gdb
import sys
import json
import gdb.types

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
    


def getMembersList(value):
    members = []
    fields = value.type.fields()
    for f in fields:
        getMembersRecursively(f, members)
    return members

def memberIsReference(type):
    code = type.code
    return code == gdb.TYPE_CODE_PTR or code == gdb.TYPE_CODE_REF or code == gdb.TYPE_CODE_RVALUE_REF


class GetVariableContents(gdb.Command):
    def __init__(self):
        super(GetVariableContents, self).__init__("gdbjs-getvar", gdb.COMMAND_USER)
        self.name = "getvar"

    def invoke(self, var, from_tty):
        result = []
        value = gdb.parse_and_eval(var)
        if memberIsReference(value.type):
            value = value.referenced_value()
        
        membersOfValue = getMembersList(value)
        for member in membersOfValue:
            subt = value[member].type
            try:
                subt.fields()
                result.append({ "name": member, "value": "{0}".format(value[member].type), "isPrimitive": False })
            except TypeError:
                result.append({ "name": member, "value": "{0}".format(value[member]), "isPrimitive": True })


        res = json.dumps(result, ensure_ascii=False)
        msg = prepare_output(self.name, res)
        sys.stdout.write(msg)
        sys.stdout.flush()


getVariableContentsCommand = GetVariableContents()

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



class GetChildren(gdb.Command):
    def __init__(self):
        super(GetChildren, self).__init__("gdbjs-getchildren", gdb.COMMAND_USER)
        self.name = "getchildren"

    def invoke(self, var, from_tty):
        result = []
        value = gdb.parse_and_eval(var)
        if memberIsReference(value.type):
            value = value.referenced_value()
        
        membersOfValue = getMembersList(value)
        for member in membersOfValue:
            subt = value[member].type
            try:
                subt.fields()
                result.append({ "name": member, "display": "{0}".format(value[member].type), "isPrimitive": False, "payload": recursivelyBuild(value[member], []) })
            except TypeError:
                result.append({ "name": member, "display": "{0}".format(value[member]), "isPrimitive": True })


        res = json.dumps(result, ensure_ascii=False)
        msg = prepare_output(self.name, res)
        sys.stdout.write(msg)
        sys.stdout.flush()


getChildrenCommand = GetChildren()


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

class LocalsAndArgs(gdb.Command):

    def __init__(self):
        super(LocalsAndArgs, self).__init__("gdbjs-localsargs", gdb.COMMAND_USER)
        self.name = "localsargs"

    def invoke(self, arg, from_tty):
        frame = gdb.selected_frame()
        block = frame.block()
        names = set()
        variables = []
        args = []
        for symbol in block:
            name = symbol.name
            if (name not in names) and (symbol.is_argument or
                symbol.is_variable):
                names.add(name)
                value = symbol.value(frame)
                if typeIsPrimitive(value.type):
                    v = {
                        "name": symbol.name,
                        "display": str(value),
                        "isPrimitive": True
                    }
                    if symbol.is_argument:
                        args.append(v)
                    else:
                        variables.append(v)
                else:
                    v = {
                        "name": symbol.name,
                        "display": str(value.type),
                        "isPrimitive": False
                    }
                    if symbol.is_argument:
                        args.append(v)
                    else:
                        variables.append(v)

        result = {"args": args, "variables": variables }
        res = json.dumps(result, ensure_ascii=False)
        msg = prepare_output(self.name, res)
        sys.stdout.write(msg)
        sys.stdout.flush()


localsAndArgsCommand = LocalsAndArgs()

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
    


class InspectVariable(gdb.Command):

    def __init__(self):
        super(InspectVariable, self).__init__("gdbjs-inspect", gdb.COMMAND_USER)
        self.name = "inspect"

    def invoke(self, arg, from_tty):
        result = []
        value = getMemberValue(arg)
        if value is None:
            res = json.dumps(None, ensure_ascii=False)
            msg = prepare_output(self.name, res)
            sys.stdout.write(msg)
            sys.stdout.flush()
            return            

        if memberIsReference(value.type):
            value = value.referenced_value()
        
        try:
            value.type.fields()
            membersOfValue = getMembersList(value)
            for member in membersOfValue:
                subt = value[member].type
                try:
                    subt.fields()
                    result.append({ "name": member, "display": "{0}".format(value[member].type), "isPrimitive": False, "payload": recursivelyBuild(value[member], []) })
                except TypeError:
                    result.append({ "name": member, "display": "{0}".format(value[member]), "isPrimitive": True })
            inspected = { "name": arg, "display": "{0}".format(value.type), "isPrimitive": False, "payload": result }
            res = json.dumps(inspected, ensure_ascii=False)
            msg = prepare_output(self.name, res)
            sys.stdout.write(msg)
            sys.stdout.flush()
        except TypeError:
            inspected = { "name": arg, "display": "{0}".format(value), "isPrimitive": True }
            res = json.dumps(inspected, ensure_ascii=False)
            msg = prepare_output(self.name, res)
            sys.stdout.write(msg)
            sys.stdout.flush()


inspectCommand = InspectVariable()