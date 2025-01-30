function create({ PrettyPrinter }) {
  class StdOptionalPrinter extends PrettyPrinter {
    constructor() {
      super(".*optional<.*>");
    }

    async valueHint(variable) {
      const expanded = await variable.children();
      const base = await expanded[0].children();
      const payload = await base[1].children();
      const payloadBase = await payload[0].children();
      if (payloadBase.find((value) => value.name === "_M_engaged").value == "false") {
        variable.value = "no value";
        variable.toLiteral();
      } else {
        variable.cache(payloadBase.find((value) => value.name === "_M_payload"));
      }
    }

    async valueExpanded(variables) {
      if (variables.value(0).hasChildren()) {
        const children = await variables.value(0).children();
        variables.update(0, children[0]);
      }
    }
  }

  return new StdOptionalPrinter();
}

module.exports = { create };
