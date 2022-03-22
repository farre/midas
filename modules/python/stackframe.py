import gdb
from os import path
import config
from midas_utils import memberIsReference
from variablesrequest import Variable, BaseClass, StaticVariable

def createVSCStackFrame(frame, alreadyReffedId = None):
    try:
        res = vscFrameFromFn(frame, frame.function(), alreadyReffedId)
        return res
    except:
        res = vscFrameFromNoSymtab(frame.name(), frame, alreadyReffedId)
        return res

def vscFrameFromFn(frame, functionSymbol, alreadyReffedId = None):
    sal = frame.find_sal()
    functionSymbolTab = functionSymbol.symtab
    filename = path.basename(functionSymbolTab.filename)
    fullname = functionSymbolTab.fullname()
    line_number = sal.line
    # DebugProtocol.Source
    src = { "name": filename, "path": fullname, "sourceReference": 0 }
    stackStart = frame.read_register("rbp")
    id = alreadyReffedId if alreadyReffedId is not None else config.nextVariableReference()
    sf = {
        "id": id,
        "source": src,
        "line": line_number,
        "column": 0,
        "name": "{}".format(functionSymbol.name),
        "address": frame.pc(),
        "stackAddressStart": int(stackStart),
    }
    return sf

def vscFrameFromNoSymtab(name, frame, alreadyReffedId = None):
    sal = frame.find_sal()
    line_number = sal.line
    # DebugProtocol.Source
    src = None
    try:
        src = { "name": path.basename(sal.symtab.filename), "path": sal.symtab.fullname(), "sourceReference": 0 }
    except:
        pass

    stackStart = frame.read_register("rbp")
    id = alreadyReffedId if alreadyReffedId is not None else config.nextVariableReference()
    sf = {
        "id": id,
        "source": src,
        "line": line_number,
        "column": 0,
        "name": name,
        "address": frame.pc(),
        "stackAddressStart": int(stackStart),
    }
    return sf

class StackFrame:
    def __init__(self, frame):
        self.frame = frame
        self.blocks = []

        self.locals = {}
        self.localsReference = config.nextVariableReference()
        self.args = []
        self.argsReference = config.nextVariableReference()
        self.variableReferences = {}

        self.registerReference = config.nextVariableReference()
        self.block_values = []
        self.init = False

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
        return createVSCStackFrame(self.frame, self.localsReference)

    def get_frame(self):
        return self.frame

    def is_same_frame(self, frame):
        return self.frame == frame