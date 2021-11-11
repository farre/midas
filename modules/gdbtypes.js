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

/**
 * GDB returns a target-id string that (probably) contains LWP NNNNNN where N stands for
 * the light weight process ID.
 * @param {string} target_id
 * @returns string
 */
function formatTargetId(target_id) {
  let pos = target_id.indexOf("LWP");
  if (pos != -1) {
    let res = Number.parseInt(target_id.substr(pos + 4));
    return res == NaN ? target_id : res;
  } else {
    return target_id;
  }
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
  /**@type {string | number} */
  target_id;
  constructor(id, core, name, state, target_id, frame) {
    this.id = Number.parseInt(id);
    this.core = Number.parseInt(core);
    this.group = new ThreadGroup("-1", name);

    this.target_id = formatTargetId(target_id);

    if (frame) {
      this.frame = new StackFrame(
        frame.file,
        frame.fullname,
        frame.line,
        frame.func,
        frame.level,
        frame.addr
      );
    } else {
      this.frame = undefined;
    }
    this.state = state;
  }
}

class ThreadGroup {
  /**@type {number} */
  id;
  /**@type {string} */
  executable;
  /**@type {number | undefined} */
  pid;

  /**
   *
   * @param {string} id
   * @param {string} executable
   */
  constructor(id, executable) {
    this.id = Number.parseInt(id);
    this.executable = executable;
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
    this.addr = Number.parseInt(addr, 16);
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

/**
 * 1-to-1 representation of https://sourceware.org/gdb/current/onlinedocs/gdb/GDB_002fMI-Variable-Objects.html
 */
class VariableObject {
  /**
   * The name assigned by GDB to variable objects, so it's *not* the name of the variable
   * in the source code
   * @type {string} */
  name;

  /** Actual variable name
   * @type {string} */
  expression;

  /**
   * Number of children reported by GDB. Note that GDB reports keywords like public/private/protected as children.
   * Thus, in order to get the actual members of a type, we must first drill into the public/.. child, to find *it's*
   * children, then we find the actual members of that block.
   * @type {number} */
  numchild;

  /**
   * If this VariableObject represents a primitive type, this value will be set
   * @type { string | undefined } */
  value;

  /** Type of this varible
   * @type {string} */
  type;

  /** @type { boolean } */
  has_more;

  /** This member does not exist on a GDB Variable Object, it's for VSCode only
   * @type { number } */
  variableReference;

  constructor(
    name,
    expression,
    childrenCount,
    value,
    type,
    has_more,
    variableReference
  ) {
    this.name = name;
    this.expression = expression;
    this.numchild = parseInt(childrenCount);
    this.value = value;
    this.type = type;
    this.has_more = has_more == "0";
    this.variableReference = variableReference;
  }
}

module.exports = {
  Breakpoint,
  Thread,
  ThreadGroup,
  StackFrame,
  VariableCompact,
  VariableObject,
  toBP,
};
