const { isNothing, getVersion, requiresMinimum } = require("../utils/utils");

const InitExceptionTypes = {
  GdbVersionUnknown: "GdbVersionUnknown",
  NullConfig: "NullConfig"
};

class ConfigurationProviderInitializer {
  /**
   * @param {any} config
   * @param {any} initializer
   * @throws {{ type: string, message: string }}
   */
  async defaultInitialize(config, initializer) {
    // if launch.json is missing or empty
    if (isNothing(config) || isNothing(config.type)) {
      throw { type: InitExceptionTypes.NullConfig, message: "No launch.json found" };
    }
    await initializer(config);
    let version;
    try {
      version = await getVersion(config.gdbPath);
    } catch (e) {
      throw { type: InitExceptionTypes.GdbVersionUnknown, message: `GDB Version could not be determined. ${e}` };
    }
    requiresMinimum(version, { major: 9, minor: 1, patch: 0 });
  }
}

module.exports = {
  ConfigurationProviderInitializer,
  InitExceptionTypes
};
