
function create({LiteralPrinter}) {
  class FooPrinter extends LiteralPrinter {
    constructor() {
      super("Foo");
    }

    async prettify(variable) {
      const children = await variable.children();
      const data = children.map(child => {
        return `${child.name} = ${child.value}`
      })
      variable.value = `Foo { ${data.join(', ')} }`;
    }
  }

  return new FooPrinter();
}

module.exports = { create }
