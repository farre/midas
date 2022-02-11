import gdb
import sys
import json
import gdb.types
import traceback
import logging

logging.basicConfig(filename='update.log', filemode="w", encoding='utf-8', level=logging.DEBUG)

staticsTracker = {}

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
        statics = []
        fields = it.type.fields()
        for f in fields:
            getMembersRecursively(f, members, statics=statics)
        result = []
        # register the static members we've seen
        if staticsTracker.get(components[0]) is None:
            staticsTracker[components[0]] = {}
        iter = staticsTracker[components[0]]
        for component in components[1:]:
            if iter.get(component) is None:
                iter[component] = { "statics": None }
            iter = iter[component]
        
        if len(statics) != 0:
            iter["statics"] = statics
        
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