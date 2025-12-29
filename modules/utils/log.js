/**
 * Log to Developer Tools console. Open the console via (Help->Toggle developer tools)
 * @param {string} string
 */
function consoleLog(string) {
  console.log(`[midas]: ${string}`);
}

function consoleWarn(string) {
  console.warn(`[midas]: ${string}`);
}

function consoleErr(string) {
  console.error(`[midas]: ${string}`);
}

module.exports = {
  consoleLog,
  consoleWarn,
  consoleErr
};
