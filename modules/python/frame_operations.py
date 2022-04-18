import gdb


def frame_iterator(frame):
    while frame is not None:
        yield(frame)
        frame = frame.older()


def take_n_frames(frame, num):
    f_iterator = frame
    count = num
    for f in frame_iterator(f_iterator):
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
    frames = [f for f in take_n_frames(frame, stopCount)]
    stopCount = min(stopCount, len(stackFrameList))
    for x in range(stopCount):
        fa = stackFrameList[x].frame
        for y, fb in enumerate(frames):
            if fa == fb:
                newFrames = frames[:y]
                return (x, newFrames)
    return None


def iterate_frame(frame, levels):
    try:
        while levels > 0:
            frame = frame.older()
            levels -= 1
        return frame
    except:
        return None


def iterate_frame_blocks(frame) -> gdb.Block:
    block = frame.block()
    while not block.is_static and not block.superblock.is_global:
        yield block
        block = block.superblock


def find_top_function_block(frame) -> gdb.Block:
    block = frame.block()
    last = block
    while not block.is_static and not block.superblock.is_global:
        last = block
        block = block.superblock
    return last
