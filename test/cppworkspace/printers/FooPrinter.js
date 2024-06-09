
function create({PrettyPrinter}) {
  class FooPrinter extends PrettyPrinter {
    constructor() {
      super("Foo");
    }

    async valueHint(variable) {
      const children = await variable.children();
      const data = children.map(child => {
        return `${child.name} = ${child.value}`
      })
      variable.value = `Foo { ${data.join(', ')} }`;
      variable.toLiteral();
    }
  }

  return new FooPrinter();
}

module.exports = { create }
