/**
 * Presence Suite selftest: in-memory Discord simulators and protocol checks.
 * Loaded by host.mjs only for `--selftest`, so a normal spawn skips this code.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { DEFAULT_CLIENT_ID } from "../config.js";
import { ARRPC_USER_ID, ArRpcClient } from "./arrpc.mjs";
import { DiscordFrameDecoder, DiscordIpcClient, OP, encodeDiscordFrame } from "./ipc.mjs";
import { MAX_FRAME_BYTES, createDecoder, encodeMessage } from "./native-framing.mjs";
import { createHost } from "./host.mjs";

export async function runSelftest() {
  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (error) {
      results.push({ name, ok: false, detail: error?.message ?? String(error) });
    }
  };

  const readyFrame = (user) => ({
    cmd: "DISPATCH",
    data: { v: 1, config: { environment: "production" }, user },
    evt: "READY",
    nonce: null,
  });

  class SelftestSocket {
    static handler = null;
    static instances = [];

    constructor(...args) {
      this.url = args[0];
      this.argumentCount = args.length;
      this.port = Number(new URL(this.url).port);
      this.listeners = new Map();
      this.sent = [];
      this.closed = false;
      SelftestSocket.instances.push(this);
      queueMicrotask(() => {
        if (!this.closed) SelftestSocket.handler?.(this, null);
      });
    }

    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }

    removeEventListener(type, fn) {
      this.listeners.get(type)?.delete(fn);
    }

    emit(type, event) {
      for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
    }

    send(text) {
      const frame = JSON.parse(text);
      this.sent.push(frame);
      SelftestSocket.handler?.(this, frame);
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      queueMicrotask(() => this.emit("close", { code: 1000, wasClean: true }));
    }

    receive(frame) {
      this.emit("message", { data: JSON.stringify(frame) });
    }
  }

  await check("framing reassembles a frame split mid-prefix and mid-body", () => {
    const frame = encodeMessage({ t: "hello", clientId: DEFAULT_CLIENT_ID });
    const decoder = createDecoder();
    assert.deepEqual(decoder.push(frame.subarray(0, 2)), []);
    assert.deepEqual(decoder.push(frame.subarray(2, 9)), []);
    assert.deepEqual(decoder.push(frame.subarray(9)), [
      { t: "hello", clientId: DEFAULT_CLIENT_ID },
    ]);
    assert.throws(
      () => encodeMessage({ blob: "x".repeat(MAX_FRAME_BYTES) }),
      /exceeds/,
    );
  });

  await check("client accepts arRPC READY and acks SET_ACTIVITY by nonce", async () => {
    SelftestSocket.instances = [];
    SelftestSocket.handler = (socket, frame) => {
      if (frame === null) {
        socket.receive(readyFrame({ id: ARRPC_USER_ID, username: "arrpc" }));
        return;
      }
      if (frame.cmd === "SET_ACTIVITY") {
        socket.receive({ cmd: "SET_ACTIVITY", data: {}, evt: null, nonce: frame.nonce });
      }
    };

    const client = new ArRpcClient({
      clientId: DEFAULT_CLIENT_ID,
      source: "youtube-music",
      WebSocketImpl: SelftestSocket,
      ports: [6463],
      connectTimeoutMs: 200,
      replyTimeoutMs: 200,
    });

    const connected = await client.connect();
    assert.equal(connected.ok, true);
    assert.equal(connected.port, 6463);
    assert.equal(client.ready, true);

    const result = await client.setActivity({ details: "Big Buck Bunny" });
    assert.equal(result.ok, true);
    const sent = SelftestSocket.instances[0].sent[0];
    assert.equal(sent.cmd, "SET_ACTIVITY");
    assert.equal(sent.args.pid, process.pid);
    assert.equal(sent.args.activity.details, "Big Buck Bunny");
    client.close();
    assert.equal(client.ready, false);
  });

  await check("client rejects a non-arRPC READY and tries the next port", async () => {
    SelftestSocket.instances = [];
    SelftestSocket.handler = (socket, frame) => {
      if (frame !== null) return;
      socket.receive(readyFrame(socket.port === 6463
        ? { id: "999999999999999999", username: "discord" }
        : { id: ARRPC_USER_ID, username: "arrpc" }));
    };

    const client = new ArRpcClient({
      clientId: DEFAULT_CLIENT_ID,
      source: "youtube-music",
      WebSocketImpl: SelftestSocket,
      ports: [6463, 6464],
      connectTimeoutMs: 200,
      replyTimeoutMs: 200,
    });

    const connected = await client.connect();
    assert.equal(connected.ok, true);
    assert.equal(connected.port, 6464);
    assert.equal(SelftestSocket.instances[0].closed, true);
    client.close();
  });

  const scenario = { failConnect: false };
  const clients = [];
  const createFakeClient = (options) => {
    const client = {
      options,
      ready: false,
      port: null,
      sent: [],
      async connect() {
        if (scenario.failConnect) {
          return { ok: false, reason: "arrpc-unavailable", detail: "absent" };
        }
        this.ready = true;
        this.port = 6463;
        return { ok: true, port: 6463, user: { id: ARRPC_USER_ID, username: "arrpc" } };
      },
      async setActivity(activity) {
        this.sent.push(activity);
        return { ok: true };
      },
      close() {
        this.ready = false;
      },
    };
    clients.push(client);
    return client;
  };

  await check("host acks an activity after one SET_ACTIVITY", async () => {
    scenario.failConnect = false;
    clients.length = 0;
    const frames = [];
    const host = createHost({ send: (message) => frames.push(message), createClient: createFakeClient });

    await host.handle({
      t: "hello",
      clientId: DEFAULT_CLIENT_ID,
      version: 1,
      transport: "arrpc",
    });
    await host.handle({
      t: "activity",
      source: "youtube-music",
      id: "act-1",
      activity: { details: "Big Buck Bunny" },
    });

    const ackFrame = frames.find((message) => message.t === "ack");
    assert.equal(ackFrame.ok, true);
    assert.equal(ackFrame.id, "act-1");
    assert.equal(clients[0].options.clientId, DEFAULT_CLIENT_ID);
    assert.equal(clients[0].options.source, "youtube-music");
    assert.deepEqual(clients[0].sent, [{ details: "Big Buck Bunny" }]);
    host.close();
  });

  await check("host waits, then resends the last activity after a reconnect", async () => {
    scenario.failConnect = true;
    clients.length = 0;
    const frames = [];
    const pending = new Map();
    let nextId = 1;
    const timers = {
      set(fn) {
        const id = nextId++;
        pending.set(id, fn);
        return id;
      },
      clear(id) {
        pending.delete(id);
      },
    };

    const host = createHost({
      send: (message) => frames.push(message),
      createClient: createFakeClient,
      setTimeoutImpl: timers.set,
      clearTimeoutImpl: timers.clear,
    });

    await host.handle({
      t: "activity",
      source: "youtube-music",
      id: "act-2",
      activity: { details: "queued" },
    });

    const failedAck = frames.find((message) => message.t === "ack");
    assert.equal(failedAck.ok, false);
    assert.equal(failedAck.error, "arrpc-unavailable");

    const waiting = frames.find((message) => message.t === "status" && message.state === "waiting");
    assert.equal(waiting.reason, "arrpc-closed");
    assert.equal(waiting.detail, "absent");
    assert.equal(waiting.sources["youtube-music"], "waiting");
    assert.equal(pending.size, 1);

    scenario.failConnect = false;
    const [fire] = [...pending.values()];
    pending.clear();
    fire();
    await new Promise((resolve) => setImmediate(resolve));

    const connected = frames.find(
      (message) => message.t === "status" && message.state === "connected",
    );
    assert.equal(connected.sources["youtube-music"], "connected");
    assert.deepEqual(clients[0].sent.at(-1), { details: "queued" });
    host.close();
  });


  /**
   * An in-memory Discord: every connect() gets its own socket pair, answers
   * HANDSHAKE with READY, and echoes SET_ACTIVITY by nonce. Two connect() calls
   * therefore look exactly like two pipes with two socket ids.
   */
  function selftestDiscord() {
    const state = { connections: 0, handshakes: 0, clientIds: [], frames: [], pairs: [] };

    const pair = () => {
      const clientSocket = new EventEmitter();
      const serverSocket = new EventEmitter();
      clientSocket.destroyed = false;
      serverSocket.destroyed = false;
      clientSocket.write = (chunk) => {
        if (serverSocket.destroyed) return false;
        serverSocket.emit("data", Buffer.from(chunk));
        return true;
      };
      serverSocket.write = (chunk) => {
        if (clientSocket.destroyed) return false;
        clientSocket.emit("data", Buffer.from(chunk));
        return true;
      };
      clientSocket.destroy = () => {
        if (clientSocket.destroyed) return;
        clientSocket.destroyed = true;
        clientSocket.emit("close");
      };
      serverSocket.destroy = () => {
        if (serverSocket.destroyed) return;
        serverSocket.destroyed = true;
        serverSocket.emit("close");
      };

      const decoder = new DiscordFrameDecoder();
      serverSocket.on("data", (chunk) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.op === OP.HANDSHAKE) {
            state.handshakes += 1;
            state.clientIds.push(frame.payload?.client_id);
            serverSocket.write(encodeDiscordFrame(OP.FRAME, {
              cmd: "DISPATCH",
              evt: "READY",
              nonce: null,
              data: { v: 1, user: { id: "0", username: "selftest" } },
            }));
          } else if (frame.op === OP.FRAME) {
            state.frames.push(frame.payload);
            serverSocket.write(encodeDiscordFrame(OP.FRAME, {
              cmd: "SET_ACTIVITY",
              evt: null,
              nonce: frame.payload?.nonce,
              data: { name: "Discord Selftest", activity: frame.payload?.args?.activity ?? null },
            }));
          }
        }
      });

      state.connections += 1;
      state.pairs.push({ clientSocket, serverSocket });
      return {
        connect() {
          setImmediate(() => {
            if (!clientSocket.destroyed) clientSocket.emit("connect");
          });
          return clientSocket;
        },
        drop() {
          clientSocket.destroy();
          serverSocket.destroy();
        },
      };
    };

    return { state, connect: () => pair().connect(), dropAll: () => state.pairs.forEach((p) => { p.clientSocket.destroy(); p.serverSocket.destroy(); }) };
  }

  const ipcOptions = (discord) => ({
    pipes: ["selftest"],
    connectImpl: () => discord.connect(),
    connectTimeoutMs: 200,
    replyTimeoutMs: 200,
  });

  await check("discord ipc handshake acks SET_ACTIVITY and learns the app name", async () => {
    const discord = selftestDiscord();
    const client = new DiscordIpcClient({
      clientId: DEFAULT_CLIENT_ID,
      source: "youtube-music",
      ...ipcOptions(discord),
    });

    const connected = await client.connect();
    assert.equal(connected.ok, true);
    assert.equal(connected.pipePath, "selftest");
    assert.equal(client.user, "selftest");
    assert.equal(discord.state.handshakes, 1);
    assert.equal(discord.state.clientIds[0], DEFAULT_CLIENT_ID);

    const result = await client.setActivity({ details: "Big Buck Bunny" });
    assert.equal(result.ok, true);
    assert.equal(result.appName, "Discord Selftest");
    assert.equal(discord.state.frames[0].cmd, "SET_ACTIVITY");
    assert.equal(discord.state.frames[0].args.pid, process.pid);
    assert.deepEqual(discord.state.frames[0].args.activity, { details: "Big Buck Bunny" });

    client.close();
    assert.equal(client.ready, false);
  });

  await check("host auto prefers discord ipc for the Music source", async () => {
    const discord = selftestDiscord();
    const frames = [];
    const arrpcBuilt = [];
    const host = createHost({
      send: (message) => frames.push(message),
      ipcOptions: ipcOptions(discord),
      createClient: (options) => {
        arrpcBuilt.push(options.source);
        return new ArRpcClient({ ...options });
      },
    });

    await host.handle({
      t: "hello",
      clientId: DEFAULT_CLIENT_ID,
      version: 1,
      transport: "auto",
    });
    await host.handle({
      t: "activity",
      source: "youtube-music",
      id: "ipc-a",
      activity: { details: "Big Buck Bunny" },
    });
    const acks = frames.filter((message) => message.t === "ack");
    assert.deepEqual(acks.map((message) => [message.id, message.ok]), [["ipc-a", true]]);
    assert.equal(discord.state.connections, 1);
    assert.equal(discord.state.handshakes, 1);
    assert.deepEqual(
      discord.state.frames.map((frame) => frame.args.activity.details),
      ["Big Buck Bunny"],
    );
    assert.deepEqual(arrpcBuilt, []);

    const connected = frames.filter((message) => message.t === "status" && message.state === "connected").at(-1);
    assert.equal(connected.transport, "discord-ipc");
    assert.equal(connected.sources["youtube-music"], "connected");
    host.close();
    discord.dropAll();
  });

  await check("host auto falls back to arrpc when no discord pipe answers", async () => {
    const frames = [];
    const ipcClients = [];
    scenario.failConnect = false;
    clients.length = 0;
    const host = createHost({
      send: (message) => frames.push(message),
      createClient: createFakeClient,
      createIpcClient: (options) => {
        ipcClients.push({ source: options.source, closed: false });
        return {
          ready: false,
          async connect() {
            return { ok: false, error: "discord-unavailable", detail: "no Discord IPC pipe answered" };
          },
          async setActivity() {
            return { ok: true };
          },
          close() {
            ipcClients.at(-1).closed = true;
          },
        };
      },
    });

    await host.handle({
      t: "hello",
      clientId: DEFAULT_CLIENT_ID,
      version: 1,
      transport: "auto",
    });
    await host.handle({
      t: "activity",
      source: "youtube-music",
      id: "fallback-1",
      activity: { details: "Fallback" },
    });

    assert.equal(ipcClients.length, 1);
    assert.equal(ipcClients[0].closed, true);
    assert.equal(clients.length, 1, "arRPC is the fallback");
    assert.deepEqual(clients[0].sent, [{ details: "Fallback" }]);

    const ack = frames.find((message) => message.t === "ack");
    assert.equal(ack.ok, true);
    const connected = frames.filter((message) => message.t === "status" && message.state === "connected").at(-1);
    assert.equal(connected.transport, "arrpc");
    host.close();
  });

  await check("host forced ipc never falls back and acks transport-unavailable", async () => {
    const frames = [];
    let arrpcBuilt = 0;
    const host = createHost({
      send: (message) => frames.push(message),
      createClient: (options) => {
        arrpcBuilt += 1;
        return createFakeClient(options);
      },
      createIpcClient: () => ({
        ready: false,
        async connect() {
          return { ok: false, error: "discord-unavailable", detail: "no Discord IPC pipe answered" };
        },
        async setActivity() {
          return { ok: true };
        },
        close() {},
      }),
    });

    await host.handle({
      t: "hello",
      clientId: DEFAULT_CLIENT_ID,
      version: 1,
      transport: "ipc",
    });
    await host.handle({
      t: "activity",
      source: "youtube-music",
      id: "strict-ipc",
      activity: { details: "Absent" },
    });

    const ack = frames.find((message) => message.t === "ack");
    assert.equal(ack.ok, false);
    assert.equal(ack.error, "transport-unavailable");
    const waiting = frames.find((message) => message.t === "status" && message.state === "waiting");
    assert.equal(waiting.transport, "discord-ipc");
    assert.equal(waiting.reason, "discord-closed");
    assert.equal(arrpcBuilt, 0, "forced ipc never builds arRPC");
    host.close();
  });

  await check("a hello with an unknown transport is rejected", async () => {
    const frames = [];
    const host = createHost({ send: (message) => frames.push(message) });
    await host.handle({
      t: "hello",
      clientId: DEFAULT_CLIENT_ID,
      version: 1,
      transport: "gateway",
    });
    const status = frames.find((message) => message.t === "status");
    assert.equal(status.state, "error");
    assert.equal(status.reason, "rejected");
    assert.equal(status.detail, "unsupported transport gateway");
    host.close();
  });

  const failed = results.filter((result) => !result.ok).length;
  for (const result of results) {
    process.stdout.write(
      `${result.ok ? "PASS" : "FAIL"}  selftest: ${result.name}${result.ok ? "" : `  (${result.detail})`}\n`,
    );
  }
  process.stdout.write(`selftest: ${failed === 0 ? "PASS" : "FAIL"} (${results.length - failed}/${results.length})\n`);
  return failed === 0 ? 0 : 1;
}
