#!/usr/bin/env node
/**
 * End-to-end proof of the arRPC WebSocket path — the web fallback.
 *
 * A real RFC 6455 WebSocket server on 127.0.0.1:6471 plays arRPC. The real
 * native host is spawned with `WDR_ARRPC_PORTS=6471` and `WDR_DISCORD_PIPES`
 * pointed at an absent pipe, so the `auto` probe falls back to arRPC without
 * ever touching a Discord desktop that may be running on the machine. The
 * driver sends one hello plus one activity per source and then a clear, and
 * the host must open two WebSocket connections, publish a WATCHING (type 3)
 * and a LISTENING (type 2) activity, then clear one of them.
 *
 *   node scripts/e2e-arrpc.mjs
 */

import { createHash } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DEFAULT_CLIENT_ID } from "../config.js";
import { ARRPC_USERNAME, ARRPC_USER_ID } from "../native/arrpc.mjs";
import { createDecoder, encodeMessage } from "../native/native-framing.mjs";

const HOST_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "native", "host.mjs");
const PORT = 6471;
const TIMEOUT_MS = 10_000;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const waitFor = (predicate, label, timeoutMs = TIMEOUT_MS) => new Promise((resolve, reject) => {
  const started = Date.now();
  const tick = () => {
    let ok = false;
    try {
      ok = predicate();
    } catch {
      ok = false;
    }
    if (ok) {
      resolve();
      return;
    }
    if (Date.now() - started > timeoutMs) {
      reject(new Error(`timed out waiting for ${label}`));
      return;
    }
    setTimeout(tick, 10);
  };
  tick();
});

/* ------------------------------------------------------------ websocket wire */

function acceptKey(key) {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

/** One unmasked server frame: FIN set, text or pong. */
function encodeServerFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const length = body.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65_536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, body]);
}

/**
 * Decoder for masked client frames.
 *
 * shortcut: continuation frames are not reassembled — the client under test
 * sends one text frame per SET_ACTIVITY. Upgrade when a driver sends a
 * payload large enough for the client to fragment.
 */
class ClientFrameReader {
  #buffer = Buffer.alloc(0);

  /** @param {Buffer} chunk @returns {{opcode: number, text: string|null, payload: Buffer}[]} */
  push(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const frames = [];

    for (;;) {
      if (this.#buffer.length < 2) break;
      const opcode = this.#buffer[0] & 0x0f;
      const masked = (this.#buffer[1] & 0x80) !== 0;
      let length = this.#buffer[1] & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.#buffer.length < 4) break;
        length = this.#buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.#buffer.length < 10) break;
        length = Number(this.#buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskBytes = masked ? 4 : 0;
      if (this.#buffer.length < offset + maskBytes + length) break;

      let payload = this.#buffer.subarray(offset + maskBytes, offset + maskBytes + length);
      if (masked) {
        const mask = this.#buffer.subarray(offset, offset + 4);
        const clear = Buffer.allocUnsafe(length);
        for (let index = 0; index < length; index += 1) clear[index] = payload[index] ^ mask[index % 4];
        payload = clear;
      }
      this.#buffer = this.#buffer.subarray(offset + maskBytes + length);
      frames.push({ opcode, text: opcode === 0x1 ? payload.toString("utf8") : null, payload });
    }

    return frames;
  }
}

/* -------------------------------------------------------------- fake arRPC */

function readyFrame() {
  return {
    cmd: "DISPATCH",
    data: { v: 1, config: { environment: "production" }, user: { id: ARRPC_USER_ID, username: ARRPC_USERNAME } },
    evt: "READY",
    nonce: null,
  };
}

/**
 * Accept a real WebSocket upgrade, answer with an arRPC READY, and record every
 * SET_ACTIVITY the host sends together with the connection it arrived on.
 */
async function startArRpcServer(port, state) {
  const server = net.createServer((socket) => {
    const index = state.connections += 1;
    state.sockets.push(socket);
    socket.on("error", () => {});

    const reader = new ClientFrameReader();
    let head = Buffer.alloc(0);
    let upgraded = false;

    const onFrames = (chunk) => {
      for (const frame of reader.push(chunk)) {
        if (frame.opcode === 0x8) {
          socket.end();
          continue;
        }
        if (frame.opcode === 0x9) {
          socket.write(encodeServerFrame(0xa, frame.payload));
          continue;
        }
        if (frame.opcode !== 0x1) continue;

        let message;
        try {
          message = JSON.parse(frame.text);
        } catch {
          continue;
        }
        if (message?.cmd !== "SET_ACTIVITY") continue;

        state.frames.push({ socket: index, args: message.args, nonce: message.nonce });
        socket.write(encodeServerFrame(0x1, JSON.stringify({
          cmd: "SET_ACTIVITY",
          args: message.args,
          evt: null,
          nonce: message.nonce,
        })));
      }
    };

    socket.on("data", (chunk) => {
      if (upgraded) {
        onFrames(chunk);
        return;
      }

      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;

      const lines = head.subarray(0, end).toString("latin1").split("\r\n");
      const rest = head.subarray(end + 4);
      head = Buffer.alloc(0);

      const keyLine = lines.find((line) => line.toLowerCase().startsWith("sec-websocket-key:"));
      const key = keyLine?.slice(keyLine.indexOf(":") + 1).trim();
      if (!key) {
        socket.destroy();
        return;
      }

      const target = lines[0]?.split(" ")[1] ?? "/";
      const url = new URL(target, `ws://127.0.0.1:${port}`);
      state.upgrades.push({
        path: url.pathname,
        clientId: url.searchParams.get("client_id"),
        version: url.searchParams.get("v"),
      });

      socket.write([
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${acceptKey(key)}`,
        "",
        "",
      ].join("\r\n"));
      upgraded = true;
      socket.write(encodeServerFrame(0x1, JSON.stringify(readyFrame())));
      if (rest.length > 0) onFrames(rest);
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(new Error(`cannot listen on 127.0.0.1:${port}: ${error?.message ?? error}`));
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
  return server;
}

/* ------------------------------------------------------------------- driver */

async function main() {
  const state = { connections: 0, upgrades: [], frames: [], sockets: [] };
  const checks = [];
  const check = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail });

  const server = await startArRpcServer(PORT, state);
  const child = spawn(process.execPath, [HOST_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      // The one port the fake arRPC listens on...
      WDR_ARRPC_PORTS: String(PORT),
      // ...and a pipe that cannot exist, so `auto` falls back to arRPC instead
      // of publishing to a real Discord desktop on this machine.
      WDR_DISCORD_PIPES: `\\\\.\\pipe\\wdr-e2e-absent-${process.pid}-${Date.now().toString(36)}`,
    },
  });

  const frames = [];
  const decoder = createDecoder();
  let stderr = "";
  let stdoutError = null;
  child.stdout.on("data", (chunk) => {
    try {
      frames.push(...decoder.push(chunk));
    } catch (error) {
      stdoutError = error;
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const activities = [
    { source: "youtube", id: "e2e-youtube", activity: { type: 3, details: "Big Buck Bunny", state: "Blender" } },
    { source: "youtube-music", id: "e2e-music", activity: { type: 2, details: "Album Track", state: "Artist" } },
  ];
  const clear = { source: "youtube", id: "e2e-clear", activity: null };
  const ackOf = (id) => frames.filter((message) => message.t === "ack" && message.id === id).at(-1);

  try {
    child.stdin.write(encodeMessage({
      t: "hello",
      clientId: DEFAULT_CLIENT_ID,
      version: 1,
      transport: "auto",
    }));
    for (const { source, id, activity } of activities) {
      child.stdin.write(encodeMessage({ t: "activity", source, id, activity }));
    }
    child.stdin.write(encodeMessage({ t: "activity", ...clear }));

    const ids = [...activities.map(({ id }) => id), clear.id];
    await waitFor(
      () => ids.every((id) => ackOf(id) !== undefined),
      "three acks (WebSocket upgrade, READY, SET_ACTIVITY, reply)",
    );

    const acks = ids.map((id) => ackOf(id));
    check("both sources and the clear ack over arRPC", acks.every((ack) => ack?.ok === true), JSON.stringify(acks));

    const connected = frames.filter((message) => message.t === "status" && message.state === "connected").at(-1);
    check(
      "status reports connected on arrpc with a null reason and both sources",
      connected?.transport === "arrpc"
        && connected?.reason === null
        && connected?.sources?.youtube === "connected"
        && connected?.sources?.["youtube-music"] === "connected",
      JSON.stringify(connected ?? null),
    );

    check(
      "a real WebSocket server saw two connections, one per source, on the built-in client id",
      state.connections === 2
        && state.upgrades.length === 2
        && state.upgrades.every((upgrade) => upgrade.clientId === DEFAULT_CLIENT_ID && upgrade.version === "1"),
      JSON.stringify({ connections: state.connections, upgrades: state.upgrades }),
    );

    const sent = state.frames
      .filter((frame) => frame.args?.activity !== null)
      .map((frame) => ({
        type: frame.args?.activity?.type ?? null,
        details: frame.args?.activity?.details ?? null,
        socket: frame.socket,
      }));
    check(
      "each source reached arRPC as its own Discord type (3 and 2) on its own connection",
      sent.length === 2
        && new Set(sent.map((entry) => entry.socket)).size === 2
        && JSON.stringify(sent.map((entry) => [entry.type, entry.details]).sort((a, b) => a[0] - b[0]))
          === JSON.stringify([[2, "Album Track"], [3, "Big Buck Bunny"]]),
      JSON.stringify(sent),
    );

    const cleared = state.frames.find((frame) => frame.args?.activity === null);
    check(
      "the clear reached arRPC as a null activity on the connection that published it",
      cleared !== undefined
        && cleared.socket === sent.find((entry) => entry.type === 3)?.socket,
      JSON.stringify({ cleared: cleared ?? null, sent }),
    );

    check(
      "all three SET_ACTIVITYs name the host's pid",
      state.frames.length === 3 && state.frames.every((frame) => frame.args?.pid === child.pid),
      JSON.stringify(state.frames.map((frame) => frame.args?.pid ?? null)),
    );
  } catch (error) {
    check("the run completed", false, error?.message ?? String(error));
  } finally {
    child.stdin.end();
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), TIMEOUT_MS);
      child.once("exit", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    if (code === "timeout") child.kill();
    check("the host exits 0 when stdin closes", code === 0, `exit ${String(code)}; stderr: ${stderr.trim()}`);

    for (const socket of state.sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }

  check("stdout stayed decodable", stdoutError === null, String(stdoutError ?? ""));

  const failed = checks.filter((entry) => !entry.ok).length;
  for (const entry of checks) {
    process.stdout.write(
      `${entry.ok ? "PASS" : "FAIL"}  e2e-arrpc: ${entry.name}${entry.ok ? "" : `  (${entry.detail})`}\n`,
    );
  }
  process.stdout.write(`e2e-arrpc: ${failed === 0 ? "PASS" : "FAIL"} (${checks.length - failed}/${checks.length})\n`);
  if (failed > 0) process.stderr.write(`${stderr.trim()}\n`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`e2e-arrpc: fatal: ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
