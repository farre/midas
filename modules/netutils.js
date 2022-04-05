const net = require("net");

/**
 * @param { net.Server } server
 * @param { number } portToCheck
 * @returns { Promise<number> }
 */
function getPort(server, portToCheck) {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen({port: portToCheck, host: "127.0.0.1"}, () => {
      const addressInfo = server.address();
      resolve(addressInfo.port);
    });
  });
}
  
// todo(simon): create some random port generator, when serverAddress is not set in launch config
async function getFreeRandomPort(portRange = { begin: 50505, end: 65000 }) {
  const server = net.createServer();
  server.unref();
  for(let port = portRange.begin; port < portRange.end; port++) {
    try {
      let p = await getPort(server, port);
      console.log(`port found on: ${p}`);
      server.close();
      return p;
    } catch(err) {
      console.log(`port ${port} already taken`);
    }
  }
  throw new Error("Could not find port");
}

module.exports = {
  getPort,
  getFreeRandomPort
}