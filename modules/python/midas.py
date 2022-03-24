import gdb
import gdb.types
import os
import sys

import logging
import logging.handlers
from os import path

def resolveExtensionFile(fileName):
    extensionPath = os.path.dirname(os.path.realpath(__file__))
    return "{}/../../{}".format(extensionPath, fileName)

misc_handler = logging.handlers.WatchedFileHandler(resolveExtensionFile("debug.log"), mode="w")
misc_formatter = logging.Formatter(logging.BASIC_FORMAT)
misc_handler.setFormatter(misc_formatter)

misc_logger = logging.getLogger("update-logger")
misc_logger.setLevel(logging.DEBUG)
misc_logger.addHandler(misc_handler)

err_handler = logging.handlers.WatchedFileHandler(resolveExtensionFile("error.log"), mode="w")
err_formatter = logging.Formatter(logging.BASIC_FORMAT)
err_handler.setFormatter(err_formatter)

err_logger = logging.getLogger("error-logger")
err_logger.addHandler(err_handler)

time_handler = logging.handlers.WatchedFileHandler(resolveExtensionFile("performance_time.log"), mode="w")
time_formatter = logging.Formatter(logging.BASIC_FORMAT)
time_handler.setFormatter(time_formatter)
time_logger = logging.getLogger("time-logger")
time_logger.setLevel(logging.DEBUG)
time_logger.addHandler(time_handler)

# Setup code that needs to be excuted, so that GDB can know where to look for our python modules
# We grab the path to the folder containing this file and append it to sys.
extensionPath = os.path.dirname(os.path.realpath(__file__))
if sys.path.count(extensionPath) == 0:
    err_logger.error("Module path not set. Setting it")
    sys.path.append(extensionPath)
import midas_utils
import config

import execution_context
config.currentExecutionContext = execution_context.CurrentExecutionContext()

executionContexts = {}

import stacktrace_request
stackFrameRequestCommand = stacktrace_request.StackTraceRequest(executionContexts)

import variables_request
variableRequestCommand = variables_request.VariableRequest(executionContexts)

import scopes_request
scopesRequestCommand = scopes_request.ScopesRequest(executionContexts)

# Midas sets this, when Midas DA has been initialized
if config.isDevelopmentBuild:
    misc_logger.debug("Development mode is set. Logging enabled.")

def selectThreadAndFrame(threadId, frameLevel):
    gdb.execute("thread {}".format(threadId))
    gdb.execute("frame {}".format(frameLevel))

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



def createVSCodeStackFrame(frame):
    try:
        res = makeVSCodeFrameFromFn(frame, frame.function())
        return res
    except:
        res = makeVSFrameFromNoSymbtab(frame.name(), frame)
        return res

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

def makeVSFrameFromNoSymbtab(name, frame):
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

class GetTopFrame(gdb.Command):
    def __init__(self):
        super(GetTopFrame, self).__init__("gdbjs-get-top-frame", gdb.COMMAND_USER)
        self.name = "get-top-frame"

    @config.timeInvocation
    def invoke(self, threadId, from_tty):
        try:
            t = config.currentExecutionContext.set_thread(int(threadId))
            frame = gdb.newest_frame()
            res = createVSCodeStackFrame(frame)
            midas_utils.sendResponse(self.name, res, midas_utils.prepareCommandResponse)
        except Exception as e:
            config.log_exception(err_logger, "Couldn't get top frame: {}. Frame info: Type: {} | Function: {} | Level: {}".format(e, frame.type(), frame.function(), frame.level()), e)
            midas_utils.sendResponse(self.name, None, midas_utils.prepareCommandResponse)


getTopFrameCommand = GetTopFrame()

class StackFrameRequest(gdb.Command):
    def __init__(self):
        super(StackFrameRequest, self).__init__("gdbjs-request-stackframes", gdb.COMMAND_USER)
        self.name = "request-stackframes"

    @config.timeInvocation
    def invoke(self, arguments, from_tty):
        [threadId, start, levels] = midas_utils.parseCommandArguments(arguments)
        threadId = int(threadId)
        levels = int(levels)
        start = int(start)
        try:
            currentFrame = gdb.selected_frame()
            (t, f) = config.currentExecutionContext.set_context(threadId, start)
            result = []
            for x in range(levels + 1):
                if f is not None:
                    item = createVSCodeStackFrame(f)
                    result.append(item)
                    f = f.older()
                else:
                    break
            midas_utils.sendResponse(self.name, result, midas_utils.prepareCommandResponse)
            currentFrame.select()
        except:
            # means selectThreadAndFrame failed; we have no frames from `start` and down
            midas_utils.sendResponse(self.name, [], midas_utils.prepareCommandResponse)

stackFrameRequestCommand = StackFrameRequest()


class ContentsOfStatic(gdb.Command):
    def __init__(self):
        super(ContentsOfStatic, self).__init__("gdbjs-get-contents-of-static", gdb.COMMAND_USER)
        self.name = "get-contents-of-static"

    @config.timeInvocation
    def invoke(self, arguments, from_tty):
        [threadId, frameLevel, expression] = midas_utils.parseCommandArguments(arguments)
        (thread, frame) = config.currentExecutionContext.set_context(threadId=threadId, frameLevel=frameLevel)
        components = expression.split(".")
        it = gdb.parse_and_eval(components[0])

        for component in components[1:]:
            it = it[component]
        if it.type.code == gdb.TYPE_CODE_PTR:
            it = it.dereference()
        try:
            if midas_utils.memberIsReference(it.type):
                it = it.referenced_value()
        except Exception as e:
            config.log_exception(err_logger, "Couldn't dereference value {}".format(expression), e)
            raise e
        result = []
        try:
            members = []
            statics = []
            fields = it.type.fields()
            for f in fields:
                midas_utils.getMembersRecursively(f, memberList=members, statics=statics)
            result = []

            for member in members:
                item = display(member, it[member], midas_utils.typeIsPrimitive(it[member].type))
                result.append(item)

            for static in statics:
                item = static_display(static, it.type[static].type)
                result.append(item)
        except:
            result.append({ "name": "static value", "display": "{}".format(it), "isPrimitive": True, "static": True })
        midas_utils.sendResponse(self.name, result, midas_utils.prepareCommandResponse)

contentsOfStaticCommand = ContentsOfStatic()


class ContentsOfBaseClass(gdb.Command):
    def __init__(self):
        super(ContentsOfBaseClass, self).__init__("gdbjs-get-contents-of-base-class", gdb.COMMAND_USER)
        self.name = "get-contents-of-base-class"

    @config.timeInvocation
    def invoke(self, arguments, from_tty):
        [threadId, frameLevel, expression, base_classes] = midas_utils.parseCommandArguments(arguments)
        (thread, frame) = config.currentExecutionContext.set_context(threadId=threadId, frameLevel=frameLevel)
        base_classes = midas_utils.parseCommandArguments(base_classes)
        it = getAndTraverseExpressionPath(frame=frame, expression=expression)

        if it.type.code == gdb.TYPE_CODE_PTR:
            it = it.dereference()
        try:
            if midas_utils.memberIsReference(it.type):
                it = it.referenced_value()
        except Exception as e:
            config.log_exception(err_logger, "Couldn't dereference value {}".format(expression), e)

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
                    memberResults.append(display(name, value, midas_utils.typeIsPrimitive(value.type)))
                midas_utils.sendResponse(self.name, variables_response(members=memberResults), midas_utils.prepareCommandResponse)
            else:
                memberResults.append(display("value", pp.to_string().value(), True, True))
                midas_utils.sendResponse(self.name, variables_response(members=memberResults), midas_utils.prepareCommandResponse)
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
                item = display(member, it[member], midas_utils.typeIsPrimitive(it[member].type))
                memberResults.append(item)

            for static in statics:
                item = static_display(static, it.type[static].type)
                staticResult.append(item)

            for baseclass in baseclasses:
                item = base_class_display(baseclass, it.type[baseclass].type)
                baseClassResult.append(item)
            midas_utils.sendResponse(self.name, variables_response(members=memberResults, statics=staticResult, base_classes=baseClassResult), midas_utils.prepareCommandResponse)
        except Exception as e:
            misc_logger.error("Couldn't get base class contents")
            midas_utils.sendResponse(self.name, None, midas_utils.prepareCommandResponse)

contentsOfBaseClassCommand = ContentsOfBaseClass()

def getAndTraverseExpressionPath(frame, expression):
    components = expression.split(".")
    ancestor = midas_utils.getClosest(frame, components[0])
    it = midas_utils.resolveGdbValue(ancestor, components[1:])
    return it

class ContentsOf(gdb.Command):
    def __init__(self):
        super(ContentsOf, self).__init__("gdbjs-get-contents-of", gdb.COMMAND_USER)
        self.name = "get-contents-of"

    @config.timeInvocation
    def invoke(self, arguments, from_tty):
        [threadId, frameLevel, expression] = midas_utils.parseCommandArguments(arguments)
        (thread, frame) = config.currentExecutionContext.set_context(threadId=int(threadId), frameLevel=int(frameLevel))
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
                        memberResults.append(display(name, value, midas_utils.typeIsPrimitive(value.type)))
                    midas_utils.sendResponse(self.name, variables_response(members=memberResults), midas_utils.prepareCommandResponse)
                except Exception as e:
                    config.log_exception(err_logger, "failed to get pretty printed value: {}. There's no value attribute?".format(e), e)
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
                midas_utils.sendResponse(self.name, variables_response(members=memberResults), midas_utils.prepareCommandResponse)
            return

        if midas_utils.memberIsReference(it.type):
            it = it.referenced_value()
        try:
            fields = it.type.fields()
            for field in fields:
                if hasattr(field, 'bitpos') and field.name is not None and not field.name.startswith("_vptr") and not field.is_base_class:
                    item = display(field.name, it[field.name], midas_utils.typeIsPrimitive(it[field.name].type))
                    memberResults.append(item)
                elif field.is_base_class:
                    item = base_class_display(field.name, it.type[field.name].type)
                    baseClassResults.append(item)
                elif not hasattr(field, "bitpos"):
                    item = static_display(field.name, it.type[field.name].type)
                    staticsResults.append(item)

            midas_utils.sendResponse(self.name, variables_response(members=memberResults, statics=staticsResults, base_classes=baseClassResults), midas_utils.prepareCommandResponse)
        except Exception as e:
            extype, exvalue, extraceback = sys.exc_info()
            fieldsNames = []
            for field in fields:
                fieldsNames.append("{}".format(field.name))
            config.log_exception(err_logger, "Couldn't retrieve contents of {}. Exception type: {} - Exception value: {}. Fields: {}".format(expression, extype, exvalue, fieldsNames), e)
            midas_utils.sendResponse(self.name, None, midas_utils.prepareCommandResponse)


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

    @config.timeInvocation
    def invoke(self, arguments, from_tty):
        [threadId, frameLevel, scope] = midas_utils.parseCommandArguments(arguments)
        (thread, frame) = config.currentExecutionContext.set_context(threadId=int(threadId), frameLevel=int(frameLevel))
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
                            item = display(symbol.name, value, midas_utils.typeIsPrimitive(value.type))
                            result.append(item)
                        except Exception as e:
                            midas_utils.log_exception(err_logger, "Err was thrown in GetLocals (gdbjs-get-locals). Name of symbol that caused error: {0}\n".format(name), e)
                            names.remove(name)
                block = block.superblock
            midas_utils.sendResponse(self.name, result, midas_utils.prepareCommandResponse)
        except Exception as e:
            config.log_exception(err_logger, "Exception thrown in GetLocals.invoke", e)
            midas_utils.sendResponse(self.name, [], midas_utils.prepareCommandResponse)

getLocalsCommand = GetLocals()

class SetWatchPoint(gdb.Command):
    def __init__(self):
        super(SetWatchPoint, self).__init__("gdbjs-watchpoint", gdb.COMMAND_USER)
        self.name = "watchpoint"

    def invoke(self, args, from_tty):
        [type, expression] = midas_utils.parseCommandArguments(args)
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
        midas_utils.sendResponse(self.name, { "number": bp.number }, midas_utils.prepareCommandResponse)

setWatchPointCommand = SetWatchPoint()