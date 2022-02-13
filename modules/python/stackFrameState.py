import gdb
import sys
import json
import gdb.types
import traceback
import logging
import time

# from .utils import getMembersRecursively, memberIsReference, selectThreadAndFrame, parseStringArgs, getFunctionBlock, static_display, typeIsPrimitive, display, prepareOutput, logExceptionBacktrace

logging.basicConfig(filename='update.log', filemode="w", encoding='utf-8', level=logging.DEBUG)

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
        invokeBegin = time.perf_counter_ns()
        [threadId, frameLevel, expression, base_classes] = parseStringArgs(arguments)
        selectThreadAndFrame(threadId=threadId, frameLevel=frameLevel)
        components = expression.split(".")
        base_classes = parseStringArgs(base_classes)
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
        try:
            typeIterator = it.type
            for bc in map(lambda bc: bc.replace("_*_*_", " "), base_classes):
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
            invokeEnd = time.perf_counter_ns()
            sys.stdout.write(msg)
            sys.stdout.flush()
            logging.info("ContentsOfBaseClass for {} took {}ns".format(expression, invokeEnd-invokeBegin))
        except Exception as e:
            extype, exvalue, extraceback = sys.exc_info()
            fieldsNames = []
            for f in fields:
                fieldsNames.append("{}".format(f.name))
            res = json.dumps(None, ensure_ascii=False)
            msg = prepareOutput(self.name, res)
            sys.stdout.write(msg)
            sys.stdout.flush()

contentsOfBaseClassCommand = ContentsOfBaseClass()

recentSymbols = {}

# If we're parsing something that we know lives in the local frame, this is twice as fast than gdb.parse_and_eval(name). 
# As we say in Swedish; många bäckar små.
def getClosest(frame, name):
    block = frame.block()
    while (not block.is_static) and (not block.superblock.is_global):
        for symbol in block:
            if symbol.name == name:
                return symbol.value(frame)
        block = block.superblock
    return None


class ContentsOf(gdb.Command):
    def __init__(self):
        super(ContentsOf, self).__init__("gdbjs-get-contents-of", gdb.COMMAND_USER)
        self.name = "get-contents-of"

    def invoke(self, arguments, from_tty):
        invokeBegin = time.perf_counter_ns()
        [threadId, frameLevel, expression] = parseStringArgs(arguments)
        selectThreadAndFrame(threadId=threadId, frameLevel=frameLevel)
        components = expression.split(".")
        frame = gdb.selected_frame()
        it = getClosest(frame, components[0])
        for component in components[1:]:
            it = it[component]
        if it.type.code == gdb.TYPE_CODE_PTR:
            it = it.dereference()
        
        try:
            if memberIsReference(it.type):
                it = it.referenced_value()
        except Exception as e:
            logging.error("Couldn't dereference value {}; {}".format(expression, e))
            raise e

        members = []
        statics = []
        baseclasses = []
        fields = []
        result = { "members": [], "statics": [], "base_classes": [] }
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
            invokeEnd = time.perf_counter_ns()
            sys.stdout.write(msg)
            sys.stdout.flush()
            logging.info("ContentsOf for {} took {}ns".format(expression, invokeEnd-invokeBegin))
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
            block = frame.block()
            names = set()
            result = []
            name = None
            while (not block.is_static) and (not block.superblock.is_global):
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
                block = block.superblock

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