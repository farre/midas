class ConfigurationProviderInitializer {
  /**
   * @param {any} config 
   * @param {any} initializer 
   */
  defaultInitialize(config, initializer) {
    // if launch.json is missing or empty
    if (!config || !config.type || config.type == undefined) {
      throw new Error("Cannot start debugging because no launch configuration has been provided")
    }
    initializer(config);
  }
}

module.exports = {
  ConfigurationProviderInitializer,
};
