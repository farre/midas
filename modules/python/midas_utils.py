import gdb
import json
import sys
import logging

def type_is_primitive(valueType):
    try:
        for f in valueType.fields():
            if hasattr(f, "enumval"):
                return True
            else:
                return False
    except TypeError:
        return True

def get_members_recursively(field, memberList, statics):
    if field.bitsize > 0:
        misc_logger = logging.getLogger("update-logger")
        misc_logger.info("field {} is possibly a bitfield of size {}".format(
            field.name, field.bitsize))
    if hasattr(field, 'bitpos'):
        if field.is_base_class:
            for f in field.type.fields():
                get_members_recursively(
                    f, memberList=memberList, statics=statics)
        else:
            if field.name is not None and not field.name.startswith("_vptr"):
                memberList.append(field.name)
    else:
        statics.append(field.name)

def getFunctionBlock(frame) -> gdb.Block:
    block = frame.block()
    while not block.superblock.is_static and not block.superblock.is_global:
        block = block.superblock
    if block.is_static or block.is_global:
        return None
    return block


def parse_command_args(arg_string, *argv):
    """Parses the arguments passed in the argument string for commands.
    `*argv` contains a variable amount of type informations, which arguments in the argument string will be converted to.
    `argv` can not be a longer list than arg_string as this will throw an exception. If the type list is shorter than parsed arguments
    the remaining args will be returned as strings"""

    parsed_arguments = gdb.string_to_argv(arg_string)
    if len(argv) > len(parsed_arguments):
        raise gdb.GdbError("Parsed arguments less than arguments in type list")
    index = 0
    result = []
    for Type in argv:
        result.append(Type(parsed_arguments[index]))
        index += 1
    while index != len(parsed_arguments):
        result.append(parsed_arguments[index])
        index += 1
    return result

def prepare_command_response(cmdName, contents):
    return '<gdbjs:cmd:{0} {1} {0}:cmd:gdbjs>'.format(cmdName, contents)

def prepare_event_response(name, payload):
    return '<gdbjs:event:{0} {1} {0}:event:gdbjs>'.format(name, payload)

def send_response(name, result, prepareFnPtr):
    """Writes result of an operation to client stream."""
    import config
    res = json.dumps(result, ensure_ascii=False)
    if config.isDevelopmentBuild:
        log = logging.getLogger("update-logger")
        log.debug("{} Response: {}".format(name, res))
    packet = prepareFnPtr(name, res)
    sys.stdout.write(packet)
    sys.stdout.flush()

def value_is_reference(type):
    code = type.code
    return code == gdb.TYPE_CODE_PTR or code == gdb.TYPE_CODE_REF or code == gdb.TYPE_CODE_RVALUE_REF

# When parsing closely related blocks, this is faster than gdb.parse_and_eval on average.
def get_closest(frame, name):
    block = frame.block()
    while (not block.is_static) and (not block.superblock.is_global):
        for symbol in block:
            if symbol.name == name:
                return symbol.value(frame)
        block = block.superblock
    return None

# Function that is able to utilize pretty printers, so that we can resolve
# a value (which often does _not_ have the same expression path as regular structured types).
# For instance used for std::tuple, which has a difficult member "layout", with ambiguous names.
# Since ContentsOf command always takes a full "expression path", now it doesn't matter if the sub-paths of the expression
# contain non-member names; because if there's a pretty printer that rename the members (like in std::tuple, it's [1], [2], ... [N])
# these will be found and traversed properly, anyway
def resolve_gdb_value(value, components):
    it = value
    while len(components) > 0:
        if value_is_reference(it.type):
            it = it.referenced_value()
        pp = gdb.default_visualizer(it)
        component = components.pop(0)
        if pp is not None:
            found = False
            for child in pp.children():
                (name, val) = child
                if component == name:
                    it = val
                    found = True
                    break
            if not found:
                raise NotImplementedError()
        else:
            it = it[component]
    return it