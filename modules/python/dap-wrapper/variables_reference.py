import gdb
from os import path
import traceback

variableReferences = {}
exceptionInfos = {}


def clear_variable_references(evt):
    global variableReferences
    global exceptionInfos
    variableReferences.clear()
    exceptionInfos.clear()


gdb.events.cont.connect(clear_variable_references)


def can_var_ref(value):
    actual_type = value.type.strip_typedefs()
    return (
        actual_type.code == gdb.TYPE_CODE_STRUCT
        or actual_type.code == gdb.TYPE_CODE_PTR
    )


# Base class Widget Reference - representing a container-item/widget in the VSCode UI
class VariablesReference:
    def __init__(self, name):
        global variableReferences
        self.name = name
        self.id = len(variableReferences) + 1
        variableReferences[self.id] = self

    def contents(self):
        raise Exception("'contents' method not supported by this class")

    def find_value(self, name):
        raise Exception("'find_value' method not supported by this class")


def frame_name(frame):
    fn = frame.function()
    if fn is not None:
        return fn.name
    else:
        return "frame"


class StackFrame(VariablesReference):
    def __init__(self, gdbFrame, thread):
        super(StackFrame, self).__init__(frame_name(gdbFrame))
        self.gdbFrame = gdbFrame
        self.thread = thread
        self._scopes = [
            ScopesReference("Args", self, args),
            ScopesReference("Locals", self, locals),
        ]

    def contents(self):
        sal = self.gdbFrame.find_sal()
        line_number = sal.line
        try:
            filename = path.basename(sal.symtab.filename)
            fullname = sal.symtab.fullname()
            src = {"name": filename, "path": fullname}
        except:
            src = None
        # DebugProtocol.Source

        sf = {
            "id": self.id,
            "source": src,
            "line": line_number,
            "column": 0,
            "name": "{}".format(self.name),
            "instructionPointerReference": hex(self.gdbFrame.pc()),
        }
        return sf

    def frame(self):
        self.thread.switch()
        return self.gdbFrame

    def scopes(self):
        res = []
        for scope in self._scopes:
            scope_res = {"name": scope.name, "variablesReference": scope.id}
            res.append(scope_res)
        return res


def is_primitive(type):
    return hasattr(type, "fields")


def members(value):
    type = value.type
    if type.code == gdb.TYPE_CODE_PTR:
        try:
            type = value.type.target()
        except:
            type = value.type

    for f in type.fields():
        yield (f.name, value[f])


def frame_top_block(frame):
    frame.select()
    block = frame.block()
    res = block
    if block is None:
        return None
    while not block.is_static:
        res = block
        block = block.superblock
    return res


# Unfortunately, the DAP-gods in their infinite wisdom, named this concept "VariablesReference"
# something that refers to basically Widget/UI ID's, that can be a "Scope" like a container containing
# the variables that are locals or arguments, or anything really. So to actually signal, that this type
# refers to actual *variables* and their "children" we have to name it VariableValueReference to make
# any distinction between this and the base class
class VariableValueReference(VariablesReference):
    def __init__(self, name, gdbValue):
        super(VariableValueReference, self).__init__(name)
        self.value = gdbValue
        if self.value.type.code == gdb.TYPE_CODE_PTR:
            self.display = "{} ({})".format(self.value.type, hex(int(self.value)))
        else:
            self.display = "{}".format(self.value.type)

    def ui_data(self):
        address = (
            hex(int(self.value.address)) if self.value.address is not None else None
        )
        return {
            "name": self.name,
            "value": self.display,
            "type": f"{self.value.type}",
            "evaluateName": None,
            "variablesReference": self.id,
            "namedVariables": None,
            "indexedVariables": None,
            "memoryReference": address,
        }

    def pp_contents(self, pp, format, start, count):
        res = []
        if hasattr(pp, "children"):
            for (name, val) in pp.children():
                if can_var_ref(val):
                    ref = VariableValueReference(name, val)
                    indexed = pp.num_children() if hasattr(pp, "num_children") else None
                    v = f"{val.type}"
                    item = to_vs(
                        name, v, val.type, None, ref.id, None, indexed, val.address
                    )
                    res.append(item)
                else:
                    res.append(
                        to_vs(name, val, val.type, None, 0, None, None, val.address)
                    )
        else:
            v = pp.to_string()
            t = self.value.type
            a = self.value.address
            res.append(to_vs("value", v, t, None, 0, None, None, a))
        return res

    def contents(self, format=None, start=None, count=None):
        try:
            if self.value.type.code == gdb.TYPE_CODE_PTR:
                try:
                    self.value = self.value.dereference()
                except:
                    pass
            pp = gdb.default_visualizer(self.value)
            if pp is not None:
                return self.pp_contents(pp, format, start, count)
            else:
                res = []
                for (name, v) in members(self.value):
                    if can_var_ref(v):
                        ref = VariableValueReference(name, v)
                        res.append(
                            to_vs(name, v, v.type, None, ref.id, None, None, v.address)
                        )
                    else:
                        res.append(
                            to_vs(name, v, v.type, None, 0, None, None, v.address)
                        )
                return res
        except:
            return []

    def find_value(self, find_name):
        """find_value will _always_ be called after a call to .contents() has been made
        Because of this, we can be sure that if this Var Ref was a pointer, it has
        been dereferenced."""
        assert (
            self.value.type.code != gdb.TYPE_CODE_PTR
        ), "Value has not yet been dereferenced - this state should be impossible."
        pp = gdb.default_visualizer(self.value)
        if pp is not None:
            for (name, val) in pp.children():
                if name == find_name:
                    return val
        else:
            for (name, val) in members(self.value):
                if name == find_name:
                    return val
        raise Exception(
            f"Could not find name {find_name} in variables reference container {self.name} with id {self.id}"
        )


# Midas defines some scopes: Args, Locals, Registers
# TODO(simon): Add Statics, Globals
class ScopesReference(VariablesReference):
    def __init__(self, name, stackFrame, variablesGetter):
        super(ScopesReference, self).__init__(name)
        # if stackFrame is not variable_references.StackFrame:
        # raise gdb.GdbError(f"Expected type of frame to be StackFrame not GDB's Frame: {type(stackFrame)}")
        self.stack_frame = stackFrame
        self.variables = variablesGetter

    def contents(self, format=None, start=None, count=None):
        try:
            frame = self.stack_frame.frame()
            block = frame_top_block(frame)
            res = []
            for symbol in self.variables(block):
                gdbValue = frame.read_var(symbol, block)
                if can_var_ref(gdbValue):
                    ref = VariableValueReference(symbol.name, gdbValue)
                    res.append(ref.ui_data())
                else:
                    address = (
                        hex(int(gdbValue.address))
                        if gdbValue.address is not None
                        else None
                    )
                    res.append(
                        {
                            "name": symbol.name,
                            "value": "{}".format(gdbValue),
                            "type": f"{symbol.type}",
                            "evaluateName": symbol.name,
                            "variablesReference": 0,
                            "namedVariables": None,
                            "indexedVariables": None,
                            "memoryReference": address,
                        }
                    )
        except RuntimeError as re:
            return []
        return res

    def find_value(self, find_name):
        frame = self.stack_frame.frame()
        block = frame_top_block(frame)
        res = []
        for symbol in self.variables(block):
            if symbol.name == find_name:
                return frame.read_var(symbol, block)
        raise Exception(
            f"Could not find name {find_name} in scope container {self.name} with id {self.id}"
        )


def to_vs(name, value, type, evaluateName, ref, named, indexed, address):
    return {
        "name": name,
        "value": "{}".format(value),
        "type": "{}".format(type),
        "evaluateName": evaluateName,
        "variablesReference": ref,
        "namedVariables": named,
        "indexedVariables": indexed,
        "memoryReference": hex(int(address)) if address is not None else None,
    }


def args(block):
    if block is None:
        return
    for symbol in block:
        if symbol.is_argument and not (
            symbol.addr_class == gdb.SYMBOL_LOC_OPTIMIZED_OUT
        ):
            yield symbol


def locals(block):
    if block is None:
        return None
    for symbol in block:
        if symbol.is_variable and not (
            symbol.addr_class == gdb.SYMBOL_LOC_OPTIMIZED_OUT
        ):
            yield symbol


class RegistersReference(ScopesReference):
    def __init__(self, stackFrame):
        super(RegistersReference, self).__init__("Registers", stackFrame, lambda: None)

    def contents(self):
        return []
