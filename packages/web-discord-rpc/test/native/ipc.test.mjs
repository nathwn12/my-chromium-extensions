import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  DiscordFrameDecoder,
  DiscordIpcClient,
  MAX_DISCORD_FRAME,
  OP,
  encodeDiscordFrame,
} from "../../native/ipc.mjs";

const CLIENT_ID = "123456789012345678";

/* ---------------------------------------------------------------- helpers */

let pipeSeq = 0;

/**
 * A fresh endpoint per test: a named pipe on Windows, a Unix domain socket
 * elsewhere. Both are the same `net` server/client, so CI on Linux exercises
 * the real transport rather than skipping it.
 */
function nextPipePath() {
  pipeSeq += 1;
  const name = `wdr-ipc-test-${process.pid}-${pipeSeq}-${Date.now().toString(36)}`;
  return process.platform === "win32"
    ? `\\\\.\\pipe\\${name}`
    : path.join(os.tmpdir(), `${name}.sock`);
}

/** Deterministic clock: the client's timers only fire when `advance` says so. */
function makeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      seq += 1;
      timers.set(seq, { fn, at: now + Math.max(0, ms) });
      return seq;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) break;
        for (const [id, timer] of due) {
          if (!timers.delete(id)) continue;
          timer.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

function waitFor(predicate, label = "condition", timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
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
      setTimeout(tick, 5);
    };
    tick();
  });
}

/**
 * A real named pipe that speaks Discord IPC. Never a `discord-ipc-*` path, so
 * a developer's running Discord is untouched.
 */
async function startMockDiscord(options = {}) {
  const pipePath = nextPipePath();
  const state = {
    connections: 0,
    handshakes: 0,
    clientIds: [],
    frames: [],
    pongs: 0,
    sockets: [],
  };

  const server = net.createServer((socket) => {
    state.connections += 1;
    state.sockets.push(socket);
    socket.on("error", () => {});

    const decoder = new DiscordFrameDecoder();
    socket.on("data", (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.op === OP.HANDSHAKE) {
          state.handshakes += 1;
          state.clientIds.push(frame.payload?.client_id);
          if (options.silent) continue;
          if (options.closeHandshake) {
            socket.write(encodeDiscordFrame(OP.CLOSE, { code: 4000, message: "Invalid Client ID" }));
            continue;
          }
          socket.write(encodeDiscordFrame(OP.FRAME, {
            cmd: "DISPATCH",
            evt: "READY",
            nonce: null,
            data: { v: 1, user: { id: "0", username: "tester" } },
          }));
          if (options.ping) socket.write(encodeDiscordFrame(OP.PING, {}));
        } else if (frame.op === OP.FRAME) {
          state.frames.push(frame.payload);
          if (options.muteActivity) continue;
          if (options.mode === "error") {
            socket.write(encodeDiscordFrame(OP.FRAME, {
              cmd: "SET_ACTIVITY",
              evt: "ERROR",
              nonce: frame.payload?.nonce,
              data: { code: 4000, message: "Invalid activity for this client" },
            }));
            continue;
          }
          socket.write(encodeDiscordFrame(OP.FRAME, {
            cmd: "SET_ACTIVITY",
            evt: null,
            nonce: frame.payload?.nonce,
            data: { name: "Discord Test", activity: frame.payload?.args?.activity ?? null },
          }));
        } else if (frame.op === OP.PONG) {
          state.pongs += 1;
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  return {
    path: pipePath,
    state,
    drop() {
      for (const socket of state.sockets) socket.destroy();
    },
    async close() {
      for (const socket of state.sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      // Closing a Unix domain socket leaves the file behind; a named pipe
      // needs no cleanup. Unique names keep runs independent either way.
      if (process.platform !== "win32") {
        try {
          fs.rmSync(pipePath, { force: true });
        } catch {
          // Another process already removed it.
        }
      }
    },
  };
}

function makeClient(pipePath, extra = {}) {
  return new DiscordIpcClient({
    clientId: CLIENT_ID,
    source: "youtube",
    pipes: [pipePath],
    connectTimeoutMs: 1_000,
    replyTimeoutMs: 1_000,
    ...extra,
  });
}

/* ------------------------------------------------------------------ tests */

test("handshake reaches READY and SET_ACTIVITY is echoed by nonce", async (t) => {
  const mock = await startMockDiscord();
  const client = makeClient(mock.path);
  t.after(() => client.close());
  t.after(() => mock.close());

  const connected = await client.connect();
  assert.equal(connected.ok, true);
  assert.equal(connected.pipePath, mock.path);
  assert.equal(connected.user, "tester");
  assert.equal(client.ready, true);
  assert.equal(client.user, "tester");
  assert.equal(mock.state.handshakes, 1);
  assert.equal(mock.state.clientIds[0], CLIENT_ID);

  const activity = { type: 3, details: "Big Buck Bunny", state: "Blender" };
  const result = await client.setActivity(activity);
  assert.equal(result.ok, true);
  assert.equal(result.appName, "Discord Test");

  assert.equal(mock.state.frames.length, 1);
  assert.equal(mock.state.frames[0].cmd, "SET_ACTIVITY");
  assert.equal(mock.state.frames[0].args.pid, process.pid);
  assert.deepEqual(mock.state.frames[0].args.activity, activity);
  assert.equal(typeof mock.state.frames[0].nonce, "string");
});

test("probes the pipes in order and keeps the first READY", async (t) => {
  const mock = await startMockDiscord();
  const missing = nextPipePath();
  const client = makeClient(missing, { pipes: [missing, mock.path] });
  t.after(() => client.close());
  t.after(() => mock.close());

  const connected = await client.connect();
  assert.equal(connected.ok, true);
  assert.equal(connected.pipePath, mock.path);
  assert.equal(mock.state.connections, 1, "the missing pipe never reaches the server");
});

test("no answering pipe is returned as an absence, not thrown", async (t) => {
  const missing = nextPipePath();
  const client = makeClient(missing, { pipes: [missing], connectTimeoutMs: 200 });
  t.after(() => client.close());

  const connected = await client.connect();
  assert.equal(connected.ok, false);
  assert.equal(connected.error, "discord-unavailable");
  assert.equal(connected.fatal, undefined);
  assert.match(connected.detail, /ENOENT|no Discord IPC pipe answered/i);
  assert.equal(client.ready, false);
});

test("a silent handshake times out and is destroyed, not left open", async (t) => {
  const mock = await startMockDiscord({ silent: true });
  const client = makeClient(mock.path, { replyTimeoutMs: 100 });
  t.after(() => client.close());
  t.after(() => mock.close());

  const connected = await client.connect();
  assert.equal(connected.ok, false);
  assert.equal(connected.error, "discord-unavailable");
  assert.match(connected.detail, /handshake timed out/i);
  await waitFor(() => mock.state.sockets.every((socket) => socket.destroyed), "socket teardown");
});

test("a CLOSE during the handshake is a fatal rejection, not an absence", async (t) => {
  const mock = await startMockDiscord({ closeHandshake: true });
  const client = makeClient(mock.path);
  t.after(() => client.close());
  t.after(() => mock.close());

  const connected = await client.connect();
  assert.equal(connected.ok, false);
  assert.equal(connected.error, "discord-rejected");
  assert.equal(connected.fatal, true);
  assert.match(connected.detail, /Invalid Client ID/);
});

test("a SET_ACTIVITY ERROR is surfaced by message, not swallowed", async (t) => {
  const mock = await startMockDiscord({ mode: "error" });
  const client = makeClient(mock.path);
  t.after(() => client.close());
  t.after(() => mock.close());

  await client.connect();
  const result = await client.setActivity({ type: 3, details: "Episode 2" });

  assert.equal(result.ok, false);
  assert.equal(result.error, "Invalid activity for this client");
});

test("a hung reply is reported as hung", async (t) => {
  const mock = await startMockDiscord({ muteActivity: true });
  const client = makeClient(mock.path, { replyTimeoutMs: 100 });
  t.after(() => client.close());
  t.after(() => mock.close());

  await client.connect();
  const result = await client.setActivity({ type: 3, details: "Episode 3" });

  assert.equal(result.ok, false);
  assert.equal(result.error, "hung");
});

test("an unexpected pipe close reports discord-closed and fails pending sends", async (t) => {
  const mock = await startMockDiscord({ muteActivity: true });
  const closes = [];
  const client = makeClient(mock.path, { onClose: (info) => closes.push(info) });
  t.after(() => client.close());
  t.after(() => mock.close());

  await client.connect();
  const pending = client.setActivity({ type: 3, details: "Episode 4" });
  await waitFor(() => mock.state.frames.length === 1, "SET_ACTIVITY on the wire");
  mock.drop();

  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error, "discord-closed");
  await waitFor(() => client.ready === false, "ready to go false");
  assert.deepEqual(closes, [{ reason: "discord-closed" }]);
});

test("close() fails pending work and never reports itself as a drop", async (t) => {
  const mock = await startMockDiscord({ muteActivity: true });
  const closes = [];
  const client = makeClient(mock.path, { onClose: (info) => closes.push(info) });
  t.after(() => mock.close());

  await client.connect();
  const pending = client.setActivity({ type: 3, details: "Episode 5" });
  await waitFor(() => mock.state.frames.length === 1, "SET_ACTIVITY on the wire");
  client.close();

  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error, "discord-closed");
  assert.deepEqual(closes, []);
  assert.equal((await client.setActivity(null)).error, "discord-closed");
});

test("PING is answered with PONG on the same pipe", async (t) => {
  const mock = await startMockDiscord({ ping: true });
  const client = makeClient(mock.path);
  t.after(() => client.close());
  t.after(() => mock.close());

  await client.connect();
  await waitFor(() => mock.state.pongs === 1, "PONG");
  assert.equal(mock.state.pongs, 1);
});

test("the rate guard holds the window and coalesces to the newest activity", async (t) => {
  const clock = makeClock();
  const mock = await startMockDiscord();
  const client = makeClient(mock.path, { timers: clock, rateLimit: 2, rateWindowMs: 20_000 });
  t.after(() => client.close());
  t.after(() => mock.close());

  await client.connect();
  const one = await client.setActivity({ type: 3, details: "one" });
  const two = await client.setActivity({ type: 3, details: "two" });
  const three = await client.setActivity({ type: 3, details: "three" });
  const four = await client.setActivity({ type: 3, details: "four" });

  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  assert.equal(three.queued, true);
  assert.equal(four.queued, true);
  assert.equal(mock.state.frames.length, 2, "nothing above the budget reaches Discord");

  clock.advance(20_001);
  await waitFor(() => mock.state.frames.length === 3, "the coalesced frame");
  assert.deepEqual(
    mock.state.frames.map((frame) => frame.args?.activity?.details),
    ["one", "two", "four"],
  );
});

test("a null clear bypasses the rate window", async (t) => {
  const clock = makeClock();
  const mock = await startMockDiscord();
  const client = makeClient(mock.path, { timers: clock, rateLimit: 1, rateWindowMs: 20_000 });
  t.after(() => client.close());
  t.after(() => mock.close());

  await client.connect();
  await client.setActivity({ type: 3, details: "one" });
  const queued = await client.setActivity({ type: 3, details: "two" });
  assert.equal(queued.queued, true);

  const cleared = await client.setActivity(null);
  assert.equal(cleared.ok, true);
  assert.equal(cleared.queued, undefined);
  assert.equal(mock.state.frames.at(-1).args.activity, null);
});

test("every SET_ACTIVITY carries a distinct nonce", async (t) => {
  const mock = await startMockDiscord();
  const client = makeClient(mock.path);
  t.after(() => client.close());
  t.after(() => mock.close());

  await client.connect();
  await client.setActivity({ type: 3, details: "x" });
  await client.setActivity({ type: 3, details: "y" });

  const nonces = mock.state.frames.map((frame) => frame.nonce);
  assert.equal(nonces.length, 2);
  assert.notEqual(nonces[0], nonces[1]);
});

test("discord frames reassemble at every byte boundary and refuse an oversized length", () => {
  const frame = encodeDiscordFrame(OP.FRAME, { cmd: "SET_ACTIVITY", nonce: "n1" });
  for (let split = 0; split <= frame.length; split += 1) {
    const decoder = new DiscordFrameDecoder();
    const frames = [
      ...decoder.push(frame.subarray(0, split)),
      ...decoder.push(frame.subarray(split)),
    ];
    assert.equal(frames.length, 1, `split at ${split}`);
    assert.equal(frames[0].op, OP.FRAME);
    assert.equal(frames[0].payload.nonce, "n1");
  }

  const corrupt = Buffer.alloc(8);
  corrupt.writeUInt32LE(OP.FRAME, 0);
  corrupt.writeUInt32LE(MAX_DISCORD_FRAME + 1, 4);
  assert.throws(() => new DiscordFrameDecoder().push(corrupt), /exceeds/);
});
