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
  /** @type {number} */
  core;
  /** @type {string} */
  name;
  /** @type {string} */
  state;
  /**@type {ThreadGroup} */
  group;
  /**@type {StackFrame} */
  frame;
  constructor(id, core, name, state, target_id, frame) {
    this.id = Number.parseInt(id);
    this.core = Number.parseInt(core);
    this.group = new ThreadGroup("-1", name, target_id);
    this.frame = new StackFrame(
      frame.file,
      frame.fullname,
      frame.line,
      frame.func,
      frame.level,
      frame.addr
    );
    this.state = state;
  }
}

class ThreadGroup {
  /**@type {number} */
  id;
  /**@type {string} */
  executable;
  /**@type {number} */
  pid;

  /**
   *
   * @param {string} id
   * @param {string} executable
   * @param {string} target_id
   */
  constructor(id, executable, target_id) {
    this.id = Number.parseInt(id);
    this.executable = executable;
    if (target_id.includes("process")) {
      this.pid = Number.parseInt(target_id.split(" ")[1]);
    } else {
      this.pid = Number.parseInt(target_id);
    }
  }
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

  get address() {
    return `0x${this.addr.toString(16)}`;
  }
}

/**
 * Compact variable Info. Displays the bare minimum about a variable
 */
class VariableCompact {
  /**@type {string} */
  name;
  /**@type {string} */
  valueStr;
  /**@type {string} */
  type;
  constructor(name, value, type) {
    this.name = name;
    this.valueStr = value;
    this.type = type;
  }
}

module.exports = {
  Breakpoint,
  Thread,
  ThreadGroup,
  StackFrame,
  VariableCompact,
  toBP,
};
