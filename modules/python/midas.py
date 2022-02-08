import gdb
import sys
import json
import gdb.types

from utils import getMembersList, prepare_output

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


# create-varobj *f
GetMembers()
CreateVariableObject()