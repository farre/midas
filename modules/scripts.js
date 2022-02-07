const midasPy = `
import gdb
import sys
import json
import gdb.types

def getMembersRecursively(field, memberList):
    if hasattr(field, 'bitpos'):
        if field.is_base_class:
            for f in field.type.fields():
                getMembersRecursively(f, memberList)
        else:
            memberList.append(field.name)
    


def getMembersList(expr):
    members = []
    value = gdb.parse_and_eval(expr).referenced_value()
    fields = value.type.fields()
    for f in fields:
        getMembersRecursively(f, members)
    return members

def prepare_output(cmdName, contents):
    return '<gdbjs:cmd:{0} {1} {0}:cmd:gdbjs>'.format(cmdName, contents)

class GetMembers(gdb.Command):

    def __init__(self):
        super(GetMembers, self).__init__("gdbjs-members", gdb.COMMAND_USER)
        self.name = "members"

    def invoke(self, arg, from_tty):
        members = getMembersList(arg)
        res = json.dumps(members, ensure_ascii=False)
        msg = '<gdbjs:cmd:{0} {1} {0}:cmd:gdbjs>'.format(self.name, res)
        sys.stdout.write(msg)
        sys.stdout.flush()


class CreateVariableObject(gdb.Command):

    def __init__(self):
        super(CreateVariableObject, self).__init__("gdbjs-create-varobj", gdb.COMMAND_USER)
        self.name = "create-varobj"

    def invoke(self, args, from_tty):
        result = []
        [varObjParentName, evaluateName] = gdb.string_to_argv(args)
        members = getMembersList(evaluateName)
        if len(members) == 0:
            members = getMembersList("*{0}".format(evaluateName))
        
        for m in members:
            try:
                varObjName = "{0}.{1}".format(varObjParentName, m)
                path = "{0}.{1}".format(evaluateName, m)
                gdb.execute(r"""interpreter-exec mi3 "-var-create {0} * {1}""".format(varObjName, path) + '"')
                result.append({ "variableObjectName": varObjName, "path": path })
            except Exception as e:
                print("we caught an exception: {0}".format(e))
                res = json.dumps([], ensure_ascii=False)
                msg = prepare_output(self.name, res)                        
                sys.stdout.write(msg)
                sys.stdout.flush()
                return

        for r in result:
            print("item: {0}".format(r))

        res = json.dumps(result, ensure_ascii=False)
        msg = prepare_output(self.name, res)
        sys.stdout.write(msg)
        sys.stdout.flush()


GetMembers()
CreateVariableObject()
`;

const getVar = `from pickletools import long1
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
            lst.append({ "name": member, "display": "{0}".format(value[member].type), "isPrimitive": True })

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
                result.append({ "name": member, "display": "{0}".format(value[member].type), "isPrimitive": True })


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
                    variables.append(v)
                else:
                    v = {
                        "name": symbol.name,
                        "display": str(value.type),
                        "isPrimitive": False
                    }
                    variables.append(v)


        res = json.dumps(variables, ensure_ascii=False)
        msg = prepare_output(self.name, res)
        sys.stdout.write(msg)
        sys.stdout.flush()


localsAndArgsCommand = LocalsAndArgs()
`

module.exports = {
  getVar,
  midasPy
}