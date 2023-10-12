import gdb
from os import path
variable_references = {}

def clear_variable_references(evt):
  variable_references.clear()

gdb.events.cont.connect(clear_variable_references)

# Base class Widget Reference - representing a container-item/widget in the VSCode UI
class VariablesReference:
  def __init__(self, name):
    global variable_references
    self.name = name
    self.id = len(variable_references)
    variable_references[self.id] = self

  def contents(self):
    raise Exception("Base class should not be used directly")

def frame_name(frame):
    fn = frame.function()
    if fn is not None:
      return fn.name
    else:
      return "frame"

class StackFrame(VariablesReference):
  def __init__(self, gdbFrame: gdb.Frame):
    super(StackFrame, self).__init__(frame_name(gdbFrame))
    self.gdbFrame = gdbFrame
    self._scopes = [ScopesReference("Args", gdbFrame, args), ScopesReference("Locals", gdbFrame, locals)]

  def contents(self):
      sal = self.gdbFrame.find_sal()
      filename = path.basename(sal.symtab.filename)
      fullname = sal.symtab.fullname()
      line_number = sal.line
      # DebugProtocol.Source
      src = {"name": filename, "path": fullname, "sourceReference": 0}
      sf = {
          "id": self.id,
          "source": src,
          "line": line_number,
          "column": 0,
          "name": "{}".format(self.name),
          "instructionPointerReference": hex(self.gdbFrame.pc())
      }
      return sf

  def scopes(self):
    res = []
    for scope in self._scopes:
      scope_res = {"name": scope.name, "variablesReference": scope.id }
      res.append(scope_res)
    return res

def is_primitive(type):
    return hasattr(type, "fields")


# Unfortunately, the DAP-gods in their infinite wisdom, named this concept "VariablesReference"
# something that refers to basically Widget/UI ID's, that can be a "Scope" like a container containing
# the variables that are locals or arguments, or anything really. So to actually signal, that this type
# refers to actual *variables* and their "children" we have to name it VariableValueReference to make
# any distinction between this and the base class
class VariableValueReference(VariablesReference):
  def __init__(self, name, gdbValue):
    super(VariableValueReference, self).__init__(name)
    self.value: gdb.Value = gdbValue

  def contents(self):
    return []

  def evaluateName(self):
    # return self.name
    raise Exception("Remember to return full evaluate path here")

# Midas defines some scopes: Args, Locals, Registers
# TODO(simon): Add Statics, Globals
class ScopesReference(VariablesReference):
  def __init__(self, name, stackFrame, variablesGetter):
    super(ScopesReference, self).__init__(name)
    # if stackFrame is not variable_references.StackFrame:
      # raise gdb.GdbError(f"Expected type of frame to be StackFrame not GDB's Frame: {type(stackFrame)}")
    self.frame = stackFrame
    self.variables = variablesGetter

  def contents(self):
    block = self.frame.block()
    res = []
    for symbol in self.variables(block):
      gdbValue = self.frame.read_var(symbol, block)
      if hasattr(gdbValue.type, "fields"):
        ref = VariableValueReference(symbol.name, gdbValue)
        res.append({
          "name": symbol.name,
          "value": symbol.type.name,
          "type": symbol.type.name,
          "evaluateName": symbol.name,
          "variablesReference": ref.id,
          "namedVariables": None,
          "indexedVariables": None,
          "memoryReference": hex(int(gdbValue.address))
        })
      else:
        res.append({
          "name": symbol.name,
          "value": f"{gdbValue}",
          "type": symbol.type.name,
          "evaluateName": symbol.name,
          "variablesReference": 0,
          "namedVariables": None,
          "indexedVariables": None,
          "memoryReference": hex(int(gdbValue.address))
        })
    print(f"Scope contents: {res}")
    return res

def vs_variable(name, value, evaluateName, ref, address):
  return {
    "name": name,
    "value": f"{value}",
    "evaluateName": evaluateName,
    "variablesReference": ref,
    "namedVariables": None,
    "indexedVariables": None,
    "memoryReference": hex(int(address))
  }

def args(block):
  for symbol in block:
    if symbol.is_argument and not symbol.addr_class == gdb.SYMBOL_LOC_OPTIMIZED_OUT:
      yield symbol

def locals(block):
  for symbol in block:
    if symbol.is_variable and not symbol.addr_class == gdb.SYMBOL_LOC_OPTIMIZED_OUT:
      yield symbol

class ArgsReference(ScopesReference):
  def __init__(self, stackFrame):
    super(ArgsReference, self).__init__("Args", stackFrame)

  def contents(self):
    block = self.frame.gdbFrame.block()
    res = []
    for symbol in args(block):
      gdbValue = self.frame.gdbFrame.read_var(symbol, block)
      res.append(vs_variable(symbol.name, gdbValue, symbol.name, 0, gdbValue.address))

    return res

class LocalsReference(ScopesReference):
  def __init__(self, stackFrame):
    super(LocalsReference, self).__init__("Locals", stackFrame)

  def contents(self):
    block = self.frame.gdbFrame.block()
    res = []
    for symbol in locals(block):
      gdbValue = self.frame.gdbFrame.read_var(symbol, block)
      if hasattr(gdbValue.type, "fields"):
        ref = VariableValueReference(symbol.name, gdbValue)
        res.append({
          "name": symbol.name,
          "value": symbol.type.name,
          "type": symbol.type.name,
          "evaluateName": symbol.name,
          "variablesReference": ref.id,
          "namedVariables": None,
          "indexedVariables": None,
          "memoryReference": hex(int(gdbValue.address))
        })
      else:
        res.append({
          "name": symbol.name,
          "value": f"{gdbValue}",
          "type": symbol.type.name,
          "evaluateName": symbol.name,
          "variablesReference": 0,
          "namedVariables": None,
          "indexedVariables": None,
          "memoryReference": hex(int(gdbValue.address))
        })
    return res

class RegistersReference(ScopesReference):
  def __init__(self, stackFrame):
    super(RegistersReference, self).__init__("Registers", stackFrame, lambda: None)

  def contents(self):
    return []