const net = require("net");
/**
 * @typedef { import("events").EventEmitter } EventEmitter
 * @typedef { import("./dap-base").Event | import("./dap-base").Response } DAPMessage
 * @typedef { ( eventName: string | symbol, listener: (...args: any[]) => void, ) => EventEmitter } EventSubscriber
 * @typedef { ( buffer: string | Uint8Array, cb?: (err?: Error) => void) => boolean } WriteFn
 * @typedef { { recv : { on: EventSubscriber }, send: { write: WriteFn }}} DataChannel
 * @typedef {{ start: number, end: number, all_received: boolean }} PacketBufferMetaData
 */

function connect_socket(name, path, attempts, attempt_interval) {
  return new Promise((res, rej) => {
    const socket = new net.Socket();
    socket.connect({ path: path });

    socket.on("connect", () => {
      res(socket);
    });

    socket.on("error", (error) => {
      socket.destroy();

      if (attempts === 0) {
        rej(error);
      } else {
        setTimeout(() => {
          connect_socket(name, path, attempts - 1, attempt_interval + 50)
            .then(res)
            .catch(rej);
        }, attempt_interval);
      }
    });
  });
}

/**
 * Serialize request, preparing it to be sent over the wire to GDB
 * @param {number} seq
 * @param {string} request
 * @param {*} args
 * @returns {string}
 */
function serializeRequest(seq, request, args = {}) {
  const json = {
    seq,
    type: "request",
    command: request,
    arguments: args,
  };
  const data = JSON.stringify(json);
  const length = data.length;
  const res = `Content-Length: ${length}\r\n\r\n${data}`;
  return res;
}

const MessageHeader = /Content-Length: (\d+)\s{4}/gm;

/**
 * @param {string} contents
 * @returns { PacketBufferMetaData[] }
 */
function processBuffer(contents) {
  let m;
  const result = [];
  while ((m = MessageHeader.exec(contents)) !== null) {
    // This is necessary to avoid infinite loops with zero-width matches
    if (m.index === MessageHeader.lastIndex) {
      MessageHeader.lastIndex++;
    }
    // The result can be accessed through the `m`-variable.
    let contents_start = 0;
    m.forEach((match, groupIndex) => {
      if (groupIndex == 0) {
        contents_start = m.index + match.length;
      }

      if (groupIndex == 1) {
        const len = Number.parseInt(match);
        const all_received = contents_start + len <= contents.length;
        result.push({ start: contents_start, end: contents_start + len, all_received });
      }
    });
  }
  return result;
}

/**
 * Parses the contents in `buffer` using the packet metadata in `metadata`.
 * Returns what's remaining in the buffer that's not parsed. Not every packet is required
 * to have been handled
 * @param {string} buffer
 * @param {PacketBufferMetaData[]} metadata
 * @returns { { buffer: string, protocol_messages: DAPMessage[]  } }
 */
function parseBuffer(buffer, metadata) {
  let parsed_end = 0;
  const res = [];
  for (const { start, end } of metadata.filter((i) => i.all_received)) {
    const data = buffer.slice(start, end);
    const json = JSON.parse(data);
    res.push(json);
    parsed_end = end;
  }
  buffer = buffer.slice(parsed_end);
  return { buffer, protocol_messages: res };
}

class MidasCommunicationChannel {
  // TODO(simon): Use a better buffer here. Uint8 array?
  /** @type { string } */
  buffer;

  /** @type { DataChannel | null } */
  channel = null;

  constructor(name, emitter) {
    this.name = name;
    /** @type { EventEmitter } */
    this.emitter = emitter;
    // TODO(simon): Do something much better. For now this is just easy enough, i.e. using a string.
    //  We *really* should do something better here. But until it becomes a problem, let's just be stupid here
    this.buffer = "";
  }

  /**
   * If `waitableSendRequest` has been called, this will emit the response to the waiter.
   * Otherwise it will be handled by the normal sendResponse routine
   * @param {*} msg
   */
  reportResponse(msg) {
    if (!this.emitter.emit(`${msg.request_seq}`, msg)) {
      this.emitter.emit("response", msg);
    }
  }

  async connect() {
    this.channel = await this.resolveInputDataChannel().then((channel) => {
      channel.recv.on("data", (data) => {
        const str = data.toString();
        this.buffer = this.buffer.concat(str);
        const packets = processBuffer(this.buffer).filter((i) => i.all_received);
        const { buffer: remaining_buffer, protocol_messages } = parseBuffer(this.buffer, packets);
        this.buffer = remaining_buffer;
        for (const msg of protocol_messages) {
          const type = msg.type;
          switch (type) {
            case "response":
              this.reportResponse(msg);
              break;
            default:
              this.emitter.emit(type, msg);
          }
        }
      });
      return channel;
    });
  }

  write(data) {
    this.channel.send.write(data, (err) => {
      if (err) {
        console.error(`Failed to write ${data} to socket: ${err}`);
        throw err;
      }
    });
  }

  /**
   * @returns { Promise<DataChannel> }
   */
  async resolveInputDataChannel() {
    throw new Error("Derived must implement this");
  }
}

class UnixSocketCommunication extends MidasCommunicationChannel {
  constructor(path, emitter) {
    super(path, emitter)
  }

  /**
   * @returns { Promise<DataChannel> }
   */
  async resolveInputDataChannel() {
    const sock = await connect_socket(this.name, this.name, 10, 50);
    return { recv: sock, send: sock };
  }
}

module.exports = {
  MidasCommunicationChannel,
  UnixSocketCommunication,
  MessageHeader,
  serializeRequest,
  parseBuffer,
  processBuffer,
  connect_socket
};
