import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { DEFAULT_CLIENT_ID } from "../../config.js";
import { createHost, transportOverridesFromEnv } from "../../native/host.mjs";
import { createDecoder, encodeMessage } from "../../native/native-framing.mjs";

const HOST_PATH = fileURLToPath(new URL("../../native/host.mjs", import.meta.url));
const ACTIVITY = { type: 3, details: "Big Buck Bunny" };

/* ---------------------------------------------------------------- helpers */

function makeFakes() {
  const log = [];
  const ipcClients = [];
  const arrpcClients = [];
  const scenario = { ipcFail: null, arrpcFail: null };

  const createIpcClient = (options) => {
    log.push(`ipc.create:${options.source}`);
    const client = {
      options,
      ready: false,
      closed: false,
      sent: [],
      async connect() {
        log.push(`ipc.connect:${options.source}`);
        if (scenario.ipcFail) {
          return { ok: false, error: "discord-unavailable", detail: scenario.ipcFail };
        }
        this.ready = true;
        return { ok: true, pipePath: "selftest", user: "tester" };
      },
      async setActivity(activity) {
        log.push(`ipc.setActivity:${options.source}`);
        this.sent.push(activity);
        return { ok: true, appName: "Discord Test" };
      },
      close() {
        this.closed = true;
        this.ready = false;
        log.push(`ipc.close:${options.source}`);
      },
    };
    ipcClients.push(client);
    return client;
  };

  const createClient = (options) => {
    log.push(`arrpc.create:${options.source}`);
    const client = {
      options,
      ready: false,
      closed: false,
      sent: [],
      async connect() {
        log.push(`arrpc.connect:${options.source}`);
        if (scenario.arrpcFail) {
          return { ok: false, error: "arrpc-unavailable", detail: scenario.arrpcFail };
        }
        this.ready = true;
        return { ok: true, port: 6463, user: "arrpc" };
      },
      async setActivity(activity) {
        log.push(`arrpc.setActivity:${options.source}`);
        this.sent.push(activity);
        return { ok: true };
      },
      close() {
        this.closed = true;
        this.ready = false;
        log.push(`arrpc.close:${options.source}`);
      },
    };
    arrpcClients.push(client);
    return client;
  };

  return { log, ipcClients, arrpcClients, scenario, createIpcClient, createClient };
}

function fakeTimers() {
  const pending = new Map();
  const delays = [];
  let nextId = 1;
  return {
    delays,
    set(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clear(id) {
      pending.delete(id);
    },
    size: () => pending.size,
    fire() {
      const [id, entry] = [...pending.entries()][0];
      pending.delete(id);
      delays.push(entry.ms);
      entry.fn();
      return entry.ms;
    },
  };
}

function collect() {
  const frames = [];
  return { frames, send: (message) => frames.push(message) };
}

function makeHost(fakes, extra = {}) {
  const { frames, send } = collect();
  const timers = fakeTimers();
  const host = createHost({
    send,
    createClient: fakes.createClient,
    createIpcClient: fakes.createIpcClient,
    setTimeoutImpl: timers.set,
    clearTimeoutImpl: timers.clear,
    ...extra,
  });
  return { host, frames, timers };
}

const statusOf = (frames, state) =>
  frames.filter((message) => message.t === "status" && message.state === state).at(-1);
const ackOf = (frames, id) => frames.find((message) => message.t === "ack" && message.id === id);

function waitFor(predicate, label = "condition", timeoutMs = 8_000) {
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

/** Spawn the real CLI host so the environment overrides are proven on the wire. */
async function spawnHost({ env = {}, messages = [] } = {}) {
  const child = spawn(process.execPath, [HOST_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
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

  for (const message of messages) child.stdin.write(encodeMessage(message));

  try {
    await waitFor(
      () => frames.some((message) => message.t === "ack")
        && frames.some((message) => message.t === "status" && message.state !== "connected"),
      "a waiting status and an ack",
      10_000,
    );
  } finally {
    child.stdin.end();
  }

  const code = await new Promise((resolve) => child.once("exit", resolve));
  return { frames, stderr, code, stdoutError };
}

/* ------------------------------------------------------------------ tests */

test("auto (the default) uses Discord IPC and never builds arRPC", async () => {
  const fakes = makeFakes();
  const { host, frames } = makeHost(fakes);

  await host.handle({ t: "hello", clientId: DEFAULT_CLIENT_ID, version: 1 });
  await host.handle({ t: "activity", source: "youtube-music", id: "a1", activity: ACTIVITY });

  assert.deepEqual(ackOf(frames, "a1"), { t: "ack", source: "youtube-music", id: "a1", ok: true });
  assert.equal(fakes.ipcClients.length, 1);
  assert.equal(fakes.arrpcClients.length, 0, "the primary path never builds arRPC");
  assert.deepEqual(fakes.ipcClients[0].sent, [ACTIVITY]);
  assert.equal(statusOf(frames, "connected").transport, "discord-ipc");
  assert.equal(statusOf(frames, "connected").sources["youtube-music"], "connected");
  host.close();
});

test("auto falls back to arRPC when no Discord pipe answers", async () => {
  const fakes = makeFakes();
  fakes.scenario.ipcFail = "connect ENOENT \\\\.\\pipe\\discord-ipc-0";
  const { host, frames } = makeHost(fakes);

  await host.handle({ t: "hello", clientId: DEFAULT_CLIENT_ID, version: 1, transport: "auto" });
  await host.handle({ t: "activity", source: "youtube-music", id: "a2", activity: ACTIVITY });

  assert.equal(ackOf(frames, "a2").ok, true);
  assert.equal(fakes.ipcClients[0].closed, true, "the failed IPC client is closed");
  assert.equal(fakes.arrpcClients.length, 1);
  assert.deepEqual(fakes.arrpcClients[0].sent, [ACTIVITY]);
  assert.equal(statusOf(frames, "connected").transport, "arrpc");
  host.close();
});

test("auto with neither transport acks transport-unavailable and waits", async () => {
  const fakes = makeFakes();
  fakes.scenario.ipcFail = "connect ENOENT \\\\.\\pipe\\discord-ipc-0";
  fakes.scenario.arrpcFail = "no arRPC server answered";
  const { host, frames, timers } = makeHost(fakes);

  await host.handle({ t: "hello", clientId: DEFAULT_CLIENT_ID, version: 1, transport: "auto" });
  await host.handle({ t: "activity", source: "youtube-music", id: "a3", activity: ACTIVITY });

  const ack = ackOf(frames, "a3");
  assert.equal(ack.ok, false);
  assert.equal(ack.error, "transport-unavailable");

  const waiting = statusOf(frames, "waiting");
  assert.equal(waiting.reason, "discord-closed", "the primary absence is what the user reads");
  assert.equal(waiting.transport, "discord-ipc");
  assert.equal(waiting.detail, "connect ENOENT \\\\.\\pipe\\discord-ipc-0");
  assert.equal(statusOf(frames, "error"), undefined, "absence is never an error");
  assert.equal(timers.size(), 1, "one reconnect is armed");
  host.close();
});

test("a forced ipc never falls back to arRPC", async () => {
  const fakes = makeFakes();
  fakes.scenario.ipcFail = "connect ENOENT \\\\.\\pipe\\discord-ipc-0";
  const { host, frames } = makeHost(fakes);

  await host.handle({ t: "hello", clientId: DEFAULT_CLIENT_ID, version: 1, transport: "ipc" });
  await host.handle({ t: "activity", source: "youtube-music", id: "a4", activity: ACTIVITY });

  assert.equal(ackOf(frames, "a4").error, "transport-unavailable");
  assert.equal(fakes.arrpcClients.length, 0, "a forced ipc never reaches arRPC");
  const waiting = statusOf(frames, "waiting");
  assert.equal(waiting.transport, "discord-ipc");
  assert.equal(waiting.reason, "discord-closed");
  host.close();
});

test("a forced arrpc never builds ipc and reports arrpc-closed with the client's detail", async () => {
  const fakes = makeFakes();
  fakes.scenario.arrpcFail = "no arRPC server answered on ports 6463-6472";
  const { host, frames } = makeHost(fakes);

  await host.handle({ t: "hello", clientId: DEFAULT_CLIENT_ID, version: 1, transport: "arrpc" });
  await host.handle({ t: "activity", source: "youtube-music", id: "a5", activity: ACTIVITY });

  assert.equal(fakes.ipcClients.length, 0);
  assert.equal(ackOf(frames, "a5").error, "arrpc-unavailable");
  const waiting = statusOf(frames, "waiting");
  assert.equal(waiting.transport, "arrpc");
  assert.equal(waiting.reason, "arrpc-closed");
  assert.equal(waiting.detail, "no arRPC server answered on ports 6463-6472");
  host.close();
});

test("a successful connect publishes reason null on desktop IPC", async () => {
  const fakes = makeFakes();
  const { host, frames } = makeHost(fakes);

  await host.handle({ t: "hello", clientId: DEFAULT_CLIENT_ID, version: 1, transport: "auto" });
  await host.handle({ t: "activity", source: "youtube-music", id: "g1", activity: ACTIVITY });

  const ipcConnected = statusOf(frames, "connected");
  assert.equal(ipcConnected.transport, "discord-ipc");
  assert.equal(ipcConnected.reason, null, "the popup switches on the reason string, not on connected");
  assert.equal(ipcConnected.sources["youtube-music"], "connected");
  host.close();
});

test("Music stays on its first transport: a second activity reuses the same IPC client", async () => {
  const fakes = makeFakes();
  const { host, frames } = makeHost(fakes);

  await host.handle({ t: "hello", clientId: DEFAULT_CLIENT_ID, version: 1, transport: "auto" });
  await host.handle({ t: "activity", source: "youtube-music", id: "b1", activity: ACTIVITY });
  assert.equal(statusOf(frames, "connected").transport, "discord-ipc");

  // Music is the only source, so a second activity reuses the IPC client
  // instead of opening a second transport.
  await host.handle({ t: "activity", source: "youtube-music", id: "b2", activity: ACTIVITY });

  assert.equal(fakes.ipcClients.length, 1, "one Music source keeps one IPC client");
  assert.equal(fakes.arrpcClients.length, 0, "no second transport is built for Music");
  assert.deepEqual(
    fakes.log.filter((entry) => entry.endsWith(":youtube-music")),
    [
      "ipc.create:youtube-music",
      "ipc.connect:youtube-music",
      "ipc.setActivity:youtube-music",
      "ipc.setActivity:youtube-music",
    ],
  );
  const connected = statusOf(frames, "connected");
  assert.equal(connected.transport, "discord-ipc");
  assert.equal(connected.sources["youtube-music"], "connected");
  host.close();
});

test("one client for Music: two activities share a single IPC client", async () => {
  const fakes = makeFakes();
  const { host, frames } = makeHost(fakes);

  await host.handle({ t: "hello", clientId: DEFAULT_CLIENT_ID, version: 1, transport: "auto" });
  await host.handle({ t: "activity", source: "youtube-music", id: "c1", activity: { details: "One" } });
  await host.handle({ t: "activity", source: "youtube-music", id: "c2", activity: { details: "Two" } });

  assert.equal(fakes.ipcClients.length, 1);
  assert.equal(fakes.ipcClients[0].options.source, "youtube-music");
  assert.deepEqual(fakes.ipcClients.map((client) => client.sent), [[{ details: "One" }, { details: "Two" }]]);
  assert.equal(statusOf(frames, "connected").transport, "discord-ipc");
  host.close();
});

test("activity before hello stays on the legacy arRPC path", async () => {
  const fakes = makeFakes();
  const { host, frames } = makeHost(fakes);

  await host.handle({ t: "activity", source: "youtube-music", id: "d1", activity: ACTIVITY });

  assert.equal(fakes.ipcClients.length, 0, "no hello means no transport preference to honour");
  assert.equal(fakes.arrpcClients.length, 1);
  assert.equal(statusOf(frames, "connected").transport, "arrpc");
  host.close();
});

test("an unknown transport is rejected before any client is built", async () => {
  const fakes = makeFakes();
  const { host, frames } = makeHost(fakes);

  await host.handle({ t: "hello", clientId: DEFAULT_CLIENT_ID, version: 1, transport: "gateway" });

  assert.deepEqual(fakes.log, []);
  const status = statusOf(frames, "error");
  assert.equal(status.reason, "rejected");
  assert.equal(status.detail, "unsupported transport gateway");
  host.close();
});

test("a new hello rebuilds the transport and resends the last activity", async () => {
  const fakes = makeFakes();
  const { host, frames, timers } = makeHost(fakes);

  await host.handle({ t: "hello", clientId: DEFAULT_CLIENT_ID, version: 1, transport: "arrpc" });
  await host.handle({ t: "activity", source: "youtube-music", id: "e1", activity: ACTIVITY });

  await host.handle({ t: "hello", clientId: DEFAULT_CLIENT_ID, version: 1, transport: "ipc" });
  assert.equal(fakes.arrpcClients[0].closed, true, "the old transport is disconnected");
  assert.equal(timers.size(), 1, "the source reconnects immediately");

  timers.fire();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fakes.ipcClients.length, 1);
  assert.deepEqual(fakes.ipcClients[0].sent, [ACTIVITY]);
  assert.equal(statusOf(frames, "connected").transport, "discord-ipc");
  host.close();
});

test("an IPC drop reports discord-closed and rearms the reconnect", async () => {
  const fakes = makeFakes();
  const { host, frames, timers } = makeHost(fakes);

  await host.handle({ t: "hello", clientId: DEFAULT_CLIENT_ID, version: 1, transport: "auto" });
  await host.handle({ t: "activity", source: "youtube-music", id: "f1", activity: ACTIVITY });

  fakes.ipcClients[0].ready = false;
  fakes.ipcClients[0].options.onClose({ reason: "discord-closed" });

  const waiting = statusOf(frames, "waiting");
  assert.equal(waiting.reason, "discord-closed");
  assert.equal(waiting.transport, "discord-ipc");
  assert.equal(timers.size(), 1);
  host.close();
});

test("the transport overrides parse only when set, and drop nonsense", () => {
  assert.deepEqual(transportOverridesFromEnv({}), { clientOptions: {}, ipcOptions: {} });
  assert.deepEqual(
    transportOverridesFromEnv({ WDR_ARRPC_PORTS: "6471, 6472", WDR_DISCORD_PIPES: "\\\\.\\pipe\\wdr-e2e-a;\\\\.\\pipe\\wdr-e2e-b" }),
    {
      clientOptions: { ports: [6471, 6472] },
      ipcOptions: { pipes: ["\\\\.\\pipe\\wdr-e2e-a", "\\\\.\\pipe\\wdr-e2e-b"] },
    },
  );
  assert.deepEqual(
    transportOverridesFromEnv({ WDR_ARRPC_PORTS: "nope,70000,0", WDR_DISCORD_PIPES: " ; " }),
    { clientOptions: {}, ipcOptions: {} },
  );
});

test("the spawned host accepts Chrome's origin and parent-window arguments", async () => {
  const child = spawn(
    process.execPath,
    [
      HOST_PATH,
      "chrome-extension://mnmmfbjinpokfnendlbhbbdmfjidgikf/",
      "--parent-window=0",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

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
  child.stdin.write(encodeMessage({ t: "ping" }));

  let code;
  try {
    await waitFor(() => frames.some((message) => message.t === "pong"), "pong");
  } finally {
    child.stdin.end();
    code = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), 5_000);
      child.once("exit", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    if (code === "timeout") child.kill();
  }

  assert.equal(stdoutError, null);
  assert.deepEqual(frames, [{ t: "pong" }]);
  assert.equal(code, 0, `Chrome's own arguments must not be fatal; stderr: ${stderr.trim()}`);
});

test("a genuinely unknown argument is still rejected", async () => {
  const child = spawn(process.execPath, [HOST_PATH, "--not-a-thing"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 5_000);
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  if (code === "timeout") child.kill();

  assert.equal(code, 2);
  assert.match(stderr, /unknown argument: --not-a-thing/);
});

test("WDR_DISCORD_PIPES reaches the spawned host's IPC probe", async () => {  const injected = "\\\\.\\pipe\\wdr-nonexistent-transport-override";
  const { frames, stdoutError, code } = await spawnHost({
    env: { WDR_DISCORD_PIPES: injected },
    messages: [
      { t: "hello", clientId: DEFAULT_CLIENT_ID, version: 1, transport: "ipc" },
      { t: "activity", source: "youtube-music", id: "env-ipc", activity: ACTIVITY },
    ],
  });

  assert.equal(stdoutError, null);
  assert.equal(code, 0);
  assert.equal(ackOf(frames, "env-ipc").error, "transport-unavailable");
  const waiting = statusOf(frames, "waiting");
  assert.equal(waiting.transport, "discord-ipc");
  assert.match(waiting.detail, /wdr-nonexistent-transport-override/);
});

test("WDR_ARRPC_PORTS reaches the spawned host's arRPC probe", async () => {
  const { frames, stdoutError, code } = await spawnHost({
    env: { WDR_ARRPC_PORTS: "6471" },
    messages: [
      { t: "hello", clientId: DEFAULT_CLIENT_ID, version: 1, transport: "arrpc" },
      { t: "activity", source: "youtube-music", id: "env-arrpc", activity: ACTIVITY },
    ],
  });

  assert.equal(stdoutError, null);
  assert.equal(code, 0);
  assert.equal(ackOf(frames, "env-arrpc").error, "arrpc-unavailable");
  const waiting = statusOf(frames, "waiting");
  assert.equal(waiting.transport, "arrpc");
  assert.match(waiting.detail, /ports 6471/);
});
