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