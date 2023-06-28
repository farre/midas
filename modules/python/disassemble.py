import gdb
import json


from os import path
import midas_utils
import config

def guess_backwards(start, total_offset, current_disassembly):
    return start - 4 * (total_offset - len(current_disassembly))

file = open("/home/cx/dev/foss/cx/midas/disasm.log", "w")

def logln(msg):
    file.write(f"{msg}\n")
    file.flush()

def disassemble_backwards(arch: gdb.Architecture, end_pc: int, offset: int, count: int):
    instruction_at_pc = arch.disassemble(start_pc=end_pc)[0]
    offset = abs(offset)
    start = guess_backwards(end_pc, offset, [])
    logln(f"DISASM: end_pc: {end_pc}, guessed start {start} offset: {offset} count {count}")
    disassembled = []
    while len(disassembled) < (offset + 1):
        try:
          block = gdb.current_progspace().block_for_pc(start)
          if block is None:
              disassembled = [{"addr": 0, "asm": "unknown"} for x in range(0, (offset+1) - len(disassembled))] + disassembled
          else:
              disassembled = arch.disassemble(start_pc=block.start, end_pc=end_pc) + disassembled
          start = guess_backwards(start, offset, disassembled)
          end_pc = block.start
        except Exception as e:
            logln(f"FAILED: {e} - block was probably none: {block}")


    diff = len(disassembled) - offset
    result = disassembled[diff : diff + count]
    if result[-1]["addr"] == instruction_at_pc["addr"]:
        result.pop()
        result = [disassembled[diff - 1]] + result
    return result[:count]

class DisassembleRequest(gdb.Command):

    def __init__(self):
        super(DisassembleRequest, self).__init__("gdbjs-disassemble", gdb.COMMAND_USER)
        self.name = "disassemble"

    @config.timeInvocation
    def invoke(self, args, from_tty):
        [memoryReference, offset, instructionOffset, instructionCount, resolveSymbols] = midas_utils.parse_command_args(args, str, int, int, int, bool)
        arch = gdb.selected_frame().architecture()
        addr = int(memoryReference, 16) + (offset if offset is not None else 0)
        result = []
        if instructionOffset < 0:
            ins = disassemble_backwards(arch, addr, instructionOffset, instructionCount)
            instructionOffset = 0
            instructionCount = instructionCount - len(ins)
            result = [ {"address": hex(x["addr"]), "instruction": x["asm"]} for x in ins ]
        logln(f"{json.dumps(result)}")
        for dis in arch.disassemble(start_pc=addr, count=instructionCount):
            result.append({ "address": hex(dis["addr"]), "instruction": dis["asm"] })

        midas_utils.send_response(self.name, { "instructions": result }, midas_utils.prepare_command_response)