const { isNothing, getVersion, requiresMinimum, showErrorPopup } = require("../utils/utils");
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
    let version;
    try {
      version = await getVersion(config.gdbPath);
    } catch (e) {
      await showErrorPopup("Midas might not work properly", e.message, [
        {
          title: "Could not determine GDB version",
          action: async () => {},
        },
      ]);
      return;
    }
    requiresMinimum(version, { major: 9, minor: 1, patch: 0 });
  }
}

module.exports = {
  ConfigurationProviderInitializer,
};
