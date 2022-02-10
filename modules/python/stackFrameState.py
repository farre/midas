import gdb
import sys
import json
import gdb.types
import traceback
import logging

logging.basicConfig(filename='update.log', filemode="w", encoding='utf-8', level=logging.DEBUG)

def getFunctionBlock(frame) -> gdb.Block:
    block = frame.block()
    while not block.superblock.is_static and not block.superblock.is_global:
        block = block.superblock
    if block.is_static or block.is_global:
        return None
    return block

def logExceptionBacktrace(errmsg, exception):
        logging.error("{} Exception info: {}".format(errmsg, exception))
        logging.error(traceback.format_exc())

def selectThreadAndFrame(threadId, frameLevel):
    try:
        gdb.execute("thread {}".format(threadId))
        gdb.execute("frame {}".format(frameLevel))
    except Exception as e:
        logExceptionBacktrace("Selecting thread and frame failed.", e)

def parseStringArgs(arg):
    return gdb.string_to_argv(arg)

def prepareOutput(cmdName, contents):
    return '<gdbjs:cmd:{0} {1} {0}:cmd:gdbjs>'.format(cmdName, contents)

def typeIsPrimitive(valueType):
    try:
        for f in valueType.fields():
            if hasattr(f, "enumval"):
                return True
            else:
                return False
    except TypeError:
        return True

def memberIsReference(type):
    code = type.code
    return code == gdb.TYPE_CODE_PTR or code == gdb.TYPE_CODE_REF or code == gdb.TYPE_CODE_RVALUE_REF

def getMembersRecursively(field, memberList):
    if hasattr(field, 'bitpos'):
        if field.is_base_class:
            for f in field.type.fields():
                getMembersRecursively(f, memberList)
        else:
            if field.name is not None and not field.name.startswith("_vptr"):
                memberList.append(field.name)

def display(name, value, isPrimitive):
    try:
        if value.type.code == gdb.TYPE_CODE_PTR:
            if isPrimitive:
                return { "name": name, "display": "<{}> {}".format(value.dereference().address, value), "isPrimitive": isPrimitive }
            else:
                return { "name": name, "display": "<{}> {}".format(value.dereference().address, value.type), "isPrimitive": isPrimitive }
        else:
            if isPrimitive:
                return { "name": name, "display": "{}".format(value), "isPrimitive": isPrimitive }
            else:
                return { "name": name, "display": "{}".format(value.type), "isPrimitive": isPrimitive }
    except:
        return { "name": name, "display": "<invalid address> {}".format(value.type), "isPrimitive": isPrimitive }


class ContentsOf(gdb.Command):
    def __init__(self):
        super(ContentsOf, self).__init__("gdbjs-get-contents-of", gdb.COMMAND_USER)
        self.name = "get-contents-of"

    def invoke(self, arguments, from_tty):
        [threadId, frameLevel, expression] = parseStringArgs(arguments)
        selectThreadAndFrame(threadId=threadId, frameLevel=frameLevel)
        components = expression.split(".")
        it = gdb.parse_and_eval(components[0])            
        components = components[1:]
        for component in components:
            it = it[component]
        if it.type.code == gdb.TYPE_CODE_PTR:
            it = it.dereference()
        
        try:
            if memberIsReference(it.type):
                it = it.referenced_value()
        except Exception as e:
            logging.error("Couldn't dereference value {}".format(expression))
            raise e

        members = []
        fields = it.type.fields()
        for f in fields:
            getMembersRecursively(f, members)
        result = []            
        for member in members:
            item = display(member, it[member], typeIsPrimitive(it[member].type))
            result.append(item)
        
        res = json.dumps(result, ensure_ascii=False)
        msg = prepareOutput(self.name, res)
        sys.stdout.write(msg)
        sys.stdout.flush()

updatesOfCommand = ContentsOf()

def parseScopeParam(scope):
    if scope == "locals":
        return lambda symbol: symbol.is_variable and not symbol.is_argument
    elif scope == "args":
        return lambda symbol: symbol.is_argument
    elif scope == "statics":
        raise NotImplementedError()
    elif scope == "registers":
        raise NotImplementedError()
    else:
        raise NotImplementedError() 

class GetLocals(gdb.Command):

    def __init__(self):
        super(GetLocals, self).__init__("gdbjs-get-locals", gdb.COMMAND_USER)
        self.name = "get-locals"

    def invoke(self, arguments, from_tty):
        [threadId, frameLevel, scope] = parseStringArgs(arguments)
        predicate = parseScopeParam(scope)
        selectThreadAndFrame(threadId=threadId, frameLevel=frameLevel)
        try:
            frame = gdb.selected_frame()
            block = getFunctionBlock(frame)
            names = set()
            result = []
            name = None
            for symbol in block:
                name = symbol.name
                if (name not in names) and predicate(symbol=symbol):
                    names.add(name)
                    try:
                        value = symbol.value(frame)
                        item = display(symbol.name, value, typeIsPrimitive(value.type))
                        result.append(item)
                    except Exception as e:
                        logExceptionBacktrace("Err was thrown in GetLocals (gdbjs-get-locals). Name of symbol that caused error: {0}\n".format(name), e)
                        names.remove(name)

            res = json.dumps(result, ensure_ascii=False)
            msg = prepareOutput(self.name, res)
            sys.stdout.write(msg)
            sys.stdout.flush()
        except Exception as e:
            logExceptionBacktrace("Exception thrown in GetLocals.invoke", e)
            res = json.dumps(None, ensure_ascii=False)
            msg = prepareOutput(self.name, res)
            sys.stdout.write(msg)
            sys.stdout.flush()

getLocalsCommand = GetLocals()