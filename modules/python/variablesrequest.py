import gdb
from enum import Enum, unique

from midas_utils import typeIsPrimitive
import config

@unique
class DisplayItemType(Enum):
    Variable = 1
    BaseClass = 2
    Static = 3
    Synthetic = 4

class BaseClass:
    def __init__(self, name, rootValue):
        self.name = name
        # the actual gdb value, for whom this is a base type for
        self.value = rootValue
        self.variableRef = config.nextVariableReference()

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
        self.variableRef = config.nextVariableReference()

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