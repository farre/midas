const { isNothing } = require("../utils");

class ConfigurationProviderInitializer {
  /**
   * @param {any} config 
   * @param {any} initializer 
   */
  defaultInitialize(config, initializer) {
    // if launch.json is missing or empty
    if (isNothing(config) || isNothing(config.type)) {
      throw new Error("Cannot start debugging because no launch configuration has been provided")
    }
    initializer(config);
  }
}

module.exports = {
  ConfigurationProviderInitializer,
};
