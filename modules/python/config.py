"""the config module holds settings for Midas but it also keeps global state for the backend."""

import gdb
import logging

from midas_utils import memberIsReference, typeIsPrimitive
from frame_operations import find_first_identical_frames, take_n_frames

from os import path
from stackframe import StackFrame
from variablesrequest import Variable, BaseClass, StaticVariable

global isDevelopmentBuild
global setTrace
global currentExecutionContext
global executionContexts

variableReferenceCounter = 0
isDevelopmentBuild = False
setTrace = False
executionContexts = {}

def nextVariableReference():
    global variableReferenceCounter
    res = variableReferenceCounter + 1
    variableReferenceCounter += 1
    return res

# Midas Terminology
# Execution Context: Thread (id) and Frame (level)
# Registers the current execution context
class CurrentExecutionContext:
    inferior = None
    def __init__(self):
        self.threadId = -1
        self.frameLevel = -1
        CurrentExecutionContext.inferior = gdb.selected_inferior()

    def set_thread(self, threadId):
        if self.threadId != threadId:
            for t in CurrentExecutionContext.inferior.threads():
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

currentExecutionContext = CurrentExecutionContext()

class ExecutionContext:
    def __init__(self, threadId):
        self.threadId = threadId
        # Hallelujah (ironic) for type info. I miss Rust.
        self.stack = []
        # gdb.Frame[]
        self.backtrace = []

    def get_frames(self, start, levels):
        (t, f) = currentExecutionContext.set_context(self.threadId, start)
        result = []
        if len(self.stack) > 0:
            if self.stack[0].is_same_frame(f):
                for sf in self.stack:
                    result.append(sf.getVSFrame())
                return result
            res = find_first_identical_frames(self.stack, f, 10)
            if res is not None:
                (x, y) = res
                if x < y:
                    frames_to_add = [f for f in take_n_frames(f, y - x)]
                    for f in reversed(frames_to_add):
                        self.stack.insert(0, StackFrame(f))
                elif x > y:
                    self.stack = self.stack[y:]
                    if len(self.stack) < start + levels:
                        remainder = (start + levels) - len(self.stack)
                        for frame in take_n_frames(self.stack[-1].frame, remainder):
                            self.stack.append(StackFrame(f))
                else:
                    raise gdb.GdbError("This should not be possible.")
            else:
                for frame in take_n_frames(f, levels):
                    self.stack.append(StackFrame(frame))
        else:
            for frame in take_n_frames(f, levels):
                self.stack.append(StackFrame(frame))
        result = []
        for sf in self.stack:
            result.append(sf.getVSFrame())
        return result

def createExecutionContext(threadId: int):
    if executionContexts.get(threadId) is not None:
        raise gdb.GdbError("Trying to create execution context for an already created context.")
    ec = ExecutionContext(threadId)
    executionContexts[threadId] = ec
    return ec