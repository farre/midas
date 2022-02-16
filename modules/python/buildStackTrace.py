import gdb
import sys
import json
import gdb.types
import traceback
import logging
import time
from os import path
import functools

# Midas Terminology
# Execution Context: Thread (id) and Frame (level)

# Registers the current execution context
class ExecutionContextRegister:
    inferior = None
    def __init__(self):
        self.threadId = -1
        self.frameLevel = -1
        ExecutionContextRegister.inferior = gdb.selected_inferior()

    def set_thread(self, threadId):
        if self.threadId != threadId:
            misc_logger.info("changing thread {} -> {}".format(self.threadId, threadId))
            for t in ExecutionContextRegister.inferior.threads():
                if t.num == threadId:
                    t.switch()
                    self.threadId = t.num
                    return t
        else:
            return gdb.selected_thread()

    def set_frame(self, level):
        if self.frameLevel != level:
            misc_logger.info("changing frame {} -> {}".format(self.frameLevel, level))
            gdb.execute("frame {}".format(level))
            frame = gdb.selected_frame()
            self.frameLevel = frame.level()
            return frame
        else:
            return gdb.selected_frame()

    def set_context(self, threadId, frameLevel):
        t = self.set_thread(threadId=threadId)
        f = self.set_frame(level=frameLevel)
        return (t, f)

executionContext = ExecutionContextRegister()

def time_command_invocation(f):
    if not isDevelopmentBuild:
        return f
    """Measure performance (time) of command or function"""
    @functools.wraps(f)
    def timer_decorator(*args, **kwargs):
        invokeBegin = time.perf_counter_ns()
        f(*args, **kwargs)
        invokeEnd = time.perf_counter_ns()
        logger = logging.getLogger("time-logger")
        elapsed_time = int((invokeEnd - invokeBegin) / 1000) # we don't need nano-second measuring, but the accuracy of the timer is nice.
        logger.info("{:<30} executed in {:>10,} microseconds".format(f.__qualname__, elapsed_time))
        # note, we're not returning anything from Command invocations, as these are meant to be sent over the wire
    return timer_decorator


class GetTopFrame(gdb.Command):
    def __init__(self):
        super(GetTopFrame, self).__init__("gdbjs-get-top-frame", gdb.COMMAND_USER)
        self.name = "get-top-frame"

    @time_command_invocation
    def invoke(self, threadId, from_tty):
        t = executionContext.set_thread(threadId)
        frame = gdb.newest_frame()
        try:
            res = makeVSCodeFrameFromFn(frame, frame.function())
            output(self.name, res)
        except:
            output(self.name, None)
        


getTopFrameCommand = GetTopFrame()

def makeVSCodeFrameFromFn(frame, functionSymbol):
    sal = frame.find_sal()
    functionSymbolTab = functionSymbol.symtab
    filename = path.basename(functionSymbolTab.filename)
    fullname = functionSymbolTab.fullname()
    line_number = sal.line
    # DebugProtocol.Source
    src = { "name": filename, "path": fullname, "sourceReference": 0 }
    stackStart = frame.read_register("rbp")
    sf = {
        "id": 0,
        "source": src,
        "line": line_number,
        "column": 0,
        "name": "{}".format(functionSymbol.name),
        "address": frame.pc(),
        "stackAddressStart": int(stackStart),
    }
    return sf

def makeVSCodeFrameNoAssociatedFnName(name, frame):
    sal = frame.find_sal()
    line_number = sal.line
    # DebugProtocol.Source
    src = None
    try:
        src = { "name": path.basename(sal.symtab.filename), "path": sal.symtab.fullname(), "sourceReference": 0 }
    except:
        pass

    stackStart = frame.read_register("rbp")
    sf = {
        "id": 0,
        "source": src,
        "line": line_number,
        "column": 0,
        "name": name,
        "address": frame.pc(),
        "stackAddressStart": int(stackStart),
    }
    return sf


class StackFrameRequest(gdb.Command):
    def __init__(self):
        super(StackFrameRequest, self).__init__("gdbjs-request-stackframes", gdb.COMMAND_USER)
        self.name = "request-stackframes"

    @time_command_invocation
    def invoke(self, arguments, from_tty):
        [threadId, start, levels] = parseStringArgs(arguments)
        threadId = int(threadId)
        levels = int(levels)
        start = int(start)
        currentFrame = gdb.selected_frame()
        logging.info("selecting frame level {} and getting {} more frames for thread {}".format(start, levels, threadId))
        try:
            (t, f) = executionContext.set_context(threadId, start)
            result = []
            try:
                for x in range(levels + 1):
                    fn = f.function()
                    if fn is not None:
                        item = makeVSCodeFrameFromFn(f, f.function())
                        result.append(item)
                    else:
                        logging.info("Frame does not have a function associated with it: {}: {}".format(f.name(), f))
                        item = makeVSCodeFrameNoAssociatedFnName(f.name(), f)
                        result.append(item)
                    f = f.older()
            except Exception as e:
                logging.info("Stack trace build exception for frame {}: {}".format(start + x, e))
            output(self.name, result)
            currentFrame.select()
        except:
            # means selectThreadAndFrame failed; we have no frames from `start` and down
            output(self.name, [])

stackFrameRequestCommand = StackFrameRequest()

class ContentsOfStatic(gdb.Command):
    def __init__(self):
        super(ContentsOfStatic, self).__init__("gdbjs-get-contents-of-static", gdb.COMMAND_USER)
        self.name = "get-contents-of-static"

    @time_command_invocation
    def invoke(self, arguments, from_tty):
        [threadId, frameLevel, expression] = parseStringArgs(arguments)
        (thread, frame) = executionContext.set_context(threadId=threadId, frameLevel=frameLevel)
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
            misc_logger.error("Couldn't dereference value {}".format(expression))
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
        output(self.name, result)

contentsOfStaticCommand = ContentsOfStatic()

class ContentsOfBaseClass(gdb.Command):
    def __init__(self):
        super(ContentsOfBaseClass, self).__init__("gdbjs-get-contents-of-base-class", gdb.COMMAND_USER)
        self.name = "get-contents-of-base-class"

    @time_command_invocation
    def invoke(self, arguments, from_tty):
        [threadId, frameLevel, expression, base_classes] = parseStringArgs(arguments)
        (thread, frame) = executionContext.set_context(threadId=threadId, frameLevel=frameLevel)
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
            misc_logger.error("Couldn't dereference value {}".format(expression))
        
        members = []
        statics = []
        baseclasses = []
        fields = []
        staticResult = []
        memberResults = []
        baseClassResult = []

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
                memberResults.append(item)

            for static in statics:
                item = static_display(static, it.type[static].type)
                staticResult.append(item)

            for baseclass in baseclasses:
                item = base_class_display(baseclass, it.type[baseclass].type)
                baseClassResult.append(item)

            result = {"members": memberResults, "statics": staticResult, "base_classes": baseClassResult }
            output(self.name, result)
        except Exception as e:
            misc_logger.error("Couldn't get base class contents")
            output(self.name, None)

contentsOfBaseClassCommand = ContentsOfBaseClass()

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

    @time_command_invocation
    def invoke(self, arguments, from_tty):
        [threadId, frameLevel, expression] = parseStringArgs(arguments)
        (thread, frame) = executionContext.set_context(threadId=int(threadId), frameLevel=int(frameLevel))
        components = expression.split(".")
        it = getClosest(frame, components[0])
        for component in components[1:]:
            it = it[component]
        if it.type.code == gdb.TYPE_CODE_PTR:
            it = it.dereference()
        try:
            if memberIsReference(it.type):
                it = it.referenced_value()
        except Exception as e:
            misc_logger.error("Couldn't dereference value {}; {}".format(expression, e))
            raise e
        fields = []

        memberResults = []
        staticsResults = []
        baseClassResults = []
        result = { "members": [], "statics": [], "base_classes": [] }
        try:
            fields = it.type.fields()
            for field in fields:
                if hasattr(field, 'bitpos') and field.name is not None and not field.name.startswith("_vptr") and not field.is_base_class:
                    # members.append(field.name)
                    item = display(field.name, it[field.name], typeIsPrimitive(it[field.name].type))
                    memberResults.append(item)
                elif field.is_base_class:
                    # baseclasses.append(field.name)
                    item = base_class_display(field.name, it.type[field.name].type)
                    baseClassResults.append(item)
                elif not hasattr(field, "bitpos"):
                    # statics.append(field.name)
                    item = static_display(field.name, it.type[field.name].type)
                    staticsResults.append(item)

            result["members"] = memberResults
            result["base_classes"] = baseClassResults
            result["statics"] = staticsResults
            output(self.name, result)
        except Exception as e:
            extype, exvalue, extraceback = sys.exc_info()
            fieldsNames = []
            for field in fields:
                fieldsNames.append("{}".format(field.name))
            misc_logger.error("Couldn't retrieve contents of {}. Exception type: {} - Exception value: {}. Fields: {}".format(expression, extype, exvalue, fieldsNames))
            output(self.name, None)


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
    lastThreadId = -1
    lastFrameLevel = -1

    def same_context(threadId, frameLevel):
        return GetLocals.lastThreadId == threadId and GetLocals.lastFrameLevel == frameLevel

    def __init__(self):
        super(GetLocals, self).__init__("gdbjs-get-locals", gdb.COMMAND_USER)
        self.name = "get-locals"

    @time_command_invocation
    def invoke(self, arguments, from_tty):
        [threadId, frameLevel, scope] = parseStringArgs(arguments)
        (thread, frame) = executionContext.set_context(threadId=int(threadId), frameLevel=int(frameLevel))
        predicate = parseScopeParam(scope)
        try:
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
            output(self.name, result)
        except Exception as e:
            logExceptionBacktrace("Exception thrown in GetLocals.invoke", e)
            output(self.name, None)

getLocalsCommand = GetLocals()