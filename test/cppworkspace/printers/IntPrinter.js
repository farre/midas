
function create({LiteralPrinter}) {
  class IntPrinter extends LiteralPrinter {
    constructor() {
      super("int");
    }

    prettify(variable) {
      variable.value = `int ${variable.value}`;
    }
  }

  return new IntPrinter();
}

module.exports = { create }
