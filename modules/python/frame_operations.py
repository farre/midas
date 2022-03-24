import gdb

def frame_iterator(frame):
    while frame is not None:
        yield(frame)
        frame = frame.older()

def take_n_frames(frame, num):
    count = num
    for f in frame_iterator(frame):
        if count == 0:
            return
        else:
            yield f
        count -= 1

def find_first_equal_frame(stackFrameList, frameList):
    for x, sf in enumerate(stackFrameList):
        fa = sf.frame
        for y, fb in enumerate(frameList):
            if fa == fb:
                return (x, y)
    return None

def find_first_identical_frames(stackFrameList, frame, stopCount):
    f = [f for f in take_n_frames(frame, stopCount)]
    stopCount = min(stopCount, len(stackFrameList))
    for x in range(stopCount):
        fa = stackFrameList[x].frame
        for y, fb in enumerate(f):
            if fa == fb:
                return (x, y)
    return None

def iterate_frame(frame, levels):
    try:
        while levels > 0:
            frame = frame.older()
            levels -= 1
        return frame
    except:
        return None