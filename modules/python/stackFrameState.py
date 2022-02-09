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

    def logError(self):
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
            logExceptionBacktrace("Exception thrown.", e)
        return result

class EC:
    # Currently, we don't care about threads. We *will* care about it though.
    def __init__(self):
        self.framesStates = {}

    def add_frame(self, frameId, threadId, frame):
        logging.info("Adding frame {} for thread {}. Frame state: {}".format(frameId, threadId, frame))
        if self.framesStates.get(threadId) is None:
            self.framesStates[threadId] = {}
        self.framesStates[threadId][frameId] = frame

    def get_frame(self, threadId, frameId):
        if self.framesStates.get(threadId) is None:
            self.framesStates[threadId] = {}
        return self.framesStates.get(threadId).get(frameId)

    def log_ec(self):
        for key in self.framesStates:
            frameStatesOf = self.framesStates[key]
            logging.info("Thread ID {} \n\tFrame states: {} \n\tFrames in thread id = {}\n".format(key, len(frameStatesOf), ec.framesStates[key]))
    
    def initialize_frame(self, frameId, threadId, argsId):
        if self.framesStates.get(threadId) is None:
            self.framesStates[threadId] = {}
        if self.framesStates.get(threadId).get(frameId) is None:
            self.framesStates.get(threadId)[frameId] = FrameState(frameId = frameId, argsId=argsId)


ec = EC()

class Update(gdb.Command):
    def __init__(self):
        super(Update, self).__init__("gdbjs-update", gdb.COMMAND_USER)
        self.name = "update"

    def invoke(self, arguments, from_tty):
        [frameId, varRef, threadId] = parseStringArgs(arguments)
        frame = ec.get_frame(threadId, frameId)

        updateList = frame.getUpdateListOf(varRef)
        res = json.dumps(updateList, ensure_ascii=False)
        msg = prepareOutput(self.name, res)
        sys.stdout.write(msg)
        sys.stdout.flush()

updateCommand = Update()


class GetChildren(gdb.Command):

    def __init__(self):
        super(GetChildren, self).__init__("gdbjs-get-children", gdb.COMMAND_USER)
        self.name = "get-children"

    def invoke(self, arguments, from_tty):
        [frameId, path, assignedVarRef, request, threadId] = parseStringArgs(arguments)
        logging.info("get children {} {} {} {} {}".format(frameId, path, assignedVarRef, request, threadId))
        frame = ec.get_frame(threadId, frameId)
        try:
            result = []
            result = frame.getChildrenOf(path, assignedVarRef, request)
            # if request == "args":
            #     result = frame.getChildrenOfArg(path, assignedVarRef)
            # elif request == "locals":
            #     result = frame.getChildrenOfLocal(path, assignedVarRef)

            res = json.dumps(result, ensure_ascii=False)
            msg = prepareOutput(self.name, res)
            sys.stdout.write(msg)
            sys.stdout.flush()
        except Exception as e:
            logExceptionBacktrace("Exception thrown.", e)
            frame.log_error()


getChildrenCommand = GetChildren()



class FrameLocals(gdb.Command):

    def __init__(self):
        super(FrameLocals, self).__init__("gdbjs-frame-locals", gdb.COMMAND_USER)
        self.name = "frame-locals"

    def invoke(self, arguments, from_tty):
        [frameId, argsId, threadId, frameLevel] = parseStringArgs(arguments)
        selectThreadAndFrame(threadId=threadId, frameLevel=frameLevel)
        logging.info("frame-locals: frame id {0} argsId: {1} threadId: {2} frameLevel: {3}".format(frameId, argsId, threadId, frameLevel))
        try:
            frameState = ec.get_frame(threadId=threadId, frameId=frameId)
            if frameState is None:
                ec.initialize_frame(frameId=frameId, threadId=threadId, argsId=argsId)
                frameState = ec.get_frame(threadId=threadId, frameId=frameId)
            if frameState is None:
                logging.error("Failed to get initialized frame state. ThreadId: {} - FrameId: {} Level: {}".format(threadId, frameId, frameLevel))
            frame = gdb.selected_frame()
            block = getFunctionBlock(frame)
            names = set()
            result = []
            name = None
            for symbol in block:
                name = symbol.name
                if (name not in names) and symbol.is_variable and not symbol.is_argument:
                    names.add(name)
                    try:
                        value = symbol.value(frame)
                        if typeIsPrimitive(value.type):
                            v = {
                                "name": symbol.name,
                                "display": str(value),
                                "isPrimitive": True
                            }
                            frameState.add_local(symbol.name, value, True, True)
                            result.append(v)
                        else:
                            v = {
                                "name": symbol.name,
                                "display": str(value.type),
                                "isPrimitive": False
                            }
                            frameState.add_local(symbol.name, value, True, False)
                            result.append(v)
                    except Exception as e:
                        logExceptionBacktrace("Err was thrown in FrameLocals (gdbjs-frame-locals). Name of symbol that caused error: {0}\n".format(name), e)
                        names.remove(name)
            ec.add_frame(frameId, threadId, frameState)
            ec.log_ec()
            res = json.dumps(result, ensure_ascii=False)
            msg = prepareOutput(self.name, res)
            sys.stdout.write(msg)
            sys.stdout.flush()
        except Exception as e:
            logExceptionBacktrace("Exception thrown in FrameLocals.invoke", e)
            for fs in ec.framesStates:
                logging.info("frame state: {}".format(fs))

frameLocalsCommand = FrameLocals()

class FrameArgs(gdb.Command):

    def __init__(self):
        super(FrameArgs, self).__init__("gdbjs-frame-args", gdb.COMMAND_USER)
        self.name = "frame-args"

    def invoke(self, arguments, from_tty):
        [frameId, argsId, threadId, frameLevel] = parseStringArgs(arguments)
        selectThreadAndFrame(threadId=threadId, frameLevel=frameLevel)
        logging.info("frame-args: frame id {0} argsId: {1} threadId: {2} frameLevel: {3}".format(frameId, argsId, threadId, frameLevel))
        try:
            frameState = ec.get_frame(threadId, frameId)
            if frameState is None:
                ec.initialize_frame(frameId=frameId, threadId= threadId, argsId=argsId)
                frameState = ec.get_frame(threadId, frameId)
            if frameState is None:
                logging.error("Failed to get initialized frame state. ThreadId: {} - FrameId: {} Level: {}".format(threadId, frameId, frameLevel))
            frame = gdb.selected_frame()
            block = getFunctionBlock(frame)
            names = set()
            result = []
            name = None
            for symbol in block:
                name = symbol.name
                if (name not in names) and symbol.is_argument:
                    names.add(name)
                    try:
                        value = symbol.value(frame)
                        if typeIsPrimitive(value.type):
                            v = {
                                "name": symbol.name,
                                "display": str(value),
                                "isPrimitive": True
                            }
                            frameState.add_arg(symbol.name, value, True, True)
                            result.append(v)
                        else:
                            v = {
                                "name": symbol.name,
                                "display": str(value.type),
                                "isPrimitive": False
                            }
                            frameState.add_arg(symbol.name, value, True, False)
                            result.append(v)
                    except Exception as e:
                        logExceptionBacktrace("Err was thrown in FrameArgs (gdbjs-frame-args). Name of symbol that caused error: {0}\n".format(name), e)
                        names.remove(name)
            ec.add_frame(frameId, threadId, frameState)
            ec.log_ec()
            res = json.dumps(result, ensure_ascii=False)
            msg = prepareOutput(self.name, res)
            sys.stdout.write(msg)
            sys.stdout.flush()
        except Exception as e:
            logExceptionBacktrace("Exception thrown in FrameArgs.invoke", e)
            for fs in ec.framesStates:
                logging.info("frame state: {}".format(fs))

frameArgsCommand = FrameArgs()