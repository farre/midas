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

const getVar = `
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
            if not field.name.startswith("_vptr$"):
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
                result.append({ "member": member, "value": "{0}".format(value[member].type), "isPrimitive": False })
            except TypeError:
                result.append({ "member": member, "value": "{0}".format(value[member]), "isPrimitive": True })


        res = json.dumps(result, ensure_ascii=False)
        msg = prepare_output(self.name, res)
        sys.stdout.write(msg)
        sys.stdout.flush()

GetVariableContents()
`

module.exports = {
  getVar,
  midasPy
}