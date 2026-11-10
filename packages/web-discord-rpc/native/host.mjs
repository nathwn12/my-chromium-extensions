#!/usr/bin/env node
/**
 * Chrome native-messaging host for YouTube Presence.
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
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_CLIENT_ID, SOURCE_META, resolveClientId } from "../config.js";
import { ARRPC_USER_ID, ArRpcClient } from "./arrpc.mjs";
import { DiscordFrameDecoder, DiscordIpcClient, OP, encodeDiscordFrame } from "./ipc.mjs";
import { MAX_FRAME_BYTES, createDecoder, encodeMessage } from "./native-framing.mjs";

export const HOST_VERSION = 1;
export const TRANSPORTS = Object.freeze({ AUTO: "auto", IPC: "ipc", ARRPC: "arrpc" });

const TRANSPORT = Object.freeze({ IPC: "discord-ipc", ARRPC: "arrpc", MIXED: "mixed" });
const PREFERENCES = new Set(Object.values(TRANSPORTS));

const DEFAULT_RECONNECT_MS = 1000;
const DEFAULT_MAX_RECONNECT_MS = 30_000;

function stderrLogger() {
  const write = (args) => process.stderr.write(`[web-discord-rpc] ${args.join(" ")}\n`);
  return { info: (...args) => write(args), warn: (...args) => write(args), error: (...args) => write(args) };
}

/**
 * Test-only transport overrides, so an integration run never probes a real
 * Discord or arRPC listener.
 *
 *   WDR_ARRPC_PORTS    comma-separated ports for the arRPC probe
 *   WDR_DISCORD_PIPES  semicolon-separated pipe/socket paths for the IPC probe
 *
 * Unset or empty means the production defaults inside each client, untouched.
 * Invalid entries are ignored rather than thrown: a typo must not silence the
 * host that the extension is waiting on.
 */
export function transportOverridesFromEnv(env = process.env) {
  const ports = (typeof env?.WDR_ARRPC_PORTS === "string" ? env.WDR_ARRPC_PORTS : "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0 && value < 65_536);
  const pipes = (typeof env?.WDR_DISCORD_PIPES === "string" ? env.WDR_DISCORD_PIPES : "")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return {
    clientOptions: ports.length > 0 ? { ports } : {},
    ipcOptions: pipes.length > 0 ? { pipes } : {},
  };
}

/**
 * Build the protocol state machine. All I/O and clocks are injected so the
 * host can be driven without a Chrome pipe, a real socket, or a real timer.
 */
export function createHost({
  send = () => {},
  createClient = (options) => new ArRpcClient(options),
  createIpcClient = (options) => new DiscordIpcClient(options),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  logger = null,
  reconnectDelayMs = DEFAULT_RECONNECT_MS,
  maxReconnectDelayMs = DEFAULT_MAX_RECONNECT_MS,
  clientOptions = {},
  ipcOptions = {},
  clientId = DEFAULT_CLIENT_ID,
} = {}) {
  let closed = false;
  let currentClientId = clientId;
  /** What the last hello asked for; null until a hello arrives. */
  let preference = null;
  /** The first transport that actually connected, reused for the other source. */
  let preferred = null;
  const sources = new Map();

  for (const source of Object.keys(SOURCE_META)) {
    sources.set(source, {
      client: null,
      clientTransport: null,
      transport: null,
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
      transport: currentTransport(),
      reason,
      detail,
      sources: snapshot(),
    });
  }

  /**
   * What the status frame reports: one transport while every connected source
   * agrees, `mixed` when they do not. With nothing connected, the remembered
   * preference wins, then the primary leg of the requested preference. Before
   * any hello the host is on the legacy arRPC path.
   */
  function currentTransport() {
    const live = new Set();
    for (const entry of sources.values()) {
      if (entry.state === "connected" && entry.transport) live.add(entry.transport);
    }
    if (live.size > 1) return TRANSPORT.MIXED;
    if (live.size === 1) return [...live][0];
    if (preferred) return preferred;
    if (preference === null || preference === TRANSPORTS.ARRPC) return TRANSPORT.ARRPC;
    return TRANSPORT.IPC;
  }

  /** Transports to try for one source, in order. Forced preferences never fall back. */
  function transportPlan() {
    if (preference === null || preference === TRANSPORTS.ARRPC) return [TRANSPORT.ARRPC];
    if (preference === TRANSPORTS.IPC) return [TRANSPORT.IPC];
    return preferred === TRANSPORT.ARRPC
      ? [TRANSPORT.ARRPC, TRANSPORT.IPC]
      : [TRANSPORT.IPC, TRANSPORT.ARRPC];
  }

  function buildClient(source, entry, transport) {
    if (entry.client && entry.clientTransport === transport) return entry.client;
    entry.client?.close();
    entry.client = null;
    entry.clientTransport = transport;

    let client = null;
    const options = {
      clientId: currentClientId,
      source,
      logger,
      onClose: (info) => onClientClose(source, entry, client, info),
    };
    client = transport === TRANSPORT.ARRPC
      ? createClient({ ...clientOptions, ...options })
      : createIpcClient({ ...ipcOptions, ...options });
    entry.client = client;
    return client;
  }

  function connectFailure(transport, result) {
    const detail = result?.detail ?? null;
    if (result?.fatal === true) {
      return { error: "rejected", reason: "rejected", detail, fatal: true };
    }
    if (transport === TRANSPORT.ARRPC) {
      // An absent arRPC is a closed transport, never a missing native host:
      // `host-missing` is Chrome failing to launch this process.
      return { error: "arrpc-unavailable", reason: "arrpc-closed", detail, fatal: false };
    }
    return { error: "transport-unavailable", reason: "discord-closed", detail, fatal: false };
  }

  /**
   * Attach the source to its first working transport, or report the absence of
   * the primary one. Under `auto` the first success becomes the preference for
   * the other source; a forced preference is tried alone.
   */
  async function connectSource(source, entry) {
    if (closed) {
      return { ok: false, error: "discord-closed", reason: "discord-closed", detail: "host closed" };
    }
    if (entry.client?.ready) return { ok: true };

    let primary = null;
    const plan = transportPlan();

    for (const transport of plan) {
      const client = buildClient(source, entry, transport);
      entry.transport = transport;
      const result = await client.connect();
      if (closed) {
        return { ok: false, error: "discord-closed", reason: "discord-closed", detail: "host closed" };
      }

      if (result?.ok) {
        entry.state = "connected";
        entry.transport = transport;
        entry.reconnectDelay = reconnectDelayMs;
        preferred ??= transport;
        clearReconnect(entry);
        publish(null);
        return { ok: true };
      }

      const failure = connectFailure(transport, result);
      primary ??= failure;

      if (failure.fatal) {
        entry.state = "error";
        publish("rejected", failure.detail);
        return { ok: false, ...failure };
      }
    }

    entry.state = "waiting";
    return { ok: false, ...(primary ?? connectFailure(TRANSPORT.ARRPC, null)) };
  }

  function reportConnectFailure(source, entry, connect) {
    if (closed || connect.fatal) return;
    publish(connect.reason, connect.detail ?? null);
    scheduleReconnect(source, entry);
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

  function onClientClose(source, entry, client, info) {
    if (closed || entry.client !== client) return;
    entry.state = "waiting";
    publish(entry.clientTransport === TRANSPORT.IPC ? "discord-closed" : "arrpc-closed", info?.reason ?? null);
    scheduleReconnect(source, entry);
  }

  function handleFailure(source, entry, error) {
    const text = typeof error === "string" && error.length > 0 ? error : "rejected";

    if (text === "hung") {
      entry.state = "error";
      publish("hung", "SET_ACTIVITY reply timed out");
      entry.client?.close();
      entry.client = null;
      entry.clientTransport = null;
      scheduleReconnect(source, entry);
      return;
    }
    if (text === "arrpc-closed" || text === "arrpc-unavailable"
      || text === "discord-closed" || text === "discord-unavailable") {
      entry.state = "waiting";
      publish(closeReason(text), text);
      scheduleReconnect(source, entry);
      return;
    }
    entry.state = "error";
    publish("rejected", text);
  }

  /** A transport that went away or never answered is waiting, not an error. */
  function closeReason(text) {
    return text.startsWith("discord") ? "discord-closed" : "arrpc-closed";
  }

  async function deliver(source, entry, activity, id) {
    try {
      if (closed) return;
      const connect = await connectSource(source, entry);
      if (closed) return;
      if (!connect.ok) {
        ack(source, id, false, connect.error);
        reportConnectFailure(source, entry, connect);
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
      const connect = await connectSource(source, entry);
      if (closed) return;
      if (!connect.ok) {
        reportConnectFailure(source, entry, connect);
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
    const transport = message.transport === undefined ? TRANSPORTS.AUTO : message.transport;
    if (!PREFERENCES.has(transport)) {
      publish("rejected", `unsupported transport ${String(message.transport)}`, "error");
      return;
    }
    if (resolved === currentClientId && transport === preference) return;

    currentClientId = resolved;
    preference = transport;
    preferred = null;
    for (const [source, entry] of sources) {
      entry.client?.close();
      entry.client = null;
      entry.clientTransport = null;
      entry.transport = null;
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
      entry.clientTransport = null;
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
    assert.equal(waiting.reason, "arrpc-closed");
    assert.equal(waiting.detail, "absent");
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

  /* -------------------------------------------------- discord ipc transport */

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
      source: "youtube",
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

  await check("host auto prefers discord ipc and stacks two sources on two pipes", async () => {
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
      source: "youtube",
      id: "ipc-a",
      activity: { details: "Big Buck Bunny" },
    });
    await host.handle({
      t: "activity",
      source: "youtube-music",
      id: "ipc-b",
      activity: { details: "Album Track" },
    });

    const acks = frames.filter((message) => message.t === "ack");
    assert.deepEqual(acks.map((message) => [message.id, message.ok]), [["ipc-a", true], ["ipc-b", true]]);
    assert.equal(discord.state.connections, 2);
    assert.equal(discord.state.handshakes, 2);
    assert.deepEqual(
      discord.state.frames.map((frame) => frame.args.activity.details),
      ["Big Buck Bunny", "Album Track"],
    );
    assert.deepEqual(arrpcBuilt, []);

    const connected = frames.filter((message) => message.t === "status" && message.state === "connected").at(-1);
    assert.equal(connected.transport, "discord-ipc");
    assert.equal(connected.sources.youtube, "connected");
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
      source: "youtube",
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
      source: "youtube",
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

/* ----------------------------------------------------------------------- cli */

/**
 * Chrome starts the host with the caller's origin and, on Windows, its parent
 * window handle: `host.mjs chrome-extension://<id>/ --parent-window=<n>`.
 * Those are expected launcher arguments, not a usage error.
 */
const CHROME_ARGUMENTS = ["chrome-extension://", "--parent-window="];

const isChromeArgument = (argument) =>
  CHROME_ARGUMENTS.some((prefix) => argument.startsWith(prefix));

async function main(argv) {
  if (argv.includes("--selftest")) return runSelftest();

  const unknown = argv.find((argument) => !isChromeArgument(argument));
  if (unknown !== undefined) {
    process.stderr.write(`unknown argument: ${unknown}\n`);
    return 2;
  }

  const overrides = transportOverridesFromEnv(process.env);
  const host = createHost({
    send: (message) => {
      try {
        process.stdout.write(encodeMessage(message));
      } catch (error) {
        process.stderr.write(`[web-discord-rpc] cannot send: ${error?.message ?? error}\n`);
      }
    },
    logger: stderrLogger(),
    clientOptions: overrides.clientOptions,
    ipcOptions: overrides.ipcOptions,
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
