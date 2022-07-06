from typing import Union
import gdb
import logging
import json

from os import path
import config
from frame_operations import find_top_function_block, iterate_frame_blocks
from variable import Variable, BaseClass, StaticVariable


def create_stackframe_response(frame, alreadyReffedId=None):
    try:
        res = vs_stackframe_from_fn(frame, frame.function(), alreadyReffedId)
        return res
    except:
        res = vs_stackframe_from_no_symtab(frame.name(), frame, alreadyReffedId)
        return res


def vs_stackframe_from_fn(frame, functionSymbol, alreadyReffedId):
    sal = frame.find_sal()
    filename = path.basename(sal.symtab.filename)
    fullname = sal.symtab.fullname()
    line_number = sal.line
    # DebugProtocol.Source
    src = {"name": filename, "path": fullname, "sourceReference": 0}
    stackStart = frame.read_register("rbp")
    id = alreadyReffedId
    sf = {
        "id": id,
        "source": src,
        "line": line_number,
        "column": 0,
        "name": "{}".format(functionSymbol.name),
        "instructionPointerReference": frame.pc()
    }
    return sf


def vs_stackframe_from_no_symtab(name, frame, alreadyReffedId=None):
    sal = frame.find_sal()
    line_number = sal.line
    # DebugProtocol.Source
    src = None
    try:
        src = {"name": path.basename(sal.symtab.filename), "path": sal.symtab.fullname(), "sourceReference": 0}
    except:
        pass

    stackStart = frame.read_register("rbp")
    id = alreadyReffedId if alreadyReffedId is not None else config.next_variable_reference()
    sf = {
        "id": id,
        "source": src,
        "line": line_number,
        "column": 0,
        "name": name,
        "instructionPointerReference": frame.pc()
    }
    return sf


class RegisterDescriptors:

    def __init__(self, frame):
        self.general = []
        self.sse = []
        self.mmx = []
        for register_descriptor in frame.architecture().registers("general"):
            self.general.append(register_descriptor)
        for register_descriptor in frame.architecture().registers("sse"):
            self.sse.append(register_descriptor)
        for register_descriptor in frame.architecture().registers("mmx"):
            self.mmx.append(register_descriptor)

    def register_vs_result(reg_desc, frame):
        return {
            "name": reg_desc.name,
            "value": "{}".format(frame.read_register(reg_desc)),
            "evaluateName": None,
            "variablesReference": 0
        }

    def read_general_registers(self, frame):
        return [RegisterDescriptors.register_vs_result(reg_desc, frame) for reg_desc in self.general]

    def read_sse_registers(self, frame):
        return [RegisterDescriptors.register_vs_result(reg_desc, frame) for reg_desc in self.sse]

    def read_mmx_registers(self, frame):
        return [RegisterDescriptors.register_vs_result(reg_desc, frame) for reg_desc in self.mmx]


REGISTER_DESCRIPTOR_SETS: RegisterDescriptors = None


def scope(name, variableReference, presentationHint, expensive=False):
    return {
        "name": name,
        "variablesReference": variableReference,
        "expensive": expensive,
        "presentationHint": presentationHint
    }


class StackFrame:

    def __init__(self, frame, threadId, ec):
        """Creates a stack frame. Used for querying about local variables, arguments etc.
        Mutates the global VariableReference map by registering it's 3 'top level' variable references."""
        self.frame = frame
        self.threadId = threadId
        self.blocks = []

        self.locals = {}
        self.localsReference = config.next_variable_reference()
        self.args = []
        self.argsReference = config.next_variable_reference()
        self.watchVariableReferences: dict[int, Union[Variable, BaseClass, StaticVariable]] = {}
        self.variableReferences: dict[int, Union[Variable, BaseClass, StaticVariable]] = {}
        self.registerReference = config.next_variable_reference()

        self.statics = []
        self.staticVariableReferences = {}
        self.staticsReference = config.next_variable_reference()
        self.static_initialized = False
        self.block_values = []
        self.init = False
        self.watch_variables: dict[str, Variable] = {}
        self.freeFloating = []

        self.ec = ec

        self.scopes = [
            scope("Locals", self.localsReference, "locals"),
            scope("Args", self.argsReference, "arguments"),
            scope("Register", self.registerReference, "register"),
            scope("Statics", self.staticsReference, "static", expensive=True)  # _might_ be expensive
        ]

        config.variableReferences.add_mapping(self.localsReference, self)
        config.variableReferences.add_mapping(self.argsReference, self)
        config.variableReferences.add_mapping(self.registerReference, self)
        config.variableReferences.add_mapping(self.staticsReference, self)

    # called when going out of scope, deleting any previously watched variables from that level.
    def __del__(self):
        for freefloat in self.freeFloating:
            del self.ec.free_floating_watch_variables[freefloat]

    @config.timeInvocation
    def initialize(self):
        global REGISTER_DESCRIPTOR_SETS
        if self.init:
            return

        if REGISTER_DESCRIPTOR_SETS is None:
            REGISTER_DESCRIPTOR_SETS = RegisterDescriptors(self.frame)
        self.init = True

    @config.timeInvocation
    def get_locals(self):
        self.initialize()
        self.block_values = []
        self.variableReferences = {}
        # we want the innermost block-symbol with name X to be displayed
        # therefore we sort out the outermost. C++/C/etc can't reference them by name, any how.
        names = set()
        for b in iterate_frame_blocks(self.frame):
            blockvalues = []
            for symbol in b:
                if symbol.is_variable and not symbol.is_argument and symbol.name not in names and not symbol.addr_class == gdb.SYMBOL_LOC_OPTIMIZED_OUT:
                    v = Variable.from_symbol(symbol, self.frame)
                    blockvalues.append(v)
                    vr = v.get_variable_reference()
                    if vr != 0:
                        config.variableReferences.add_mapping(vr, self)
                        self.variableReferences[vr] = v
                    names.add(symbol.name)
            self.block_values.append(blockvalues)
        result = []
        for block_values in self.block_values:
            for v in block_values:
                result.append(v.to_vs())
        return result

    @config.timeInvocation
    def get_registers(self):
        global REGISTER_DESCRIPTOR_SETS
        self.initialize()
        return REGISTER_DESCRIPTOR_SETS.read_general_registers(self.frame)

    def static_initialize(self):
        if not self.static_initialized:
            b = find_top_function_block(self.frame).static_block
            for symbol in b:
                if symbol.is_variable and not symbol.addr_class == gdb.SYMBOL_LOC_OPTIMIZED_OUT:
                    v = Variable.from_symbol(symbol, self.frame)
                    self.statics.append(v)
                    vr = v.get_variable_reference()
                    if vr != 0:
                        config.variableReferences.add_mapping(vr, self)
                        self.staticVariableReferences[vr] = v
        self.static_initialized = True

    @config.timeInvocation
    def get_statics(self):
        self.static_initialize()
        return [v.to_vs() for v in self.statics]

    @config.timeInvocation
    def get_args(self):
        result = []
        names = set()
        for b in iterate_frame_blocks(self.frame):
            for symbol in b:
                if symbol.is_argument and not (symbol.addr_class == gdb.SYMBOL_LOC_OPTIMIZED_OUT) and symbol.name not in names:
                    v = Variable.from_symbol(symbol, self.frame)
                    vr = v.get_variable_reference()
                    if vr != 0:
                        config.variableReferences.add_mapping(vr, self)
                        self.variableReferences[vr] = v
                    result.append(v.to_vs())
                    names.add(symbol.name)
        return result

    @config.timeInvocation
    def get_variable_members(self, variableReference):
        var = self.variableReferences.get(variableReference)
        if var is not None:
            return var.get_children(self)
        var = self.staticVariableReferences.get(variableReference)
        if var is not None:
            return var.get_children(self)
        return self.watchVariableReferences[variableReference].get_children(self)

    def get(self, variableReference):
        if variableReference == self.localsReference:
            return self.get_locals()
        elif variableReference == self.argsReference:
            return self.get_args()
        elif variableReference == self.registerReference:
            return self.get_registers()
        elif variableReference == self.staticsReference:
            return self.get_statics()
        else:
            return self.get_variable_members(variableReference=variableReference)

    def get_vs_frame(self):
        res = create_stackframe_response(self.frame, self.localsReference)
        return res

    def get_frame(self):
        return self.frame

    def is_same_frame(self, frame):
        return self.frame == frame

    def get_scopes(self):
        return self.scopes

    @config.timeInvocation
    def manages_variable_reference(self, variableReference):
        isScope = self.argsReference == variableReference or self.localsReference == variableReference or self.registerReference == variableReference or self.staticsReference == variableReference
        if isScope:
            return True
        if self.variableReferences.get(variableReference) is not None:
            return True
        elif self.staticVariableReferences.get(variableReference) is not None:
            return True
        else:
            return self.watchVariableReferences.get(variableReference) is not None

    @config.timeInvocation
    def get_variable(self, variableReference):
        if self.variableReferences.get(variableReference) is not None:
            return self.variableReferences[variableReference]
        elif self.staticVariableReferences.get(variableReference) is not None:
            return self.staticVariableReferences[variableReference]
        else:
            return self.watchVariableReferences.get(variableReference)

    @config.timeInvocation
    def get_variable_by_name(self, name):
        config.update_logger().debug("Attempting to find {}".format(name))
        for bv in self.block_values:
            for value in bv:
                if value.name == name:
                    return value
        return None

    def is_watching(self, variableReference):
        return self.watchVariableReferences.get(variableReference) is not None

    def frame_id(self):
        return self.localsReference

    def add_watched_variable(self, expr, variable, start = 0, end = None):
        """ Adds variable to watch if it doesn't exist and returns created/existing `Variable`"""
        vr = None
        tmp = self.watch_variables.get(expr)
        if tmp is not None:
            vr = tmp.get_variable_reference()
        config.update_logger().debug("Adding {}".format(expr))
        v = Variable.from_value(expr, variable, expr, start, end)
        # assume the previous VRID, no need to keep incrementing; since we know the variable by expr anyway
        # this comes with the added benefit of the Python reference at self.watchVariableReferences[vr] going to 0 => de alloc
        v.variableRef = -1 if vr is None else vr
        v.set_watched()
        self.watch_variables[expr] = v
        vr = v.get_variable_reference()
        if vr != 0:
            config.update_logger().debug("added watch variable {}; tracked by {}".format(expr, vr))
            self.watchVariableReferences[vr] = v
            config.variableReferences.add_mapping(vr, self)
        return v

    def reference_key(self):
        return config.ReferenceKey(self.threadId, self.frame_id())

    def set_free_floating(self, expr):
        self.freeFloating.append(expr)

    def add_free_floating_watched_variable(self, expr, it, start = 0, end = None):
        var = self.add_watched_variable(expr, it, start, end)
        self.ec.set_free_floating(expr, var)
        self.set_free_floating(expr)
        return var
