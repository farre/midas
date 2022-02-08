import gdb
import sys
import json
import gdb.types
import traceback
import logging

logging.basicConfig(filename='update.log', filemode="w", encoding='utf-8', level=logging.DEBUG)

def parse_string_args(arg):
    return gdb.string_to_argv(arg)

def prepare_output(cmdName, contents):
    return '<gdbjs:cmd:{0} {1} {0}:cmd:gdbjs>'.format(cmdName, contents)

def typeIsPrimitive(valueType):
    try:
        valueType.fields()
        return False
    except TypeError:
        return True

def memberIsReference(type):
    code = type.code
    return code == gdb.TYPE_CODE_PTR or code == gdb.TYPE_CODE_REF or code == gdb.TYPE_CODE_RVALUE_REF

def getMembersRecursively(field, memberList):
    if hasattr(field, 'bitpos'):
        if field.is_base_class:
            for f in field.type.fields():
                getMembersRecursively(f, memberList)
        else:
            if field.name is not None and not field.name.startswith("_vptr"):
                memberList.append(field.name)


class VariableState:
    def __init__(self, name, v, isPrimitive):
        # expression path; e.g. tmp.m_date.m_day
        try:
            self.value_ref = v.reference_value()
        except:
            self.value = v
            self.value_ref = self.value

        self.value = v
        self.name = name
        # if isPrimitive = false, we do not update through this handle, we update through it's child handles, otherwise
        # we might unnecessarily update things "unseen" by the UI
        self.isPrimitive = isPrimitive

    def refresh(self):
        try:
            v = self.value_ref.referenced_value()
            self.value = v
        except:
            self.value
        return self.value

    def log(self):
        logging.info("VariableState: {0}".format(self.name))

class FrameState:
    def __init__(self, frameId, argsId):
        self.frameId = frameId
        self.argsId = argsId
        self.args = {}
        self.locals = {}
        self.varRef = {}
        self.varRef[self.frameId] = []
        self.varRef[self.argsId] = []

    def log_error(self):
        logging.error("Frame id: {0}".format(self.frameId))
        logging.error(" args id: {0}".format(self.argsId))
        logging.error("     args: {0}".format(self.args))
        logging.error("     locals: {0}".format(self.locals))
        logging.error("     varRef: {0}".format(self.varRef))

    
    def addArgument(self, path, vs):
        self.args[path] = vs

    def addLocal(self, path, vs):
        self.locals[path] = vs

    def add_arg(self, path, val, top, isPrimitive):
        self.args[path] = VariableState(path, val, isPrimitive)
        if top:
            self.varRef.get(self.argsId).append(self.args[path])
    
    def add_local(self, path, val, top, isPrimitive):
        self.locals[path] = VariableState(path, val, isPrimitive)
        if top:
            self.varRef.get(self.frameId).append(self.locals[path])
    
    def getVariable(self, path):
        value = self.locals.get(path)
        if value is not None:
            return value
        return self.args.get(path)

    def getVariableReference(self, varref):
        return self.varRef.get(varref)

    def getChildrenOf(self, pPath, assignedVarRef, scopeType):
        map = self.locals if scopeType == "locals" else self.args
        vref = map[pPath]
        referencedByAssignedVarRef = []
        value = vref.value
        if memberIsReference(value.type):
            value = value.referenced_value()

        members = []
        fields = value.type.fields()
        for f in fields:
            getMembersRecursively(f, members)

        result = []
        for member in members:
            subt = value[member].type
            path = "{0}.{1}".format(pPath, member)
            isPrimitive = False
            try:
                subt.fields()
                result.append({ "name": member, "display": "{0}".format(value[member].type), "isPrimitive": False })
            except TypeError:
                result.append({ "name": member, "display": "{0}".format(value[member]), "isPrimitive": True })
                isPrimitive = True
            vs = VariableState(member, value[member], isPrimitive)
            map[path] = vs
            referencedByAssignedVarRef.append(vs)
        
        self.varRef[assignedVarRef] = referencedByAssignedVarRef
        return result

    def getUpdateListOf(self, varRef):
        result = []        
        children = self.varRef.get(varRef)
        try:
            for child in children:
                if child.isPrimitive:
                    r = child.refresh()
                    result.append({ "name": child.name, "display": "{0}".format(r), "isPrimitive": True })
            
            if len(result) == 0:
                return None
        except Exception as e:
            logging.error("Exception thrown {0}".format(e))
            logging.error(traceback.format_exc())
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
        print(self.frames)
        return self.frames.get("{0}".format(frameId))

    def getUpdated(self, frameId):
        frame = self.frames.get(frameId)
        if frame is None:
            return None
        return frame.serialize_updates()

    def getUpdated(self, frameId, varRef):
        frame = self.frames.get(frameId)
        if frame is None:
            return None
        return frame.serialize_updates()

frameStates = ExecutionContext(0)

class Update(gdb.Command):

    def __init__(self):
        super(Update, self).__init__("gdbjs-update", gdb.COMMAND_USER)
        self.name = "update"

    def invoke(self, arguments, from_tty):
        
        [frameId, varRef] = parse_string_args(arguments)
        frame = frameStates.get_frame(frameId)

        updateList = frame.getUpdateListOf(varRef)
        res = json.dumps(updateList, ensure_ascii=False)
        msg = prepare_output(self.name, res)
        sys.stdout.write(msg)
        sys.stdout.flush()

updateCommand = Update()

class GetChildren(gdb.Command):

    def __init__(self):
        super(GetChildren, self).__init__("gdbjs-get-children", gdb.COMMAND_USER)
        self.name = "get-children"

    def invoke(self, arguments, from_tty):
        [frameId, path, assignedVarRef, request] = parse_string_args(arguments)
        frame = frameStates.get_frame("{0}".format(frameId))
        try:
            result = []
            result = frame.getChildrenOf(path, assignedVarRef, request)
            # if request == "args":
            #     result = frame.getChildrenOfArg(path, assignedVarRef)
            # elif request == "locals":
            #     result = frame.getChildrenOfLocal(path, assignedVarRef)

            res = json.dumps(result, ensure_ascii=False)
            msg = prepare_output(self.name, res)
            sys.stdout.write(msg)
            sys.stdout.flush()
        except Exception as e:
            logging.error("Exception thrown {0}".format(e))
            logging.error(traceback.format_exc())
            frame.log_error()


getChildrenCommand = GetChildren()

class LocalsAndArgs(gdb.Command):

    def __init__(self):
        super(LocalsAndArgs, self).__init__("gdbjs-localsargs", gdb.COMMAND_USER)
        self.name = "localsargs"

    def invoke(self, arguments, from_tty):
        [frameId, argsId, threadId, frameLevel] = parse_string_args(arguments)
        frameState = FrameState(frameId, argsId)
        frame = gdb.selected_frame()
        block = frame.block()
        names = set()
        variables = []
        args = []
        name = None
        for symbol in block:
            name = symbol.name
            if (name not in names) and (symbol.is_argument or
                symbol.is_variable):
                names.add(name)
                try:
                    value = symbol.value(frame)
                    if typeIsPrimitive(value.type):
                        v = {
                            "name": symbol.name,
                            "display": str(value),
                            "isPrimitive": True
                        }
                        if symbol.is_argument:
                            frameState.add_arg(symbol.name, value, True, True)
                            args.append(v)
                        else:
                            frameState.add_local(symbol.name, value, True, True)
                            variables.append(v)
                    else:
                        v = {
                            "name": symbol.name,
                            "display": str(value.type),
                            "isPrimitive": False
                        }
                        if symbol.is_argument:
                            frameState.add_arg(symbol.name, value, True, False)
                            args.append(v)
                        else:
                            frameState.add_local(symbol.name, value, True, False)
                            variables.append(v)
                except Exception as e:
                    logging.error("Err was thrown in LocalsAndArgs (gdbjs-localsargs) {0}. Name of symbol that caused error: {1}\nStack: {2}".format(e, name, traceback.format_exc()))
                    names.remove(name)

        frameStates.add_frame(frameId, frameState)

        result = {"args": args, "variables": variables }
        res = json.dumps(result, ensure_ascii=False)
        msg = prepare_output(self.name, res)
        sys.stdout.write(msg)
        sys.stdout.flush()


localsAndArgsCommand = LocalsAndArgs()