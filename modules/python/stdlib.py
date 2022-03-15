import gdb
import sys
import json
import gdb.types
import traceback
import logging
import logging.handlers
import time
from os import path
import functools

try: isDevelopmentBuild
except: isDevelopmentBuild = None
if isDevelopmentBuild is None:
    isDevelopmentBuild = False

# Midas sets this, when Midas DA has been initialized
if isDevelopmentBuild:
    time_handler = logging.handlers.WatchedFileHandler(
        "performance_time.log", mode="w")
    formatter = logging.Formatter(logging.BASIC_FORMAT)
    time_handler.setFormatter(formatter)
    time_logger = logging.getLogger("time-logger")
    time_logger.setLevel(logging.DEBUG)
    time_logger.addHandler(time_handler)

misc_handler = logging.handlers.WatchedFileHandler("debug.log", mode="w")
misc_formatter = logging.Formatter(logging.BASIC_FORMAT)
misc_handler.setFormatter(misc_formatter)

misc_logger = logging.getLogger("update-logger")
misc_logger.setLevel(logging.DEBUG)
misc_logger.addHandler(misc_handler)

err_handler = logging.handlers.WatchedFileHandler("error.log", mode="w")
err_formatter = logging.Formatter(logging.BASIC_FORMAT)
err_handler.setFormatter(err_formatter)

err_logger = logging.getLogger("error-logger")
err_logger.addHandler(err_handler)

def getFunctionBlock(frame) -> gdb.Block:
    block = frame.block()
    while not block.superblock.is_static and not block.superblock.is_global:
        block = block.superblock
    if block.is_static or block.is_global:
        return None
    return block


def logExceptionBacktrace(errmsg, exception):
    misc_logger.error("{} Exception info: {}".format(errmsg, exception))
    misc_logger.error(traceback.format_exc())


def selectThreadAndFrame(threadId, frameLevel):
    gdb.execute("thread {}".format(threadId))
    gdb.execute("frame {}".format(frameLevel))


def parseStringArgs(arg):
    return gdb.string_to_argv(arg)


def prepareOutput(cmdName, contents):
    return '<gdbjs:cmd:{0} {1} {0}:cmd:gdbjs>'.format(cmdName, contents)


def output(name, result):
    res = json.dumps(result, ensure_ascii=False)
    msg = prepareOutput(name, res)
    sys.stdout.write(msg)
    sys.stdout.flush()


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
        misc_logger.info("field {} is possibly a bitfield of size {}".format(
            field.name, field.bitsize))
    if hasattr(field, 'bitpos'):
        if field.is_base_class:
            for f in field.type.fields():
                getMembersRecursively(
                    f, memberList=memberList, statics=statics)
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


def variable_display(name, display, isPrimitive, static, synthetic):
    return {"name": name, "display": display, "isPrimitive": isPrimitive, "static": static, "synthetic": synthetic}


def display(name, value, isPrimitive, synthetic=False):
    if value.is_optimized_out:
        # we set all optimized values to primitives, because we don't want a scope for them in VSCode
        return variable_display(name=name, display="<optimized out>", isPrimitive=True, static=False, synthetic=True)
    try:
        if value.type.code == gdb.TYPE_CODE_PTR:
            if isPrimitive:
                return variable_display(name=name, display="<{}> {}".format(value.dereference().address, value), isPrimitive=isPrimitive, static=False, synthetic=synthetic)
            else:
                return variable_display(name=name, display="<{}> {}".format(value.dereference().address, value.type), isPrimitive=isPrimitive, static=False, synthetic=synthetic)
        else:
            if isPrimitive:
                return variable_display(name=name, display="{}".format(value), isPrimitive=isPrimitive, static=False, synthetic=synthetic)
            else:
                return variable_display(name=name, display="{}".format(value.type), isPrimitive=isPrimitive, static=False, synthetic=synthetic)
    except:
        return variable_display(name=name, display="<invalid address> {}".format(value.type), isPrimitive=isPrimitive, static=False, synthetic=True)

def pp_display_simple(name, value):
    return variable_display(name=name, display="{}".format(value), isPrimitive=True, static=False, synthetic=True)

def base_class_display(name, type):
    return {"name": name, "display": "{} (base)".format(type)}


def static_display(name, type):
    isPrimitive = True if type.tag is None else False
    typeName = type.tag if type.tag is not None else type
    return {"name": name, "display": "static {}".format(typeName), "isPrimitive": isPrimitive, "static": True, "synthetic": False}

# Response result from a variables request
def variables_response(members=[], statics=[], base_classes=[]):
    return { "members": members, "statics": statics, "base_classes": base_classes }

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
            for t in ExecutionContextRegister.inferior.threads():
                if t.num == threadId:
                    t.switch()
                    self.threadId = t.num
                    return t
        else:
            return gdb.selected_thread()

    def set_frame(self, level):
        if self.frameLevel != int(level):
            gdb.execute("frame {}".format(level))
            frame = gdb.selected_frame()
            self.frameLevel = frame.level()
            return frame
        else:
            return gdb.selected_frame()

    def set_context(self, threadId, frameLevel):
        t = self.set_thread(threadId=int(threadId))
        f = self.set_frame(level=int(frameLevel))
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
        try:
            t = executionContext.set_thread(int(threadId))
            gdb.execute("thread {}".format(threadId))
            frame = gdb.newest_frame()
            res = makeVSCodeFrameFromFn(frame, frame.function())
            output(self.name, res)
        except Exception as e:
            err_logger.error("Couldn't get top frame: {}. Frame info: Type: {} | Function: {} | Level: {}".format(e, frame.type(), frame.function(), frame.level()))
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
        try:
            currentFrame = gdb.selected_frame()
            (t, f) = executionContext.set_context(threadId, start)
            result = []
            try:
                for x in range(levels + 1):
                    fn = f.function()
                    if fn is not None:
                        item = makeVSCodeFrameFromFn(f, f.function())
                        result.append(item)
                    else:
                        item = makeVSCodeFrameNoAssociatedFnName(f.name(), f)
                        result.append(item)
                    f = f.older()
            except Exception as e:
                err_logger.error("Stack trace build exception for frame {}: {}".format(start + x, e))
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
            err_logger.error("Couldn't dereference value {}".format(expression))
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
        base_classes = parseStringArgs(base_classes)
        it = getAndTraverseExpressionPath(frame=frame, expression=expression)

        if it.type.code == gdb.TYPE_CODE_PTR:
            it = it.dereference()
        try:
            if memberIsReference(it.type):
                it = it.referenced_value()
        except:
            err_logger.error("Couldn't dereference value {}".format(expression))

        members = []
        statics = []
        baseclasses = []
        fields = []
        staticResult = []
        memberResults = []
        baseClassResult = []
        pp = gdb.default_visualizer(it)
        if pp is not None:
            if hasattr(pp, "children"):
                for child in pp.children():
                    (name, value) = child
                    memberResults.append(display(name, value, typeIsPrimitive(value.type)))
                output(self.name, variables_response(members=memberResults))
            else:
                memberResults.append(display("value", pp.to_string().value(), True, True))
                output(self.name, variables_response(members=memberResults))
            return

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
            output(self.name, variables_response(members=memberResults, statics=staticResult, base_classes=baseClassResult))
        except Exception as e:
            misc_logger.error("Couldn't get base class contents")
            output(self.name, None)

contentsOfBaseClassCommand = ContentsOfBaseClass()

# When parsing closely related blocks, this is faster than gdb.parse_and_eval on average.
def getClosest(frame, name):
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
def resolveGdbValue(value, components):
    it = value
    while len(components) > 0:
        if memberIsReference(it.type):
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

def getAndTraverseExpressionPath(frame, expression):
    components = expression.split(".")
    ancestor = getClosest(frame, components[0])
    it = resolveGdbValue(ancestor, components[1:])
    return it

class ContentsOf(gdb.Command):
    def __init__(self):
        super(ContentsOf, self).__init__("gdbjs-get-contents-of", gdb.COMMAND_USER)
        self.name = "get-contents-of"

    @time_command_invocation
    def invoke(self, arguments, from_tty):
        [threadId, frameLevel, expression] = parseStringArgs(arguments)
        (thread, frame) = executionContext.set_context(threadId=int(threadId), frameLevel=int(frameLevel))
        it = getAndTraverseExpressionPath(frame=frame, expression=expression)
        pp = gdb.default_visualizer(it)
        memberResults = []
        staticsResults = []
        baseClassResults = []
        if pp is not None:
            if hasattr(pp, "children"):
                try:
                    for child in pp.children():
                        misc_logger.error(("trying to get name and value of child"))
                        (name, value) = child
                        memberResults.append(display(name, value, typeIsPrimitive(value.type)))
                    output(self.name, variables_response(members=memberResults))
                except Exception as e:
                    err_logger.error("failed to get pretty printed value: {}. There's no value attribute?".format(e))
                    raise e
            else:
                # means the pretty printed result, doesn't have any children or shouldn't show any of them. Therefore it's safe
                # for us to assume that we can just say "to string"; since the pretty printer is telling us only 1 value is of important (otherwise .children() would exist)
                # This means that if someone implements a bad pretty printer, we can't help them (and neither can GDB).
                res = pp.to_string()
                if hasattr(res, "value"):
                    memberResults.append(pp_display_simple("value", res.value()))
                else:
                    memberResults.append(pp_display_simple("value", res))
                output(self.name, variables_response(members=memberResults))
            return

        if memberIsReference(it.type):
            it = it.referenced_value()
        try:
            fields = it.type.fields()
            for field in fields:
                if hasattr(field, 'bitpos') and field.name is not None and not field.name.startswith("_vptr") and not field.is_base_class:
                    item = display(field.name, it[field.name], typeIsPrimitive(it[field.name].type))
                    memberResults.append(item)
                elif field.is_base_class:
                    item = base_class_display(field.name, it.type[field.name].type)
                    baseClassResults.append(item)
                elif not hasattr(field, "bitpos"):
                    item = static_display(field.name, it.type[field.name].type)
                    staticsResults.append(item)

            output(self.name, variables_response(members=memberResults, statics=staticsResults, base_classes=baseClassResults))
        except Exception as e:
            extype, exvalue, extraceback = sys.exc_info()
            fieldsNames = []
            for field in fields:
                fieldsNames.append("{}".format(field.name))
            err_logger.error("Couldn't retrieve contents of {}. Exception type: {} - Exception value: {}. Fields: {}".format(expression, extype, exvalue, fieldsNames))
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
            raise
            output(self.name, None)

getLocalsCommand = GetLocals()

class SetWatchPoint(gdb.Command):
    def __init__(self):
        super(SetWatchPoint, self).__init__("gdbjs-watchpoint", gdb.COMMAND_USER)
        self.name = "watchpoint"

    def invoke(self, args, from_tty):
        [type, expression] = parseStringArgs(args)
        misc_logger.error("set wp for {} and {}".format(type, expression))
        if type == "access":
            gdb.execute(f"awatch -l {expression}")
        elif type == "read":
            gdb.execute(f"rwatch -l {expression}")
        elif type == "write":
            gdb.execute(f"watch -l {expression}")
        else:
            raise RuntimeError("Unknown watchpoint class")
        bp = gdb.breakpoints()[-1]
        output(self.name, { "number": bp.number })

setWatchPointCommand = SetWatchPoint()