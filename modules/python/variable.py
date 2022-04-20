"""
Classes that bridge the management of variables and their display/UI elements in VSCode

This module represents different "unfoldable" scopes. So why isn't there just 1 class?
Well for instance, static members can incur an astronomical performance hit, if they are to be fetched
on every step, therefore these classes aim to facilitate good performance *first* before thinking about
modelling in the typical OO sense.
"""

import gdb
import midas_utils
import config


def vs_display(name: str, value: str, evaluate_name: str, variable_reference: int):
    return {"name": name, "value": value, "evaluateName": evaluate_name, "variablesReference": variable_reference}


class ReferencedValue:
    """
    Base class for the Values to be displayed in the VSCode UI
    """

    def __init__(self, name, value):
        self.name = name
        self.value = value
        self.variableRef = -1
        self.children = []
        self.resolved = False
        self.watched = False

    def get_type(self):
        return self.value.referenced_value().type

    def get_value(self):
        return self.value.referenced_value()

    def resolve_children(self, value, owningStackFrame):
        # if we're on the watch list, we will continue to exist
        # and thus be resolved already. just grab the contents
        # of our children and return that.
        if self.resolved:
            result = []
            for child in self.children:
                result.append(child.to_vs())
            return result

        result = []
        pp = gdb.default_visualizer(value)
        if pp is not None:
            if hasattr(pp, "children"):
                for name, value in pp.children():
                    v = Variable.from_value(name, value)
                    vref = v.get_variable_reference()
                    if vref != 0:
                        if self.is_watched():
                            owningStackFrame.watchVariableReferences[vref] = v
                        config.variableReferences.add_mapping(
                            vref, owningStackFrame)
                        owningStackFrame.variableReferences[vref] = v
                    result.append(v.to_vs())
                    self.children.append(v)
                return result
            else:
                res = pp.to_string()
                if hasattr(res, "value"):
                    result.append({"name": "value", "value": "{}".format(
                        res.value()), "evaluateName": None, "variablesReference": 0})
                else:
                    result.append({"name": "value", "value": "{}".format(
                        res), "evaluateName": None, "variablesReference": 0})
                return result
        fields = value.type.fields()
        for field in fields:
            if hasattr(field, 'bitpos') and field.name is not None and not field.name.startswith("_vptr") and not field.is_base_class:
                v = Variable.from_value(field.name, value[field])
                vref = v.get_variable_reference()
                if vref != 0:
                    if self.is_watched():
                        owningStackFrame.watchVariableReferences[vref] = v
                    config.variableReferences.add_mapping(
                        vref, owningStackFrame)
                    owningStackFrame.variableReferences[vref] = v
                result.append(v.to_vs())
                self.children.append(v)
            elif field.is_base_class:
                v = BaseClass.from_value(field.name, value, field.type)
                vref = v.get_variable_reference()
                if self.is_watched():
                    owningStackFrame.watchVariableReferences[vref] = v
                config.variableReferences.add_mapping(vref, owningStackFrame)
                owningStackFrame.variableReferences[vref] = v
                result.append(v.to_vs())
                self.children.append(v)
            elif not hasattr(field, "bitpos"):
                v = StaticVariable(field.name, value, field)
                vref = v.get_variable_reference()
                if self.is_watched():
                    owningStackFrame.watchVariableReferences[vref] = v
                config.variableReferences.add_mapping(vref, owningStackFrame)
                owningStackFrame.variableReferences[vref] = v
                result.append(v.to_vs())
                self.children.append(v)
        self.resolved = True
        return result

    def set_watched(self):
        self.watched = True

    def is_watched(self):
        return self.watched


class Variable(ReferencedValue):
    def __init__(self, name, gdbValue):
        super(Variable, self).__init__(name, gdbValue)

    def from_value(name, value):
        # Special case. GDB destroys itself if it tries to take a reference to an RVALUE reference
        # when trying to dereference that RVALUE reference
        if value.type.code == gdb.TYPE_CODE_RVALUE_REF:
            return Variable(name, value)
        else:
            return Variable(name, value.reference_value())

    def from_symbol(symbol, frame):
        value = symbol.value(frame)
        # Special case. GDB destroys itself if it tries to take a reference to an RVALUE reference
        # when trying to dereference that RVALUE reference
        if value.type.code == gdb.TYPE_CODE_RVALUE_REF:
            return Variable(symbol.name, value)
        else:
            return Variable(symbol.name, value.reference_value())

    def get_variable_reference(self):
        if self.variableRef == -1:
            v = self.value
            if midas_utils.value_is_reference(v.type):
                v = v.referenced_value()
            if not midas_utils.type_is_primitive(v.type):
                vr = config.next_variable_reference()
                self.variableRef = vr
            else:
                self.variableRef = 0
        return self.variableRef

    def get_children(self, owningStackFrame):
        it = self.get_value()
        if midas_utils.value_is_reference(it.type):
            it = it.referenced_value()
        try:
            return super().resolve_children(it, owningStackFrame)
        except gdb.MemoryError:
            return [{"name": "value", "value": "Invalid address: {}".format(self.get_value()), "evaluateName": None, "variablesReference": 0}]

    def to_vs(self):
        v = self.get_value()
        if v.is_optimized_out:
            return vs_display(
                name=self.name,
                value="<optimized out>",
                evaluate_name=None,
                variable_reference=0)

        variableReference = self.get_variable_reference()
        if variableReference == 0:
            return vs_display(
                name=self.name,
                value="{}".format(v),
                evaluate_name=None,
                variable_reference=variableReference)
        else:
            return vs_display(
                name=self.name,
                value="{}".format(v.type),
                evaluate_name=None,
                variable_reference=variableReference)


class BaseClass(ReferencedValue):
    """
    Represents variable scopes in the UI that correspond to a base class
    """

    def __init__(self, name, rootValue):
        super(BaseClass, self).__init__(name, rootValue)
        self.variableRef = config.next_variable_reference()

    def from_value(name, value, type):
        v = value.cast(type).reference_value()
        return BaseClass(name, v)

    def to_vs(self):
        return vs_display(
            name="(base)",
            value="%s" % self.name,
            evaluate_name=None,
            variable_reference=self.get_variable_reference())

    def get_variable_reference(self):
        return self.variableRef

    def get_children(self, owningStackFrame):
        return super().resolve_children(self.get_value(), owningStackFrame=owningStackFrame)


class StaticVariable(ReferencedValue):
    """
    Type that signals that a member variable is a static member. These variables are not laid out inside
    the struct types which they are defined in. For non trivial applications, fetching these often
    incurs an astronomical cost. Thus, we handle these special cases by deferring fetching to an explicit action
    by the user (i.e. clicking the fold out icon in the Variables list).
    """
    @config.timeInvocation
    def __init__(self, name, rootvalue, field):
        super(StaticVariable, self).__init__(name, rootvalue)
        self.variableRef = config.next_variable_reference()
        self.display = rootvalue.type[field.name].type.name
        self.field = field

    @config.timeInvocation
    def to_vs(self):
        return vs_display(
            name="(static) %s" % self.name,
            value=self.display,
            evaluate_name=None,
            variable_reference=self.get_variable_reference())

    def get_variable_reference(self):
        return self.variableRef

    @config.timeInvocation
    def get_children(self, owningStackFrame):
        value = self.value[self.name]
        if midas_utils.type_is_primitive(value.type):
            return [vs_display(name="value", value="{}".format(value), evaluate_name=None, variable_reference=0)]
        else:
            return super().resolve_children(value, owningStackFrame=owningStackFrame)
