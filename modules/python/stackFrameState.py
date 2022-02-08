import gdb
import sys
import json
import gdb.types

from utils import parse_string_args, prepare_output, typeIsPrimitive, getMembersList, recursivelyBuild, memberIsReference, getStructMembers

class VariableState:
    def __init__(self, owningVariableReference, v):
        # expression path; e.g. tmp.m_date.m_day
        self.owningVariableReference = owningVariableReference
        self.value = v
        self.value_ref = v.reference_value()

    def refresh(self):
        v = self.value_ref.referenced_value()
        if v == self.value:
            return None
        self.value = v
        return self.value

class FrameState:
    def __init__(self):
        self.args = {}
        self.locals = {}
        self.varRef = {}
    
    def add_arg(self, path, variableReference, val):
        self.args[path] = VariableState(variableReference, val)
    
    def add_local(self, path, variableReference, val):
        self.locals[path] = VariableState(variableReference, val)
    
    def getVariable(self, path):
        value = self.locals.get(path)
        if value is not None:
            return value
        return self.args.get(path)
        

    def serialize_updates(self):
        updatedArgs = []
        updatedLocals = []
        for path in self.args:
            value = self.args[path].refresh()
            if value is not None:
                updatedArgs.append({ "owningVarRef": value.owningVariableReference, "path": path, "display": "{0}".format(value) })

        for path in self.locals:
            value = self.locals[path].refresh()
            if value is not None:
                updatedLocals.append({ "owningVarRef": value.owningVariableReference, "path": path, "display": "{0}".format(value) })

        if len(updatedArgs) == 0 and len(updatedLocals) == 0:
            return None
        
        res = json.dumps({"args": updatedArgs, "locals": updatedLocals}, ensure_ascii=False)
        return res

    # def recursivelyBuild(self, parent_path, value, lst, isArg):
    #     tmp = value
    #     if memberIsReference(value.type) and value != 0:
    #         try:
    #             v = value.referenced_value()
    #             value = v
    #         except gdb.MemoryError:
    #             value = tmp
        
    #     membersOfValue = getMembersList(value)
    #     for member in membersOfValue:
    #         subt = value[member].type
    #         name = "{0}.{1}".format(parent_path, member)
    #         try:
    #             subt.fields()
    #             lst.append({ "name": member, "display": "{0}".format(value[member].type), "isPrimitive": False, "payload":  self.recursivelyBuild(name, value[member], [], isArg) })
    #         except TypeError:
    #             lst.append({ "name": member, "display": "{0}".format(value[member]), "isPrimitive": True })
    #         if isArg:
    #             self.add_arg(name, value[member])
    #         else:
    #             self.add_local(name, value[member])

    #     return lst
    
    # def getChildren(self, var, isArg):
    #     result = []
    #     value = self.getVariable(var)
    #     if value is None:
    #         return None
        
    #     if memberIsReference(value.type):
    #         value = value.referenced_value()
        
    #     membersOfValue = getMembersList(value)
    #     for member in membersOfValue:
    #         subt = value[member].type
    #         try:
    #             subt.fields()
    #             result.append({ "name": member, "display": "{0}".format(value[member].type), "isPrimitive": False, "payload": self.recursivelyBuild("{0}".format(member), value[member], [], isArg) })
    #         except TypeError:
    #             result.append({ "name": member, "display": "{0}".format(value[member]), "isPrimitive": True })
    #         if isArg:
    #             self.add_arg("{0}.{1}".format(var, member), value[member])
    #         else:
    #             self.add_local("{0}.{1}".format(var, member), value[member])
    

    def getChildrenOf(self, owningVariableReference, var, isArg):
        result = []
        
        value = self.getVariable(var)
        # if memberIsReference(value.type):
        #    value = value.referenced_value()
        membersOfValue = getStructMembers(var, isArg)

        for member in membersOfValue:
            subt = value[member].type
            try:
                subt.fields()
                result.append({ "name": member, "display": "{0}".format(value[member].type), "isPrimitive": False })
            except TypeError:
                result.append({ "name": member, "display": "{0}".format(value[member]), "isPrimitive": True })
            if isArg:
                self.add_arg("{0}.{1}".format(var, member), owningVariableReference, value[member])
            else:
                self.add_local("{0}.{1}".format(var, member), owningVariableReference, value[member])
        
        return result

class ExecutionContext:
    # Currently, we don't care about threads. We *will* care about it though.
    Threads = 1
    def __init__(self, threadId):
        self.frames = {}
        self.threadId = ExecutionContext.Threads
        ExecutionContext.Threads += 1

    def add_frame(self, frameId, frame):
        self.frames[frameId] = frame

    def remove_frames(self, frameIds):
        for id in frameIds:
            del self.frames[id]

    def get_frame(self, frameId):
        return self.frames.get(frameId)

    def getUpdated(self, frameId):
        frame = self.frames.get(frameId)
        if frame is None:
            return None
        return frame.serialize_updates()

    def getUpdated(self, frameId, owningVariableReference):
        frame = self.frames.get(frameId)
        if frame is None:
            return None
        return frame.serialize_updates()

frameStates = ExecutionContext()

class RequestMore(gdb.Command):
    def __init__(self):
        super(RequestMore, self).__init__("gdbjs-request-more", gdb.COMMAND_USER)
        self.name = "request-more"

    def invoke(self, arg, from_tty):
        [frameId, forVariableReference, path, isArg] = parse_string_args(arg)
        frame = frameStates.get_frame(frameId)
        isArg = isArg == "true"
        res = frame.getChildrenOf(path, isArg)
        msg = prepare_output(self.name, res)
        sys.stdout.write(msg)
        sys.stdout.flush()

requestMore = RequestMore()

class RequestVariableReferenceUpdate(gdb.Command):
    def __init__(self):
        super(RequestVariableReferenceUpdate, self).__init__("gdbjs-request-varref-update", gdb.COMMAND_USER)
        self.name = "request-varref-update"

    def invoke(self, arg, from_tty):
        updates = frameStates.getUpdated(arg)
        msg = prepare_output(self.name, updates)
        sys.stdout.write(msg)
        sys.stdout.flush()

requestVarRefUpdateCommand = RequestVariableReferenceUpdate()

class RequestStackFrameUpdate(gdb.Command):
    def __init__(self):
        super(RequestStackFrameUpdate, self).__init__("gdbjs-request-frame-update", gdb.COMMAND_USER)
        self.name = "request-frame-update"

    def invoke(self, arg, from_tty):
        updates = frameStates.getUpdated(arg)
        msg = prepare_output(self.name, updates)
        sys.stdout.write(msg)
        sys.stdout.flush()

requestUpdateCommand = RequestStackFrameUpdate()

class LocalsAndArgs(gdb.Command):

    def __init__(self):
        super(LocalsAndArgs, self).__init__("gdbjs-localsargs", gdb.COMMAND_USER)
        self.name = "localsargs"

    def invoke(self, arguments, from_tty):
        frameState = FrameState()
        [frameId, threadId] = parse_string_args(arguments)
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
                        frameState.add_arg(symbol.name, frameId, v)
                        args.append(v)
                    else:
                        frameState.add_local(symbol.name, frameId, v)
                        variables.append(v)
                else:
                    v = {
                        "name": symbol.name,
                        "display": str(value.type),
                        "isPrimitive": False
                    }
                    if symbol.is_argument:
                        frameState.add_arg(symbol.name, frameId, v)
                        args.append(v)
                    else:
                        frameState.add_local(symbol.name, frameId, v)
                        variables.append(v)

        frameStates.add_frame(frameId, frameState)

        result = {"args": args, "variables": variables }
        res = json.dumps(result, ensure_ascii=False)
        msg = prepare_output(self.name, res)
        sys.stdout.write(msg)
        sys.stdout.flush()


localsAndArgsCommand = LocalsAndArgs()