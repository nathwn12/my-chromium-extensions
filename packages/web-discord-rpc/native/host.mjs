#!/usr/bin/env node
/**
 * Chrome native-messaging host for Web Discord RPC.
 *
 * One arRPC connection per source, created on the first activity. The host
 * keeps the last activity per source and resends it after a reconnect, acks
 * every activity by its id, and never lets an absent arRPC end the native
 * loop: no server means `status waiting`, not a crash.
 *
 *   node native/host.mjs           (stdio protocol; started by Chrome)
 *   node native/host.mjs --selftest
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_CLIENT_ID, SOURCE_META, resolveClientId } from "../config.js";
import { ARRPC_USER_ID, ArRpcClient } from "./arrpc.mjs";
import { MAX_FRAME_BYTES, createDecoder, encodeMessage } from "./native-framing.mjs";

export const HOST_TRANSPORT = "arrpc";
export const HOST_VERSION = 1;

const DEFAULT_RECONNECT_MS = 1000;
const DEFAULT_MAX_RECONNECT_MS = 30_000;

function stderrLogger() {
  const write = (args) => process.stderr.write(`[web-discord-rpc] ${args.join(" ")}\n`);
  return { info: (...args) => write(args), warn: (...args) => write(args), error: (...args) => write(args) };
}

/**
 * Build the protocol state machine. All I/O and clocks are injected so the
 * host can be driven without a Chrome pipe, a real socket, or a real timer.
 */
export function createHost({
  send = () => {},
  createClient = (options) => new ArRpcClient(options),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  logger = null,
  reconnectDelayMs = DEFAULT_RECONNECT_MS,
  maxReconnectDelayMs = DEFAULT_MAX_RECONNECT_MS,
  clientOptions = {},
  clientId = DEFAULT_CLIENT_ID,
} = {}) {
  let closed = false;
  let currentClientId = clientId;
  const sources = new Map();

  for (const source of Object.keys(SOURCE_META)) {
    sources.set(source, {
      client: null,
      lastActivity: undefined,
      state: "idle",
      queue: Promise.resolve(),
      reconnectTimer: null,
      reconnectDelay: reconnectDelayMs,
    });
  }

  function safeSend(message) {
    try {
      send(message);
    } catch (error) {
      logger?.error?.(`send failed: ${error?.message ?? error}`);
    }
  }

  function snapshot() {
    return Object.fromEntries([...sources].map(([source, entry]) => [source, entry.state]));
  }

  function overallState() {
    const states = [...sources.values()].map((entry) => entry.state);
    if (states.includes("error")) return "error";
    if (states.includes("connected")) return "connected";
    return "waiting";
  }

  function publish(reason = null, detail = null, state = overallState()) {
    safeSend({
      t: "status",
      state,
      transport: HOST_TRANSPORT,
      reason,
      detail,
      sources: snapshot(),
    });
  }

  function ack(source, id, ok, error) {
    if (closed) return;
    safeSend(ok
      ? { t: "ack", source, id, ok: true }
      : { t: "ack", source, id, ok: false, error });
  }

  function clearReconnect(entry) {
    if (entry.reconnectTimer !== null) {
      clearTimeoutImpl(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
  }

  function scheduleReconnect(source, entry, delay = entry.reconnectDelay) {
    if (closed || entry.reconnectTimer !== null) return;
    if (entry.lastActivity === undefined || entry.lastActivity === null) return;

    const timer = setTimeoutImpl(() => {
      entry.reconnectTimer = null;
      entry.reconnectDelay = Math.min(entry.reconnectDelay * 2, maxReconnectDelayMs);
      entry.queue = entry.queue.then(() => reconnect(source, entry));
    }, delay);
    timer?.unref?.();
    entry.reconnectTimer = timer;
  }

  async function connectSource(source, entry) {
    if (entry.client?.ready) return true;

    if (!entry.client) {
      let client = null;
      client = createClient({
        ...clientOptions,
        clientId: currentClientId,
        source,
        logger,
        onClose: (info) => onClientClose(source, entry, client, info),
      });
      entry.client = client;
    }

    const result = await entry.client.connect();
    if (closed) return false;

    if (!result.ok) {
      entry.state = "waiting";
      publish("host-missing", result.detail ?? null);
      return false;
    }

    entry.state = "connected";
    entry.reconnectDelay = reconnectDelayMs;
    clearReconnect(entry);
    publish("connected");
    return true;
  }

  function onClientClose(source, entry, client, info) {
    if (closed || entry.client !== client) return;
    entry.state = "waiting";
    publish("arrpc-closed", info?.reason ?? null);
    scheduleReconnect(source, entry);
  }

  function handleFailure(source, entry, error) {
    const text = typeof error === "string" && error.length > 0 ? error : "rejected";

    if (text === "hung") {
      entry.state = "error";
      publish("hung", "SET_ACTIVITY reply timed out");
      entry.client?.close();
      entry.client = null;
      scheduleReconnect(source, entry);
      return;
    }
    if (text === "arrpc-closed" || text === "arrpc-unavailable") {
      entry.state = "waiting";
      publish(text === "arrpc-closed" ? "arrpc-closed" : "host-missing", text);
      scheduleReconnect(source, entry);
      return;
    }
    entry.state = "error";
    publish("rejected", text);
  }

  async function deliver(source, entry, activity, id) {
    try {
      if (closed) return;
      if (!(await connectSource(source, entry))) {
        ack(source, id, false, "arrpc-unavailable");
        scheduleReconnect(source, entry);
        return;
      }
      const result = await entry.client.setActivity(activity);
      if (closed) return;

      if (result.ok) {
        entry.state = "connected";
        ack(source, id, true);
        return;
      }
      ack(source, id, false, result.error);
      handleFailure(source, entry, result.error);
    } catch (error) {
      logger?.error?.(`activity for ${source} failed: ${error?.message ?? error}`);
      entry.state = "error";
      publish("rejected", String(error?.message ?? error));
      ack(source, id, false, "host-error");
      scheduleReconnect(source, entry);
    }
  }

  async function reconnect(source, entry) {
    try {
      if (closed || entry.client?.ready) return;
      if (!(await connectSource(source, entry))) {
        scheduleReconnect(source, entry);
        return;
      }
      if (entry.lastActivity === null || entry.lastActivity === undefined) return;

      const result = await entry.client.setActivity(entry.lastActivity);
      if (!closed && !result.ok) handleFailure(source, entry, result.error);
    } catch (error) {
      logger?.error?.(`reconnect for ${source} failed: ${error?.message ?? error}`);
      entry.state = "error";
      publish("rejected", String(error?.message ?? error));
      scheduleReconnect(source, entry);
    }
  }

  function handleHello(message) {
    const raw = typeof message.clientId === "string" ? message.clientId.trim() : "";
    const resolved = resolveClientId(raw);
    if (raw.length === 0 || resolved !== raw) {
      publish("rejected", "invalid client id", "error");
      return;
    }
    if (message.version !== HOST_VERSION) {
      publish("rejected", `unsupported protocol version ${String(message.version)}`, "error");
      return;
    }
    if (message.transport !== undefined && message.transport !== HOST_TRANSPORT) {
      publish("rejected", `unsupported transport ${String(message.transport)}`, "error");
      return;
    }
    if (resolved === currentClientId) return;

    currentClientId = resolved;
    for (const [source, entry] of sources) {
      entry.client?.close();
      entry.client = null;
      entry.reconnectDelay = reconnectDelayMs;
      if (entry.lastActivity !== undefined && entry.lastActivity !== null) {
        scheduleReconnect(source, entry, 0);
      } else if (entry.state !== "idle") {
        entry.state = "waiting";
      }
    }
  }

  function handleActivity(message) {
    const source = typeof message.source === "string" ? message.source : "";
    const id = typeof message.id === "string" ? message.id : "";
    const entry = sources.get(source);
    if (!entry) {
      ack(source, id, false, "unknown-source");
      return Promise.resolve();
    }

    const activity = message.activity ?? null;
    if (activity !== null && (typeof activity !== "object" || Array.isArray(activity))) {
      ack(source, id, false, "invalid-activity");
      return Promise.resolve();
    }

    entry.lastActivity = activity;
    entry.queue = entry.queue.then(() => deliver(source, entry, activity, id));
    return entry.queue;
  }

  function handle(message) {
    if (closed) return Promise.resolve();
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return Promise.resolve();
    }

    try {
      switch (message.t) {
        case "hello":
          handleHello(message);
          return Promise.resolve();
        case "activity":
          return handleActivity(message);
        case "ping":
          safeSend({ t: "pong" });
          return Promise.resolve();
        default:
          return Promise.resolve();
      }
    } catch (error) {
      logger?.error?.(`message ${String(message.t)} failed: ${error?.message ?? error}`);
      return Promise.resolve();
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const entry of sources.values()) {
      clearReconnect(entry);
      entry.client?.close();
      entry.client = null;
    }
  }

  return { handle, close };
}

/* ------------------------------------------------------------------ selftest */

async function runSelftest() {
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
      source: "youtube",
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
      source: "youtube",
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
      source: "youtube",
      id: "act-1",
      activity: { details: "Big Buck Bunny" },
    });

    const ackFrame = frames.find((message) => message.t === "ack");
    assert.equal(ackFrame.ok, true);
    assert.equal(ackFrame.id, "act-1");
    assert.equal(clients[0].options.clientId, DEFAULT_CLIENT_ID);
    assert.equal(clients[0].options.source, "youtube");
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
      source: "youtube",
      id: "act-2",
      activity: { details: "queued" },
    });

    const failedAck = frames.find((message) => message.t === "ack");
    assert.equal(failedAck.ok, false);
    assert.equal(failedAck.error, "arrpc-unavailable");

    const waiting = frames.find((message) => message.t === "status" && message.state === "waiting");
    assert.equal(waiting.reason, "host-missing");
    assert.equal(waiting.sources.youtube, "waiting");
    assert.equal(pending.size, 1);

    scenario.failConnect = false;
    const [fire] = [...pending.values()];
    pending.clear();
    fire();
    await new Promise((resolve) => setImmediate(resolve));

    const connected = frames.find(
      (message) => message.t === "status" && message.state === "connected",
    );
    assert.equal(connected.sources.youtube, "connected");
    assert.deepEqual(clients[0].sent.at(-1), { details: "queued" });
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

/* ----------------------------------------------------------------------- cli */

async function main(argv) {
  if (argv.includes("--selftest")) return runSelftest();
  if (argv.length > 0) {
    process.stderr.write(`unknown argument: ${argv[0]}\n`);
    return 2;
  }

  const host = createHost({
    send: (message) => {
      try {
        process.stdout.write(encodeMessage(message));
      } catch (error) {
        process.stderr.write(`[web-discord-rpc] cannot send: ${error?.message ?? error}\n`);
      }
    },
    logger: stderrLogger(),
  });
  const decoder = createDecoder();

  process.stdin.on("data", (chunk) => {
    let messages;
    try {
      messages = decoder.push(chunk);
    } catch (error) {
      process.stderr.write(`[web-discord-rpc] framing error: ${error?.message ?? error}\n`);
      process.exitCode = 1;
      host.close();
      process.stdin.destroy();
      return;
    }
    for (const message of messages) {
      host.handle(message).catch((error) => {
        process.stderr.write(`[web-discord-rpc] unhandled: ${error?.message ?? error}\n`);
      });
    }
  });
  process.stdin.on("end", () => host.close());
  process.stdin.on("error", () => host.close());
  return null;
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      if (typeof code === "number") process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`[web-discord-rpc] fatal: ${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
