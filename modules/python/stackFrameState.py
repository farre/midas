from xml.dom.expatbuilder import parseString
import gdb
import sys
import json
import gdb.types
import traceback
import logging
import time

# from .utils import getMembersRecursively, memberIsReference, selectThreadAndFrame, parseStringArgs, getFunctionBlock, static_display, typeIsPrimitive, display, prepareOutput, logExceptionBacktrace

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

def getMembersRecursively(field, memberList, statics):
    if field.bitsize > 0:
        logging.info("field {} is possibly a bitfield of size {}".format(field.name, field.bitsize))
    if hasattr(field, 'bitpos'):
        if field.is_base_class:
            for f in field.type.fields():
                getMembersRecursively(f, memberList=memberList, statics=statics)
        else:
            if field.name is not None and not field.name.startswith("_vptr"):
                memberList.append(field.name)
    else:
        statics.append(field.name)

def getMembers(field, memberList, statics, baseclasses):
    if hasattr(field, 'bitpos') and field.name is not None and not field.name.startswith("_vptr") and not field.is_base_class:
        memberList.append(field.name)
    elif field.is_base_class:
        baseclasses.append(field.name)
    elif not hasattr(field, "bitpos"):
        statics.append(field.name)


def getValue(value):
    print("Trying to get value of {0}".format(value))
    if memberIsReference(value.type):
        try:
            v = value.referenced_value()
            return v
        except gdb.MemoryError:
            return value
    else:
        return value

def getElement(key, map):
    try:
        r = map[key]
        return r
    except KeyError:
        return None

def getMemberValue(path):
    pathComponents = path.split(".")
    parent = pathComponents[0]
    try:
        it = gdb.parse_and_eval(parent)
        pathComponents = pathComponents[1:]
        if len(pathComponents):
            return it
        for path in pathComponents:
            curr = getElement(path, it)
            if curr is None:
                return None
            it = curr
        
        return it
    except gdb.error:
        return None

def display(name, value, isPrimitive):
    try:
        if value.type.code == gdb.TYPE_CODE_PTR:
            if isPrimitive:
                return { "name": name, "display": "<{}> {}".format(value.dereference().address, value), "isPrimitive": isPrimitive, "static": False }
            else:
                return { "name": name, "display": "<{}> {}".format(value.dereference().address, value.type), "isPrimitive": isPrimitive, "static": False }
        else:
            if isPrimitive:
                return { "name": name, "display": "{}".format(value), "isPrimitive": isPrimitive, "static": False }
            else:
                return { "name": name, "display": "{}".format(value.type), "isPrimitive": isPrimitive, "static": False }
    except:
        return { "name": name, "display": "<invalid address> {}".format(value.type), "isPrimitive": isPrimitive, "static": False }

def base_class_display(name, type):
    return { "name": name, "display": "{} (base)".format(type) }

def static_display(name, type):
    isPrimitive = True if type.tag is None else False
    typeName = type.tag if type.tag is not None else type
    return { "name": name, "display": "static {}".format(typeName), "isPrimitive": isPrimitive, "static": True }

class ContentsOfStatic(gdb.Command):
    def __init__(self):
        super(ContentsOfStatic, self).__init__("gdbjs-get-contents-of-static", gdb.COMMAND_USER)
        self.name = "get-contents-of-static"
    
    def invoke(self, arguments, from_tty):
        [threadId, frameLevel, expression] = parseStringArgs(arguments)
        selectThreadAndFrame(threadId=threadId, frameLevel=frameLevel)
        components = expression.split(".")
        it = gdb.parse_and_eval(components[0])

        for component in components[1:]:
            it = it[component]
        if it.type.code == gdb.TYPE_CODE_PTR:
            it = it.dereference()
        try:
            if memberIsReference(it.type):
                it = it.referenced_value()
        except Exception as e:
            logging.error("Couldn't dereference value {}".format(expression))
            raise e
        result = []
        try:
            members = []
            statics = []
            fields = it.type.fields()
            for f in fields:
                getMembersRecursively(f, memberList=members, statics=statics)
            result = []

            for member in members:
                item = display(member, it[member], typeIsPrimitive(it[member].type))
                result.append(item)

            for static in statics:
                item = static_display(static, it.type[static].type)
                result.append(item)
        except:
            result.append({ "name": "static value", "display": "{}".format(it), "isPrimitive": True, "static": True })
        res = json.dumps(result, ensure_ascii=False)
        msg = prepareOutput(self.name, res)
        sys.stdout.write(msg)
        sys.stdout.flush()

contentsOfStaticCommand = ContentsOfStatic()

class ContentsOfBaseClass(gdb.Command):
    def __init__(self):
        super(ContentsOfBaseClass, self).__init__("gdbjs-get-contents-of-base-class", gdb.COMMAND_USER)
        self.name = "get-contents-of-base-class"
    
    def invoke(self, arguments, from_tty):
        logging.info("Arguments: {}".format(arguments))
        [threadId, frameLevel, expression, base_classes] = parseStringArgs(arguments)
        selectThreadAndFrame(threadId=threadId, frameLevel=frameLevel)
        components = expression.split(".")
        base_classes = parseStringArgs(base_classes)
        logging.info("parsing expression '{}' and it's baseclasses: {}".format(expression, base_classes))
        it = gdb.parse_and_eval(components[0])
        for c in components[1:]:
            it = it[c]

        if it.type.code == gdb.TYPE_CODE_PTR:
            it = it.dereference()
        try:
            if memberIsReference(it.type):
                it = it.referenced_value()
        except:
            logging.error("Couldn't dereference value {}".format(expression))
        
        members = []
        statics = []
        baseclasses = []
        fields = []
        result = {"members": [], "statics": [], "base_classes": [ ]}
        currentBc = None
        currentTypeName = None
        try:
            typeIterator = it.type
            for bc in map(lambda bc: bc.replace("_*_*_", " "), base_classes):
                # --- debug purposes ---
                currentBc = bc
                currentTypeName = typeIterator.name
                # /// debug purposes ///
                typeIterator = typeIterator[bc].type
                it = it.cast(typeIterator)

            fields = typeIterator.fields()
            for f in fields:
                getMembers(f, memberList=members, statics=statics, baseclasses=baseclasses)
            
            for member in members:
                item = display(member, it[member], typeIsPrimitive(it[member].type))
                result["members"].append(item)
            
            for static in statics:
                item = static_display(static, it.type[static].type)
                result["statics"].append(item)

            for baseclass in baseclasses:
                item = base_class_display(baseclass, it.type[baseclass].type)
                result["base_classes"].append(item)
            
            res = json.dumps(result, ensure_ascii=False)
            msg = prepareOutput(self.name, res)
            sys.stdout.write(msg)
            sys.stdout.flush()
        except Exception as e:
            extype, exvalue, extraceback = sys.exc_info()
            fieldsNames = []
            for f in fields:
                fieldsNames.append("{}".format(f.name))
            logging.error("Current type {} -> couldn't go to next type {}. Exception: {} | {}".format(currentTypeName, currentBc, extype, exvalue))
            res = json.dumps(None, ensure_ascii=False)
            msg = prepareOutput(self.name, res)
            sys.stdout.write(msg)
            sys.stdout.flush()

contentsOfBaseClassCommand = ContentsOfBaseClass()

class ContentsOf(gdb.Command):
    def __init__(self):
        super(ContentsOf, self).__init__("gdbjs-get-contents-of", gdb.COMMAND_USER)
        self.name = "get-contents-of"

    def invoke(self, arguments, from_tty):
        [threadId, frameLevel, expression] = parseStringArgs(arguments)
        selectThreadAndFrame(threadId=threadId, frameLevel=frameLevel)
        components = expression.split(".")
        it = gdb.parse_and_eval(components[0])
        for component in components[1:]:
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
        statics = []
        baseclasses = []
        fields = []
        result = {"members": [], "statics": [], "base_classes": [ ]}
        try:
            fields = it.type.fields()
            for f in fields:
                getMembers(f, memberList=members, statics=statics, baseclasses=baseclasses)
            
            for member in members:
                item = display(member, it[member], typeIsPrimitive(it[member].type))
                result["members"].append(item)
            
            for static in statics:
                item = static_display(static, it.type[static].type)
                result["statics"].append(item)

            for baseclass in baseclasses:
                item = base_class_display(baseclass, it.type[baseclass].type)
                result["base_classes"].append(item)
            
            res = json.dumps(result, ensure_ascii=False)
            msg = prepareOutput(self.name, res)
            sys.stdout.write(msg)
            sys.stdout.flush()
        except Exception as e:
            extype, exvalue, extraceback = sys.exc_info()
            fieldsNames = []
            for f in fields:
                fieldsNames.append("{}".format(f.name))
            logging.error("Couldn't retrieve contents of {}. Exception type: {} - Exception value: {}. Fields: {}\nRecursively found members: {} \t statics: {}\n".format(expression, extype, exvalue, fieldsNames, members, statics))
            res = json.dumps(None, ensure_ascii=False)
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