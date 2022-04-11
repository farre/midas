const { isNothing } = require("../utils");

class ConfigurationProviderInitializer {
  /**
   * @param {any} config
   * @param {any} initializer
   */
  async defaultInitialize(config, initializer) {
    // if launch.json is missing or empty
    if (isNothing(config) || isNothing(config.type)) {
      throw new Error("Cannot start debugging because no launch configuration has been provided");
    }
    await initializer(config);
  }
}

module.exports = {
  ConfigurationProviderInitializer,
};
