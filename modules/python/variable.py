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


def vs_display(name: str,
               value: str,
               evaluate_name: str,
               variable_reference: int,
               namedVariables=None,
               indexedVariables=None):
    return {
        "name": name,
        "value": value,
        "evaluateName": evaluate_name,
        "variablesReference": variable_reference,
        "namedVariables": namedVariables,
        "indexedVariables": indexedVariables
    }


def is_variable_referenceable(value_type):
    """Checks the type `value_type` if it's a structured type or a pointer type (which itself can be an array for instance)
       These types are represented in the VSCode UI as scopes that can be folded."""
    return not midas_utils.type_is_primitive(value_type) or midas_utils.value_is_reference(value_type)


class ReferencedValue:
    """
    Base class for the Values to be displayed in the VSCode UI
    """

    def __init__(self, name, value, evaluateName=None):
        self.name = name
        self.value = value
        self.variableRef = -1
        self.namedVariables = None
        self.indexedVariables = None
        self.watched = False
        self.evaluateName = evaluateName

    def get_type(self):
        return self.value.type

    def get_value(self):
        code = self.value.type.code
        # if we're a reference to primitive type, like int&: we want to return the actual int here
        # however, if we are a int* we don't - as it might be a range of values behind it.
        if (code == gdb.TYPE_CODE_REF or code == gdb.TYPE_CODE_RVALUE_REF) and self.variableRef == 0:
            return self.value.referenced_value()
        return self.value

    def is_array(value):
        fields = value.type.fields()
        if len(fields) == 1:
            try:
                (low_bound, hi_bound) = fields[0].type.range()
                return True
            except:
                pass
        return False

    def resolve_children(self, value, owningStackFrame):
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
                        config.variableReferences.add_mapping(vref, owningStackFrame)
                        owningStackFrame.variableReferences[vref] = v
                    result.append(v.to_vs())
                return result
            else:
                res = pp.to_string()
                if hasattr(res, "value"):
                    result.append({
                        "name": "value",
                        "value": "{}".format(res.value()),
                        "evaluateName": None,
                        "variablesReference": 0
                    })
                else:
                    result.append({
                        "name": "value",
                        "value": "{}".format(res),
                        "evaluateName": None,
                        "variablesReference": 0
                    })
                return result

        if ReferencedValue.is_array(value):
            (low_bound, hi_bound) = value.type.fields()[0].type.range()
            for x in range(hi_bound + 1):
                v = Variable.from_value("{}".format(x), value[x], "{}+{}".format(self.evaluateName, x))
                vref = v.get_variable_reference()
                if vref != 0:
                    if self.is_watched():
                        owningStackFrame.watchVariableReferences[vref] = v
                    config.variableReferences.add_mapping(vref, owningStackFrame)
                    owningStackFrame.variableReferences[vref] = v
                result.append(v.to_vs())
        else:
            fields = value.type.fields()
            for field in fields:
                if hasattr(field, 'bitpos') and field.name is not None and not field.name.startswith(
                        "_vptr") and not field.is_base_class:
                    v = Variable.from_value(field.name, value[field],
                                            "{}.{}".format(self.evaluateName, field.name))
                    vref = v.get_variable_reference()
                    if vref != 0:
                        if self.is_watched():
                            owningStackFrame.watchVariableReferences[vref] = v
                        config.variableReferences.add_mapping(vref, owningStackFrame)
                        owningStackFrame.variableReferences[vref] = v
                    result.append(v.to_vs())
                elif field.is_base_class:
                    # baseclass "field" has the same evaluate name path as the most derived type
                    # since it technically isn't a variable member
                    v = BaseClass.from_value(field.name, value, field.type, self.evaluateName)
                    vref = v.get_variable_reference()
                    if self.is_watched():
                        owningStackFrame.watchVariableReferences[vref] = v
                    config.variableReferences.add_mapping(vref, owningStackFrame)
                    owningStackFrame.variableReferences[vref] = v
                    result.append(v.to_vs())
                elif not hasattr(field, "bitpos"):
                    v = StaticVariable(field.name, value, field, "{}.{}".format(self.evaluateName, field.name))
                    vref = v.get_variable_reference()
                    if self.is_watched():
                        owningStackFrame.watchVariableReferences[vref] = v
                    config.variableReferences.add_mapping(vref, owningStackFrame)
                    owningStackFrame.variableReferences[vref] = v
                    result.append(v.to_vs())
        return result

    def set_watched(self):
        self.watched = True

    def is_watched(self):
        return self.watched


class Variable(ReferencedValue):

    def __init__(self, name, gdbValue, evaluateName=None):
        super(Variable, self).__init__(name, gdbValue, evaluateName)

    def from_value(name, value, evaluateName=None):
        return Variable(name, value, evaluateName)

    def from_symbol(symbol, frame):
        value = symbol.value(frame)
        return Variable(symbol.name, value, symbol.name)

    def get_member(self, member):
        try:
            v = self.value[member]
            return v
        except:
            return None

    def get_variable_reference(self):
        if self.variableRef == -1:
            code = self.value.type.code
            remove_ref_t = None
            if code == gdb.TYPE_CODE_REF or code == gdb.TYPE_CODE_RVALUE_REF:
                remove_ref_t = self.value.type.target()
            else:
                remove_ref_t = self.value.type
            if not midas_utils.type_is_primitive(remove_ref_t) or code == gdb.TYPE_CODE_PTR:
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
        except gdb.MemoryError as memexc:
            config.log_exception(config.error_logger(),
                                 "Midas failed to resolve variable value: {}".format(memexc), memexc)
            return [{
                "name": "value",
                "value": "Invalid address: {}".format(self.get_value()),
                "evaluateName": None,
                "variablesReference": 0
            }]
            # means we are a primitive type; we have no fields. Handle const char*, etc
        except TypeError as e:
            return [{
                "name": "value",
                "value": "{}".format(self.get_value()),
                "evaluateName": None,
                "variablesReference": 0
            }]
        except Exception as e:
            config.log_exception(config.error_logger(), "Midas failed to resolve variable value: {}".format(e), e)
            return [{
                "name": "value",
                "value": "Resolve failure: {}".format(self.get_value()),
                "evaluateName": None,
                "variablesReference": 0
            }]

    def to_vs(self):
        v = self.get_value()
        if v.is_optimized_out:
            return vs_display(name=self.name, value="<optimized out>", evaluate_name=None, variable_reference=0)

        variableReference = self.get_variable_reference()
        # type is primitive
        if variableReference == 0:
            return vs_display(name=self.name,
                              value="{}".format(v),
                              evaluate_name=self.evaluateName,
                              variable_reference=variableReference)
        else:
            # type is structured (or an array, etc)
            return vs_display(name=self.name,
                              value="{}".format(v.type),
                              evaluate_name=self.evaluateName,
                              variable_reference=variableReference)


class BaseClass(ReferencedValue):
    """
    Represents variable scopes in the UI that correspond to a base class
    """

    def __init__(self, name, rootValue, evaluateName=None):
        super(BaseClass, self).__init__(name, rootValue, evaluateName)
        self.variableRef = config.next_variable_reference()

    def from_value(name, value, type, evaluateName=None):
        v = value.cast(type)
        return BaseClass(name, v, evaluateName)

    def to_vs(self):
        return vs_display(name="(base)",
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
    def __init__(self, name, rootvalue, field, evaluateName=None):
        super(StaticVariable, self).__init__(name, rootvalue, evaluateName)
        self.variableRef = config.next_variable_reference()
        self.display = rootvalue.type[field.name].type.name
        self.field = field

    @config.timeInvocation
    def to_vs(self):
        return vs_display(name="(static) %s" % self.name,
                          value=self.display,
                          evaluate_name="{}.{}".format(self.evaluateName, self.name),
                          variable_reference=self.get_variable_reference())

    def get_variable_reference(self):
        return self.variableRef

    @config.timeInvocation
    def get_children(self, owningStackFrame):
        value = self.value[self.name]
        if midas_utils.type_is_primitive(value.type):
            return [
                vs_display(name="value",
                           value="{}".format(value),
                           evaluate_name=self.evaluateName,
                           variable_reference=0)
            ]
        else:
            return super().resolve_children(value, owningStackFrame=owningStackFrame)
