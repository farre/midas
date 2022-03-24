from typing import Union
import gdb
import logging
import json

from os import path
import config
from variable import Variable, BaseClass, StaticVariable


def createVSCStackFrame(frame, alreadyReffedId = None):
    try:
        res = vscFrameFromFn(frame, frame.function(), alreadyReffedId)
        return res
    except:
        res = vscFrameFromNoSymtab(frame.name(), frame, alreadyReffedId)
        return res

def vscFrameFromFn(frame, functionSymbol, alreadyReffedId):
    sal = frame.find_sal()
    functionSymbolTab = functionSymbol.symtab
    filename = path.basename(functionSymbolTab.filename)
    fullname = functionSymbolTab.fullname()
    line_number = sal.line
    # DebugProtocol.Source
    src = { "name": filename, "path": fullname, "sourceReference": 0 }
    stackStart = frame.read_register("rbp")
    id = alreadyReffedId
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
    def __init__(self, frame, threadId):
        """Creates a stack frame. Used for querying about local variables, arguments etc.
        Mutates the global VariableReference map by registering it's 3 'top level' variable references."""
        self.frame = frame
        self.threadId = threadId
        self.blocks = []

        self.locals = {}
        self.localsReference = config.nextVariableReference()
        self.args = []
        self.argsReference = config.nextVariableReference()

        self.variableReferences: dict[int, Union[Variable, BaseClass, StaticVariable]] = {}
        self.registerReference = config.nextVariableReference()

        self.block_values = []
        self.init = False

        self.scopes = [
            { "name": "Locals", "variablesReference": self.localsReference, "expensive": False, "presentationHint": "locals" },
            { "name": "Args", "variablesReference": self.argsReference, "expensive": False, "presentationHint": "arguments" },
            { "name": "Register", "variablesReference": self.registerReference, "expensive": False, "presentationHint": "register" } ]

        config.variableReferences.add_mapping(self.localsReference, self.threadId, self.localsReference)
        config.variableReferences.add_mapping(self.argsReference, self.threadId, self.localsReference)
        config.variableReferences.add_mapping(self.registerReference, self.threadId, self.localsReference)


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
                        if vr != 0:
                            config.variableReferences.add_mapping(vr, self.threadId, self.localsReference)
                            self.variableReferences[vr] = v
                        blockvalues.append(v)
                    elif symbol.is_argument:
                        v = Variable.from_symbol(symbol, self.frame)
                        vr = v.get_variable_reference()
                        if vr != 0:
                            config.variableReferences.add_mapping(vr, self.threadId, self.localsReference)
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
                                if vr != 0:
                                    config.variableReferences.add_mapping(vr, self.threadId, self.localsReference)
                                self.variableReferences[vr] = v

                    self.block_values.append(blockvalues)
                    return
            newblocks.insert(0, currentBlock)
            currentBlock = currentBlock.superblock

    def get_locals(self):
        self.update_blocks()
        res = {}
        for block_values in self.block_values:
            for v in block_values:
                res[v.name] = v
        result = []
        for v in res.values():
            vr = v.get_variable_reference()
            if vr != 0:
                config.variableReferences.add_mapping(vr, self.threadId, self.frame_id())
                self.variableReferences[vr] = v
            result.append(v.to_vs())
        return result

    def get_registers(self):
        result = []
        return result

    def get_args(self):
        result = []
        for arg in self.args:
            result.append(arg.to_vs())
        return result

    def get_variable_members(self, variableReference):
        var = self.variableReferences.get(variableReference)
        return var.get_children(self)

    def get(self, variableReference):
        if variableReference == self.localsReference:
            return self.get_locals()
        elif variableReference == self.argsReference:
            return self.get_args()
        elif variableReference == self.registerReference:
            return self.get_registers()
        else:
            return self.get_variable_members(variableReference=variableReference)

    def get_vs_frame(self):
        res = createVSCStackFrame(self.frame, self.localsReference)
        return res

    def get_frame(self):
        return self.frame

    def is_same_frame(self, frame):
        return self.frame == frame

    def get_scopes(self):
        return self.scopes

    def manages_variable_reference(self, variableReference):
        isScope = self.argsReference == variableReference or self.localsReference == variableReference or self.registerReference == variableReference
        if isScope:
            return True
        else:
            if self.variableReferences.get(variableReference) is not None:
                return True
            else:
                return False

    def frame_id(self):
        return self.localsReference
