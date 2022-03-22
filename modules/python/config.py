"""the config module holds settings for Midas but it also keeps global state for the backend."""

import gdb
from enum import Enum, unique
from midas_utils import memberIsReference
from frame_operations import find_first_identical_frames, take_n_frames

global isDevelopmentBuild
global setTrace
global currentExecutionContext
global executionContexts
global variableReferenceCounter

variableReferenceCounter = 0
isDevelopmentBuild = False
setTrace = False

def createVSCStackFrame(frame):
    try:
        res = vscFrameFromFn(frame, frame.function())
        return res
    except:
        res = vscFrameFromNoSymtab(frame.name(), frame)
        return res

def vscFrameFromFn(frame, functionSymbol):
    sal = frame.find_sal()
    functionSymbolTab = functionSymbol.symtab
    filename = path.basename(functionSymbolTab.filename)
    fullname = functionSymbolTab.fullname()
    line_number = sal.line
    # DebugProtocol.Source
    src = { "name": filename, "path": fullname, "sourceReference": 0 }
    stackStart = frame.read_register("rbp")
    sf = {
        "id": config.nextVariableReference(),
        "source": src,
        "line": line_number,
        "column": 0,
        "name": "{}".format(functionSymbol.name),
        "address": frame.pc(),
        "stackAddressStart": int(stackStart),
    }
    return sf

def vscFrameFromNoSymtab(name, frame):
    sal = frame.find_sal()
    line_number = sal.line
    # DebugProtocol.Source
    src = None
    try:
        src = { "name": path.basename(sal.symtab.filename), "path": sal.symtab.fullname(), "sourceReference": 0 }
    except:
        pass

    stackStart = frame.read_register("rbp")
    sf = {
        "id": config.nextVariableReference(),
        "source": src,
        "line": line_number,
        "column": 0,
        "name": name,
        "address": frame.pc(),
        "stackAddressStart": int(stackStart),
    }
    return sf

@unique
class DisplayItemType(Enum):
    Variable = 1
    BaseClass = 2
    Static = 3
    Synthetic = 4


def nextVariableReference():
    res = variableReferenceCounter + 1
    variableReferenceCounter = res
    return res

# Midas Terminology
# Execution Context: Thread (id) and Frame (level)

# Registers the current execution context
class CurrentExecutionContext:
    inferior = None
    def __init__(self):
        self.threadId = -1
        self.frameLevel = -1
        CurrentExecutionContext.inferior = gdb.selected_inferior()

    def set_thread(self, threadId):
        if self.threadId != threadId:
            for t in CurrentExecutionContext.inferior.threads():
                if t.num == threadId:
                    t.switch()
                    self.threadId = t.num
                    return t
        else:
            return gdb.selected_thread()

    def set_frame(self, level):
        if self.frameLevel != int(level):
            gdb.execute("frame {}".format(level))
            frame = gdb.selected_frame()
            self.frameLevel = frame.level()
            return frame
        else:
            return gdb.selected_frame()

    def set_context(self, threadId, frameLevel):
        t = self.set_thread(threadId=int(threadId))
        f = self.set_frame(level=int(frameLevel))
        return (t, f)

currentExecutionContext = CurrentExecutionContext()
executionContexts = {}

def typeIsPrimitive(valueType):
    try:
        for f in valueType.fields():
            if hasattr(f, "enumval"):
                return True
            else:
                return False
    except TypeError:
        return True

def getMembersRecursively(field, memberList, statics):
    if hasattr(field, 'bitpos'):
        if field.is_base_class:
            for f in field.type.fields():
                getMembersRecursively(
                    f, memberList=memberList, statics=statics)
        else:
            if field.name is not None and not field.name.startswith("_vptr"):
                memberList.append(field.name)
    else:
        statics.append(field.name)

class BaseClass:
    def __init__(self, name, rootValue):
        self.name = name
        # the actual gdb value, for whom this is a base type for
        self.value = rootValue
        self.variableRef = nextVariableReference()

    def display(self):
        return { "name": "(base)", "display": "%s" % self.name, "variableReference": self.variableRef, "type": DisplayItemType.BaseClass.value }

    def get_variable_reference(self):
        return self.variableRef

    def get_children(self):
        0

class StaticVariable:
    def __init__(self, name, rootvalue):
        self.name = name
        self.value = rootvalue
        self.variableRef = nextVariableReference()

    def display(self):
        return { "name": "value", "display": "%s" % self.name, "variableReference": self.variableRef, "type": DisplayItemType.Static.value }

    def get_variable_reference(self):
        return self.variableRef

    def get_children(self):
        0

class Variable:
    def __init__(self, name, gdbValue):
        self.name = name
        self.value = gdbValue
        self.variableRef = -1
        self.base_children = []
        self.children = []
        self.statics_children = []

    def from_symbol(symbol, frame):
        return Variable(symbol.name, symbol.value(frame).reference_value())

    def get_variable_reference(self):
        if self.variableRef == -1:
            if typeIsPrimitive(self.value.type):
                vr = nextVariableReference()
                self.variableRef = vr
            else:
                self.variableRef = 0
        return self.variableRef

    def display(self):
        v = self.get_value()
        if v.is_optimized_out:
            return { "name": self.name, "display": "<optimized out>", "variableReference": 0 }
        vr = self.get_variable_reference()
        if vr != 0:
            if self.value.type.code == gdb.TYPE_CODE_PTR:
                return { "name": self.name, "display": "<{}> {}".format(self.value, self.value.type), "variableReference": vr }
            else:
                return { "name": self.name, "display": "{}".format(self.value.type), "variableReference": vr }
        else:
            return { "name": self.name, "display": "{}".format(self.value.referenced_value()), "variableReference": vr }

    def get_value(self):
        return self.value.referenced_value()

    def get_children(self):
        0

def display_local(name, display, variableReference, static, synthetic):
    return { "name": name, "display": display, "variableReference": variableReference, "static": static, "synthetic": synthetic }

class StackFrame:
    def __init__(self, frame):
        self.frame = frame
        self.blocks = []

        self.locals = {}
        self.localsReference = nextVariableReference()
        self.args = []
        self.argsReference = nextVariableReference()
        self.variableReferences = {}

        self.registerReference = nextVariableReference()
        self.block_values = []
        self.init = False
        self.vsframe = createVSCStackFrame(frame)

    def initialize(self):
        """Initialize this stack frame based on the current block it's in. This does not mean
        it is fully initialized as new sub blocks may come into existence."""
        if self.init:
            return

        b = self.frame.block()
        last = b
        while not b.is_static and not b.superblock.is_global:
            last = b
            self.blocks.insert(0, last)
            b = b.superblock

        index = 0
        invalidBlockIndices = []
        for block in self.blocks:
            if block.is_valid:
                blockvalues = []
                for symbol in block:
                    if symbol.is_variable and not symbol.is_argument:
                        v = Variable.from_symbol(symbol, self.frame)
                        vr = v.get_variable_reference()
                        self.variableReferences[vr] = v
                        blockvalues.append(v)
                    elif symbol.is_argument:
                        v = Variable.from_symbol(symbol, self.frame)
                        vr = v.get_variable_reference()
                        self.variableReferences[vr] = v
                        self.args.append(v)
                self.block_values.append(blockvalues)
                index += 1
            else:
                invalidBlockIndices.append(index)
                index += 1
        if len(invalidBlockIndices) != 0:
            for idx in invalidBlockIndices:
                self.blocks.pop(idx)
                self.block_values.pop(idx)
        self.init = True

    def update_blocks(self):
        self.initialize()
        currentBlock = self.frame.block()
        # means we're still in the same block as last time we checked
        if currentBlock.start == self.blocks[-1].start:
            return

        newblocks = []
        while not currentBlock.is_static and not currentBlock.superblock.is_global:
            for index, block in reversed(list(enumerate(self.blocks))):
                if block.start == currentBlock.start:
                    self.blocks = self.blocks[:index+1]
                    self.block_values = self.block_values[:index+1]
                    for newblock in newblocks:
                        blockvalues = []
                        for symbol in newblock:
                            if symbol.is_variable and not symbol.is_argument:
                                v = Variable.from_symbol(symbol, self.frame)
                                blockvalues.append(v)
                                vr = v.get_variable_reference()
                                self.variableReferences[vr] = v

                    self.block_values.append(blockvalues)
                    return
            newblocks.insert(0, currentBlock)
            currentBlock = currentBlock.superblock

    def getLocals(self):
        self.update_blocks()
        res = {}
        for block_values in self.block_values:
            for v in block_values:
                res[v.name] = v
        result = []
        for v in res.values():
            vr = v.getVariableReference()
            if vr != 0:
                self.variableReferences[vr] = v
            result.append(v.display())

    def getRegisters(self):
        0

    def getArgs(self):
        0

    def getVariableMembers(self, variableReference):
        var = self.variableReferences.get(variableReference)
        vr = var.getVariableReference()
        if vr == 0:
            raise gdb.GdbError("Primitive types do not have members")
        pp = gdb.default_visualizer(var.get_value())
        result = []
        if var.is_init:
            return 0

        # if pp exist _and_ it has children produce members from that. otherwise brute force it
        if pp is not None:
            if hasattr(pp, "children"):
                for name, value in pp.children():
                    v = Variable(name, value)
                    vref = v.get_variable_reference()
                    if vref != 0:
                        self.variableReferences[vref] = v
                    result.append(v.display())
                return result
            else:
                res = pp.to_string()
                if hasattr(res, "value"):
                    result.append({"name": "value", "display": res.value(), "variableReference": 0 })
                else:
                    result.append({"name": "value", "display": "{}".format(res), "variableReference": 0})
                return result

        it = var.get_value()
        if memberIsReference(it.type):
            it = it.referenced_value()
            fields = it.type.fields()
            for field in fields:
                if hasattr(field, 'bitpos') and field.name is not None and not field.name.startswith("_vptr") and not field.is_base_class:
                    v = Variable(field.name, it[field])
                    vr = v.get_variable_reference()
                    if vr != 0:
                        self.variableReferences[vr] = v
                    result.append(v.display())
                elif field.is_base_class:
                    v = BaseClass(field.name, it)
                    vr = v.get_variable_reference()
                    self.variableReferences[vr] = v
                    result.append(v.display())
                elif not hasattr(field, "bitpos"):
                    v = StaticVariable(field.name, it)
                    vr = v.get_variable_reference()
                    self.variableReferences[vr] = v
                    result.append(v.display())


    def get(self, variableReference):
        if variableReference == self.localsReference:
            return self.getLocals()
        elif variableReference == self.argsReference:
            return self.getArgs()
        elif variableReference == self.registerReference:
            return self.getRegisters()
        else:
            return self.getVariableMembers(variableReference=variableReference)

    def getVSFrame(self):
        return self.vsframe

    def get_frame(self):
        return self.frame

    def is_same_frame(self, frame):
        return self.frame == frame

class ExecutionContext:
    def __init__(self, threadId):
        self.threadId = threadId
        # VSCodeStackFrame[]
        self.stack = []
        # gdb.Frame[]
        self.backtrace = []

    def get_frames(self, start, levels):
        (t, f) = currentExecutionContext.set_context(self.threadId, start)
        result = []
        if len(self.stack) > 0:
            if self.stack[0].is_same_frame(f):
                for sf in self.stack:
                    result.append(sf.getVSFrame())
                return result
            # compare just the top 10, if they share nothing, invalidate everything.
            res = find_first_identical_frames(self.stack, f, 10)
            if res is not None:
                (x, y) = res
                if x < y:
                    frames_to_add = [f for f in take_n_frames(f, y - x)]
                    for f in reversed(frames_to_add):
                        self.stack.insert(0, StackFrame(f))
                elif x > y:
                    self.stack = self.stack[y:]
                    if len(self.stack) < start + levels:
                        remainder = (start + levels) - len(self.stack)
                        for frame in take_n_frames(self.stack[-1].frame, remainder):
                            self.stack.append(StackFrame(f))
                else:
                    raise gdb.GdbError("This should not be possible.")
            else:
                for frame in take_n_frames(f, levels):
                    self.stack.append(StackFrame(frame))
        else:
            for frame in take_n_frames(f, levels):
                self.stack.append(StackFrame(frame))
        result = []
        for sf in self.stack:
            result.append(sf.getVSFrame())
        return result

def createExecutionContext(threadId: int):
    if executionContexts.get(threadId) is not None:
        raise gdb.GdbError("Trying to create execution context for an already created context.")
    ec = ExecutionContext(threadId)
    executionContexts[threadId] = ec
    return ec