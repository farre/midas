// These are just to reduce mental overhead - some of these types actually already exist in
// gdb-js, This is just so I don't have to juggle so much between
// docs, the source code, then docs. Ultimately, this will be killed off.
class Breakpoint {
  /**@type {number} */
  id;
  /**@type {string} */
  file;
  /**@type {number} */
  line;
  /**@type {string[]} */
  functions;
  /**@type {Thread} */
  thread;
  /**@type number */
  address = 0;

  constructor(id, file, line, functions, thread) {
    this.id = id;
    this.file = file;
    this.line = line;
    this.functions = functions;
    this.thread = thread;
  }

  toString() {
    return `Breakpoint: ${this.id} - ${this.file}:${this.line} in ${this.functions}`;
  }
}

function toBP(bp) {
  return new Breakpoint(
    bp.id,
    bp.options.file,
    bp.options.functions,
    bp.options.thread
  );
}

class Thread {
  /**@type {number} */
  id;
  /**@type {string} */
  status;
  /**@type {ThreadGroup} */
  group;
  /**@type {StackFrame} */
  frame;
}

class ThreadGroup {
  /**@type {number} */
  id;
  /**@type {string} */
  executable;
  /**@type {number} */
  pid;
}

class StackFrame {
  /**@type {string} */
  file;
  /**@type {string} */
  fullname;
  /**@type {number} */
  line;
  /**@type {string} */
  func;
  /**@type {number} */
  level;
  /**@type {number} */
  addr;
  /**
   * Constructor that takes data from an execMI call - where each data item is a string
   * which we parse in this constructor for simplicity. All "wrapper types"
   * will behave this going forward.
   * @param {string} file
   * @param {string} line
   * @param {string} func
   * @param {string} level
   * @param {string} addr
   */
  constructor(file, fullname, line, func, level, addr) {
    this.file = file;
    this.fullname = fullname;
    this.line = Number.parseInt(line);
    this.func = func;
    this.level = Number.parseInt(level);
    this.addr = Number.parseInt(addr);
  }
}

module.exports = {
  Breakpoint,
  Thread,
  ThreadGroup,
  StackFrame,
  toBP,
};
