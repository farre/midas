const { isNothing, getVersion, requiresMinimum } = require("../utils/utils");

const InitExceptionTypes = {
  GdbNotFound: "GdbNotFound",
  GdbVersionUnknown: "GdbVersionUnknown",
  RRNotFound: "RRNotFound",
  NullConfig: "NullConfig",
  MdbNotFound: "MdbNotFound",
};

async function gdbSettingsOk(config) {
  try {
    const version = await getVersion(config.gdbPath);
    requiresMinimum(version, { major: 9, minor: 1, patch: 0 });
  } catch (e) {
    throw { type: InitExceptionTypes.GdbVersionUnknown, message: `GDB Version could not be determined. ${e}` };
  }
}

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
  }
}

module.exports = {
  ConfigurationProviderInitializer,
  InitExceptionTypes,
  gdbSettingsOk,
};
