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

  constructor(id, file, line, functions, thread) {
    this.id = id;
    this.file = file;
    this.line = line;
    this.functions = functions;
    this.thread = thread;
  }
}

class Thread {
  /**@type {number} */
  id;
  /**@type {string} */
  status;
  /**@type {ThreadGroup} */
  group;
  /**@type {Frame} */
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

class Frame {
  /**@type {string} */
  file;
  /**@type {number} */
  line;
  /**@type {string} */
  func;
  /**@type {number} */
  level;
}



module.exports = {
  Breakpoint,
  Thread,
  ThreadGroup,
  Frame,
};
