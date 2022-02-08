import gdb
import sys
import json
import gdb.types

from utils import parse_string_args, getMembersList, memberIsReference, prepare_output, typeIsPrimitive, getMemberValue, recursivelyBuild


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


class Locals(gdb.Command):

    def __init__(self):
        super(Locals, self).__init__("gdbjs-getlocals", gdb.COMMAND_USER)
        self.name = "getlocals"

    def invoke(self, arg, from_tty):
        frame = gdb.selected_frame()
        block = frame.block()
        names = set()
        variables = []
        args = []
        for symbol in block:
            name = symbol.name
            if (name not in names) and (symbol.is_variable and not symbol.is_argument):
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


localsCommand = Locals()

class Args(gdb.Command):

    def __init__(self):
        super(Args, self).__init__("gdbjs-getargs", gdb.COMMAND_USER)
        self.name = "getargs"

    def invoke(self, arg, from_tty):
        # [frameLevel, threadId] = parse_string_args(arg)
        frame = gdb.selected_frame()
        block = frame.block()
        names = set()
        variables = []
        for symbol in block:
            name = symbol.name
            if (name not in names) and (symbol.is_variable and symbol.is_argument):
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

argsCommand = Args()

# class LocalsAndArgs(gdb.Command):

#     def __init__(self):
#         super(LocalsAndArgs, self).__init__("gdbjs-localsargs", gdb.COMMAND_USER)
#         self.name = "localsargs"

#     def invoke(self, arg, from_tty):
#         frame = gdb.selected_frame()
#         block = frame.block()
#         names = set()
#         variables = []
#         args = []
#         for symbol in block:
#             name = symbol.name
#             if (name not in names) and (symbol.is_argument or
#                 symbol.is_variable):
#                 names.add(name)
#                 value = symbol.value(frame)
#                 if typeIsPrimitive(value.type):
#                     v = {
#                         "name": symbol.name,
#                         "display": str(value),
#                         "isPrimitive": True
#                     }
#                     if symbol.is_argument:
#                         args.append(v)
#                     else:
#                         variables.append(v)
#                 else:
#                     v = {
#                         "name": symbol.name,
#                         "display": str(value.type),
#                         "isPrimitive": False
#                     }
#                     if symbol.is_argument:
#                         args.append(v)
#                     else:
#                         variables.append(v)

#         result = {"args": args, "variables": variables }
#         res = json.dumps(result, ensure_ascii=False)
#         msg = prepare_output(self.name, res)
#         sys.stdout.write(msg)
#         sys.stdout.flush()


# localsAndArgsCommand = LocalsAndArgs()


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