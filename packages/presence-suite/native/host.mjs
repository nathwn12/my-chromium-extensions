#!/usr/bin/env node
/**
 * Chrome native-messaging host for Presence Suite (YouTube Music + Crunchyroll).
 *
 * One Discord desktop IPC connection, opened on the first activity. The host
 * keeps the last activity and resends it after a reconnect unless its range
 * has already expired, acks every activity by its id, and never lets a missing
 * Discord pipe end the native loop: no client means `status waiting`, not a crash.
 *
 *   node native/host.mjs           (stdio protocol; started by Chrome)
 *   node native/host.mjs --selftest
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_CLIENT_ID, SOURCE_META, resolveClientId } from "../config.js";
import { ArRpcClient } from "./arrpc.mjs";
import { DiscordIpcClient } from "./ipc.mjs";
import { createDecoder, encodeMessage } from "./native-framing.mjs";

export const HOST_VERSION = 1;
export const TRANSPORTS = Object.freeze({ AUTO: "auto", IPC: "ipc", ARRPC: "arrpc" });

const TRANSPORT = Object.freeze({ IPC: "discord-ipc", ARRPC: "arrpc", MIXED: "mixed" });
const PREFERENCES = new Set(Object.values(TRANSPORTS));

const DEFAULT_RECONNECT_MS = 1000;
const DEFAULT_MAX_RECONNECT_MS = 5_000;
const RECONNECT_JITTER = 0.3;

function stderrLogger() {
  const write = (args) => process.stderr.write(`[presence-suite] ${args.join(" ")}\n`);
  return { info: (...args) => write(args), warn: (...args) => write(args), error: (...args) => write(args) };
}

/**
 * Test-only transport overrides, so an integration run never probes a real
 * Discord or arRPC listener.
 *
 *   PS_ARRPC_PORTS   comma-separated ports for the arRPC probe
 *   PS_DISCORD_PIPES semicolon-separated pipe/socket paths for the IPC probe
 *
 * Unset or empty means the production defaults inside each client, untouched.
 * Invalid entries are ignored rather than thrown: a typo must not silence the
 * host that the extension is waiting on.
 */
export function transportOverridesFromEnv(env = process.env) {
  const ports = (typeof env?.PS_ARRPC_PORTS === "string" ? env.PS_ARRPC_PORTS : "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0 && value < 65_536);
  const pipes = (typeof env?.PS_DISCORD_PIPES === "string" ? env.PS_DISCORD_PIPES : "")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return {
    clientOptions: ports.length > 0 ? { ports } : {},
    ipcOptions: pipes.length > 0 ? { pipes } : {},
  };
}

/**
 * Whether a remembered activity may be replayed after a reconnect. Only a
 * proven-expired range is withheld: Discord renders a finished {start,end}
 * pair as an elapsed-only card, a stale 0:00 counting up. A missing or junk
 * end is not proof of staleness, so it may be replayed. Ends below 1e12 are
 * seconds; larger ones are milliseconds.
 */
export function isReplayable(activity, now = Date.now()) {
  if (!activity || typeof activity !== "object" || Array.isArray(activity)) return true;
  const timestamps = activity.timestamps;
  if (!timestamps || typeof timestamps !== "object" || Array.isArray(timestamps)) return true;
  const raw = timestamps.end;
  if (typeof raw !== "number" && typeof raw !== "string") return true;
  if (typeof raw === "string" && !raw.trim()) return true;
  const end = Number(raw);
  const current = Number(now);
  if (!Number.isFinite(end) || !Number.isFinite(current)) return true;
  return (end < 1e12 ? end * 1000 : end) > current;
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
  randomImpl = Math.random,
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
      clientId: SOURCE_META[source].clientId,
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
   * any hello the host reports the arRPC leg it would try first.
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
      clientId: entry.clientId ?? currentClientId,
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

    // Jitter keeps several hosts from retrying in lockstep after a restart.
    const jitter = 1 + (randomImpl() * 2 - 1) * RECONNECT_JITTER;
    const wait = Math.min(Math.round(delay * jitter), maxReconnectDelayMs);
    const timer = setTimeoutImpl(() => {
      entry.reconnectTimer = null;
      entry.reconnectDelay = Math.min(entry.reconnectDelay * 2, maxReconnectDelayMs);
      entry.queue = entry.queue.then(() => reconnect(source, entry));
    }, wait);
    timer?.unref?.();
    entry.reconnectTimer = timer;
  }

  function onClientClose(source, entry, client, info) {
    if (closed || entry.client !== client) return;
    entry.state = "waiting";
    entry.reconnectDelay = reconnectDelayMs;
    publish(entry.clientTransport === TRANSPORT.IPC ? "discord-closed" : "arrpc-closed", info?.reason ?? null);
    scheduleReconnect(source, entry);
  }

  function handleFailure(source, entry, error) {
    const text = typeof error === "string" && error.length > 0 ? error : "rejected";
    // Each failure starts at the base delay, not at an inflated backoff left
    // behind by earlier retries.
    entry.reconnectDelay = reconnectDelayMs;

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
      // A finished pair would land as an elapsed-only card; the worker
      // republishes a live one once the bridge reports connected.
      if (!isReplayable(entry.lastActivity, Date.now())) return;

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
    let clientIdsChanged = false;
    if (message.clientIds && typeof message.clientIds === "object") {
      for (const [source, value] of Object.entries(message.clientIds)) {
        const entry = sources.get(source);
        if (!entry) continue;
        const text = typeof value === "string" ? value.trim() : "";
        if (!text) continue;
        const sourceId = resolveClientId(text, source);
        if (sourceId !== text) {
          publish("rejected", "invalid client id", "error");
          return;
        }
        if (entry.clientId !== sourceId) {
          entry.clientId = sourceId;
          clientIdsChanged = true;
        }
      }
    }

    // A per-source id change needs the same full reset as a host-level one;
    // closing a client without resetting state leaves a connected zombie.
    if (resolved === currentClientId && transport === preference && !clientIdsChanged) return;

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
        entry.state = "waiting";
        scheduleReconnect(source, entry, 0);
      } else if (entry.state !== "idle") {
        entry.state = "waiting";
      }
    }
    publish(null, null, "connecting");
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


/**
 * Chrome starts the host with the caller's origin and, on Windows, its parent
 * window handle: `host.mjs chrome-extension://<id>/ --parent-window=<n>`.
 * Those are expected launcher arguments, not a usage error.
 */
const CHROME_ARGUMENTS = ["chrome-extension://", "--parent-window="];

const isChromeArgument = (argument) =>
  CHROME_ARGUMENTS.some((prefix) => argument.startsWith(prefix));

async function main(argv) {
  if (argv.includes("--selftest")) {
    const { runSelftest } = await import("./selftest.mjs");
    return runSelftest();
  }

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
        process.stderr.write(`[presence-suite] cannot send: ${error?.message ?? error}\n`);
      }
    },
    logger: stderrLogger(),
    clientOptions: overrides.clientOptions,
    ipcOptions: overrides.ipcOptions,
  });
  // Chrome can close the native port while a write is in flight; an async
  // EPIPE must not become an uncaught exception.
  process.stdout.on("error", (error) => {
    try {
      process.stderr.write(`[presence-suite] stdout error: ${error?.message ?? error}\n`);
    } catch {}
    host.close();
    process.stdin.destroy();
  });
  process.stderr.on("error", () => {});

  const decoder = createDecoder();

  process.stdin.on("data", (chunk) => {
    let messages;
    try {
      messages = decoder.push(chunk);
    } catch (error) {
      process.stderr.write(`[presence-suite] framing error: ${error?.message ?? error}\n`);
      process.exitCode = 1;
      host.close();
      process.stdin.destroy();
      return;
    }
    for (const message of messages) {
      host.handle(message).catch((error) => {
        process.stderr.write(`[presence-suite] unhandled: ${error?.message ?? error}\n`);
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
      process.stderr.write(`[presence-suite] fatal: ${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
