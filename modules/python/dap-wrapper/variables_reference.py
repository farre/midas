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


def can_var_ref_type(type):
    return type.code == gdb.TYPE_CODE_STRUCT or type.code == gdb.TYPE_CODE_PTR


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
        return "unknown frame"


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
        yield f


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


# we have to wrap this. Because this gets called in a loop where `value` is created on each iteration
# For some reason, Python, in it's infinite wisdom, make that value be overwritten to be the same in every lambda
def create_deferred_scopes_ref(name, value):
    return VariableValueReference(
        name=name, type=value.type, value_getter=lambda: value, addr=value.address
    )


# we have to wrap this. Because this gets called in a loop where `value[field]` is created on each iteration
# For some reason, Python, in it's infinite wisdom, make that value[field] be overwritten to be the same in every lambda
def create_deferred_var_ref(field, parent_value, address):
    return VariableValueReference(
        name=field.name,
        type=field.type,
        value_getter=lambda: parent_value[field],
        addr=address,
    )


def create_eager_var_ref(name, value):
    return VariableValueReference(
        name=name, type=value.type, value_getter=lambda: value, addr=value.address
    )


# Create UI data for a value that is not VariableReference'able (i.e. VariableReference = 0)
def value_ui_data(name, value):
    return {
        "name": name,
        "value": "{}".format(value),
        "type": "{}".format(value.type),
        "evaluateName": None,
        "variablesReference": 0,
        "namedVariables": None,
        "indexedVariables": None,
        "memoryReference": hex(int(value.address)) if value.address is not None else None,
    }


# Unfortunately, the DAP-gods in their infinite wisdom, named this concept "VariablesReference"
# something that refers to basically Widget/UI ID's, that can be a "Scope" like a container containing
# the variables that are locals or arguments, or anything really. So to actually signal, that this type
# refers to actual *variables* and their "children" we have to name it VariableValueReference to make
# any distinction between this and the base class
class VariableValueReference(VariablesReference):
    def __init__(self, name, type, value_getter, addr):
        super(VariableValueReference, self).__init__(name)
        self.type = type
        self.value_getter = value_getter
        self.value_cache = None
        self.addr = addr

    def is_pointer(self):
        return self.type.code == gdb.TYPE_CODE_PTR

    def get_value(self):
        if self.value_cache is None:
            self.value_cache = self.value_getter()
            if self.value_cache.type.code == gdb.TYPE_CODE_PTR:
                self.value_cache = self.value_cache.referenced_value()
        return self.value_cache

    def ui_data(self):
        addr = hex(int(self.addr)) if self.addr is not None else None
        return {
            "name": self.name,
            "value": f"{self.type}",
            "type": f"{self.type.name}",
            "evaluateName": None,
            "variablesReference": self.id,
            "namedVariables": None,
            "indexedVariables": None,
            "memoryReference": addr,
        }

    def pp_contents(self, pp, format, start, count):
        res = []
        if hasattr(pp, "children"):
            for (name, val) in pp.children():
                if can_var_ref(val):
                    ref = create_eager_var_ref(name=name, value=val)
                    res.append(ref.ui_data())
                else:
                    res.append(value_ui_data(name, val))
        else:
            v = pp.to_string()
            # If to_string returns a lazy string, we want to get the actual string.
            if hasattr(v, "value"):
                v = v.value()

            item = value_ui_data("to-string", v)
            item["type"] = "{}".format(self.type)
            res.append(item)
        return res

    def contents(self, format=None, start=None, count=None):
        try:
            value = self.get_value()
            pp = gdb.default_visualizer(value)
            if pp is not None:
                return self.pp_contents(pp, format, start, count)
            else:
                res = []
                for field in members(value):
                    if can_var_ref_type(field.type):
                        # since we defer creating values for the members, we calculate actual address in memory by
                        # offset of the member inside the type.
                        if hasattr(field, "bitpos"):
                            addr = int(value.address) + (int(field.bitpos) / 8)
                        else:
                            # Is a static member
                            addr = None
                        ref = create_deferred_var_ref(field, value, addr)
                        res.append(ref.ui_data())
                    else:
                        res.append(value_ui_data(field.name, value[field]))
                return res
        except gdb.error as mem_exception:
            return [{"name": "error", "value": f"{mem_exception}", "variablesReference": 0}]

    def find_value(self, find_name):
        value = self.get_value()
        pp = gdb.default_visualizer(value)
        if pp is not None:
            for (name, val) in pp.children():
                if name == find_name:
                    return val
        else:
            for field in members(value):
                if field.name == find_name:
                    return value[field]
        raise Exception(
            f"Could not find name {find_name} in variables reference container {self.name} with id {self.id}"
        )

def opt_out(symbol):
    return {
        "name": symbol.name,
        "value": "<optimized out>",
        "type": f"{symbol.type}",
        "evaluateName": symbol.name,
        "variablesReference": 0,
        "namedVariables": None,
        "indexedVariables": None,
        "memoryReference": None,
    }

# Midas defines some scopes: Args, Locals, Registers
# TODO(simon): Add Statics, Globals
class ScopesReference(VariablesReference):
    def __init__(self, name, stackFrame, variablesGetter):
        super(ScopesReference, self).__init__(name)
        self.stack_frame = stackFrame
        self.variables = variablesGetter

    def contents(self, format=None, start=None, count=None):
        frame = self.stack_frame.frame()
        block = frame_top_block(frame)
        res = []
        for symbol in self.variables(block):
            gdbValue = frame.read_var(symbol, block)
            if gdbValue.is_optimized_out:
                res.append(opt_out(symbol))
                continue

            if can_var_ref(gdbValue):
                ref = create_deferred_scopes_ref(name=symbol.name, value=gdbValue)
                res.append(ref.ui_data())
            else:
                address = (
                    hex(int(gdbValue.address)) if gdbValue.address is not None else None
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
