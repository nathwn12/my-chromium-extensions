// Minimal RFC 6455 WebSocket client over node:net.
//
// Why not the global WebSocket: Chrome's DevTools endpoint rejects any upgrade
// that carries an `Origin` header, and Node's built-in WebSocket always sends
// one. Speaking the protocol directly sends no Origin, so the harness needs no
// `--remote-allow-origins=*` argument and no dependency.
//
// Scope: text frames, fragmentation, ping/pong, close. That is all CDP needs.

import { connect as netConnect } from "node:net";
import { randomBytes, createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** @returns {Promise<{send:(text:string)=>void, onMessage:(cb:(text:string)=>void)=>void, onClose:(cb:(reason:string)=>void)=>void, close:()=>void}>} */
export function openWebSocket(url, { timeoutMs = 15000 } = {}) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return Promise.reject(new Error(`not a websocket url: ${url}`));
  }
  if (target.protocol !== "ws:") {
    return Promise.reject(new Error(`only ws:// is supported, got ${target.protocol}`));
  }
  const host = target.hostname;
  const port = Number(target.port || 80);
  const path = `${target.pathname}${target.search}`;
  const key = randomBytes(16).toString("base64");
  const expectedAccept = createHash("sha1").update(key + GUID).digest("base64");

  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port });
    let buffer = Buffer.alloc(0);
    let handshakeDone = false;
    let fragments = [];
    let fragmentOpcode = 0;
    const messageHandlers = [];
    const closeHandlers = [];
    let closed = false;

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`websocket handshake timed out after ${timeoutMs}ms (${url})`));
    }, timeoutMs);

    function fail(error) {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      socket.destroy();
      for (const fn of closeHandlers) fn(error.message);
      reject(error);
    }

    socket.on("error", fail);
    socket.on("close", () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      for (const fn of closeHandlers) fn("socket closed");
    });

    socket.on("connect", () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${host}:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
    });

    socket.on("data", (chunk) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;

      if (!handshakeDone) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString("latin1");
        buffer = buffer.subarray(end + 4);
        const statusLine = head.split("\r\n")[0] ?? "";
        if (!/^HTTP\/1\.1 101\b/.test(statusLine)) {
          fail(new Error(`websocket upgrade refused: ${statusLine} (${url})`));
          return;
        }
        if (!head.toLowerCase().includes(`sec-websocket-accept: ${expectedAccept.toLowerCase()}`)) {
          fail(new Error(`websocket upgrade returned a bad Sec-WebSocket-Accept (${url})`));
          return;
        }
        handshakeDone = true;
        clearTimeout(timer);
        resolve({ send, onMessage, onClose, close });
        if (!buffer.length) return;
      }

      for (;;) {
        const frame = readFrame(buffer);
        if (!frame) return;
        buffer = buffer.subarray(frame.bytes);
        const { fin, opcode, payload } = frame;

        if (opcode === 0x8) {
          closed = true;
          clearTimeout(timer);
          try {
            socket.end();
          } catch {
            /* already gone */
          }
          for (const fn of closeHandlers) fn("peer closed");
          return;
        }
        if (opcode === 0x9) {
          writeFrame(0xa, payload);
          continue;
        }
        if (opcode === 0xa) continue;

        if (opcode === 0x0) {
          fragments.push(payload);
        } else {
          fragments = [payload];
          fragmentOpcode = opcode;
        }
        if (!fin) continue;
        const body = Buffer.concat(fragments);
        fragments = [];
        if (fragmentOpcode !== 0x1) continue;
        const text = body.toString("utf8");
        for (const fn of messageHandlers) fn(text);
      }
    });

    function send(text) {
      if (closed || !handshakeDone) return;
      writeFrame(0x1, Buffer.from(text, "utf8"));
    }

    function writeFrame(opcode, payload) {
      const mask = randomBytes(4);
      const len = payload.length;
      let header;
      if (len < 126) {
        header = Buffer.from([0x80 | opcode, 0x80 | len]);
      } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(len, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(len), 2);
      }
      const masked = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
      try {
        socket.write(Buffer.concat([header, mask, masked]));
      } catch {
        /* write after close is not an error worth surfacing */
      }
    }

    function onMessage(cb) {
      messageHandlers.push(cb);
    }
    function onClose(cb) {
      closeHandlers.push(cb);
    }
    function close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      try {
        socket.end();
      } catch {
        /* already gone */
      }
    }
  });
}

function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const big = buffer.readBigUInt64BE(offset);
    if (big > BigInt(64 * 1024 * 1024)) throw new Error("websocket frame too large");
    length = Number(big);
    offset += 8;
  }
  let maskKey = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    maskKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;
  const payload = buffer.subarray(offset, offset + length);
  return {
    fin,
    opcode,
    payload: maskKey ? unmask(payload, maskKey) : payload,
    bytes: offset + length,
  };
}

function unmask(payload, mask) {
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ mask[i & 3];
  return out;
}
