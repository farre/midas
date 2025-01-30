const { DebugLogging } = require("./constants");

/**
 * @param { string } setting
 * @returns { { trace: boolean, pythonLogging: boolean } }
 */
function debugLogging(setting) {
  switch (setting.toLowerCase()) {
    case DebugLogging.Off:
      return { trace: false, pythonLogging: false };
    case DebugLogging.Full:
      return { trace: true, pythonLogging: true };
  }
  throw new Error(`Debug log settings set to incorrect value: ${setting}`);
}

module.exports = {
  debugLogging,
};
