import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_CLIENT_ID, SOURCE_META } from "../../config.js";
import { createHost } from "../../native/host.mjs";

function makeFakeClients() {
  const clients = [];
  const scenario = { failConnect: false, failActivity: false };

  const createClient = (options) => {
    const client = {
      options,
      ready: false,
      port: null,
      sent: [],
      closed: false,
      async connect() {
        if (scenario.failConnect) {
          return { ok: false, reason: "arrpc-unavailable", detail: "absent" };
        }
        this.ready = true;
        this.port = 6463;
        return { ok: true, port: 6463, user: { id: "1045800378228281345", username: "arrpc" } };
      },
      async setActivity(activity) {
        if (scenario.failActivity) return { ok: false, error: "hung" };
        this.sent.push(activity);
        return { ok: true };
      },
      close() {
        this.closed = true;
        this.ready = false;
      },
    };
    clients.push(client);
    return client;
  };

  return { clients, scenario, createClient };
}

/** One fake Discord IPC client per source, with a connect count the host cannot fake. */
function makeFakeIpcClients() {
  const clients = [];

  const createIpcClient = (options) => {
    const client = {
      options,
      ready: false,
      connects: 0,
      sent: [],
      async connect() {
        this.connects += 1;
        this.ready = true;
        return { ok: true, pipePath: "\\\\.\\pipe\\discord-ipc-0" };
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

  return { clients, createIpcClient };
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
    size() {
      return pending.size;
    },
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

// The roster is whatever config.js declares, so this assertion outlives the
// Music-only source table instead of hard-coding its keys.
const idleSources = Object.fromEntries(Object.keys(SOURCE_META).map((source) => [source, "idle"]));

const statusOf = (frames, state) =>
  frames.find((message) => message.t === "status" && message.state === state);

const ackOf = (frames) => frames.find((message) => message.t === "ack");

test("ping answers pong without creating a transport", async () => {
  const { frames, send } = collect();
  const fake = makeFakeClients();
  const host = createHost({ send, createClient: fake.createClient });

  await host.handle({ t: "ping" });

  assert.deepEqual(frames, [{ t: "pong" }]);
  assert.equal(fake.clients.length, 0);
  host.close();
});

test("a valid hello announces the host as connecting with the transport it will use", async () => {
  const { frames, send } = collect();
  const host = createHost({ send });

  await host.handle({ t: "hello", clientId: DEFAULT_CLIENT_ID, version: 1, transport: "ipc" });

  assert.deepEqual(frames, [
    {
      t: "status",
      state: "connecting",
      transport: "discord-ipc",
      reason: null,
      detail: null,
      sources: idleSources,
    },
  ]);

  // The same hello twice is not a second announcement.
  await host.handle({ t: "hello", clientId: DEFAULT_CLIENT_ID, version: 1, transport: "ipc" });
  assert.equal(frames.length, 1);
  host.close();
});

test("hello sets the application id and an activity is acked after SET_ACTIVITY", async () => {
  const { frames, send } = collect();
  const fake = makeFakeClients();
  const host = createHost({ send, createClient: fake.createClient });

  await host.handle({ t: "hello", clientId: DEFAULT_CLIENT_ID, version: 1, transport: "arrpc" });
  await host.handle({
    t: "activity",
    source: "youtube-music",
    id: "act-1",
    activity: { details: "Big Buck Bunny", type: 2 },
  });

  assert.deepEqual(ackOf(frames), { t: "ack", source: "youtube-music", id: "act-1", ok: true });
  assert.equal(fake.clients.length, 1);
  assert.equal(fake.clients[0].options.clientId, DEFAULT_CLIENT_ID);
  assert.equal(fake.clients[0].options.source, "youtube-music");
  assert.deepEqual(fake.clients[0].sent, [{ details: "Big Buck Bunny", type: 2 }]);

  const connected = statusOf(frames, "connected");
  assert.equal(connected.transport, "arrpc");
  assert.equal(connected.sources["youtube-music"], "connected");
  host.close();
});

test("one transport is reused across activities", async () => {
  const { send } = collect();
  const fake = makeFakeClients();
  const host = createHost({ send, createClient: fake.createClient });

  await host.handle({ t: "activity", source: "youtube-music", id: "a", activity: { details: "one" } });
  await host.handle({ t: "activity", source: "youtube-music", id: "b", activity: { details: "two" } });
  await host.handle({ t: "activity", source: "youtube-music", id: "c", activity: { details: "three" } });

  assert.equal(fake.clients.length, 1);
  assert.equal(fake.clients[0].options.source, "youtube-music");
  assert.deepEqual(fake.clients[0].sent, [{ details: "one" }, { details: "two" }, { details: "three" }]);
  host.close();
});

test("a null activity clears presence and is still acked", async () => {
  const { frames, send } = collect();
  const fake = makeFakeClients();
  const host = createHost({ send, createClient: fake.createClient });

  await host.handle({ t: "activity", source: "youtube-music", id: "clear", activity: null });

  assert.deepEqual(ackOf(frames), { t: "ack", source: "youtube-music", id: "clear", ok: true });
  assert.deepEqual(fake.clients[0].sent, [null]);
  host.close();
});

test("an unknown source or a non-object activity is refused without a transport", async () => {
  const { frames, send } = collect();
  const fake = makeFakeClients();
  const host = createHost({ send, createClient: fake.createClient });

  await host.handle({ t: "activity", source: "soundcloud", id: "x", activity: { details: "x" } });
  await host.handle({ t: "activity", source: "youtube-music", id: "y", activity: "nope" });

  assert.deepEqual(frames, [
    { t: "ack", source: "soundcloud", id: "x", ok: false, error: "unknown-source" },
    { t: "ack", source: "youtube-music", id: "y", ok: false, error: "invalid-activity" },
  ]);
  assert.equal(fake.clients.length, 0);
  host.close();
});

test("a failed connect acks arrpc-unavailable and reports waiting, not error", async () => {
  const { frames, send } = collect();
  const fake = makeFakeClients();
  fake.scenario.failConnect = true;
  const timers = fakeTimers();
  const host = createHost({
    send,
    createClient: fake.createClient,
    setTimeoutImpl: timers.set,
    clearTimeoutImpl: timers.clear,
  });

  await host.handle({ t: "activity", source: "youtube-music", id: "act", activity: { details: "x" } });

  assert.deepEqual(ackOf(frames), {
    t: "ack",
    source: "youtube-music",
    id: "act",
    ok: false,
    error: "arrpc-unavailable",
  });
  const waiting = statusOf(frames, "waiting");
  assert.equal(waiting.reason, "arrpc-closed");
  assert.equal(waiting.sources["youtube-music"], "waiting");
  assert.equal(statusOf(frames, "error"), undefined);
  assert.equal(timers.size(), 1, "a reconnect is armed");
  host.close();
});

test("a reconnect resends the last activity and reports connected", async () => {
  const { frames, send } = collect();
  const fake = makeFakeClients();
  fake.scenario.failConnect = true;
  const timers = fakeTimers();
  const host = createHost({
    send,
    createClient: fake.createClient,
    setTimeoutImpl: timers.set,
    clearTimeoutImpl: timers.clear,
  });

  await host.handle({ t: "activity", source: "youtube-music", id: "act", activity: { details: "queued" } });
  assert.equal(timers.size(), 1);

  fake.scenario.failConnect = false;
  timers.fire();
  await new Promise((resolve) => setImmediate(resolve));

  const connected = statusOf(frames, "connected");
  assert.equal(connected.sources["youtube-music"], "connected");
  assert.deepEqual(fake.clients[0].sent.at(-1), { details: "queued" });
  host.close();
});

/*
 * The installed Discord desktop app is reached over one IPC socket per source.
 * Closing Discord, or losing that socket, must not lose the card already
 * published: the host reconnects and resends it.
 */
test("a YouTube Music activity is resent after a Discord IPC disconnect and reconnect", async () => {
  const { frames, send } = collect();
  const ipc = makeFakeIpcClients();
  const timers = fakeTimers();
  const host = createHost({
    send,
    createIpcClient: ipc.createIpcClient,
    setTimeoutImpl: timers.set,
    clearTimeoutImpl: timers.clear,
  });

  await host.handle({ t: "hello", clientId: DEFAULT_CLIENT_ID, version: 1, transport: "ipc" });

  const activity = { name: "Muse", type: 2, details: "New Born", state: "Origin of Symmetry" };
  await host.handle({ t: "activity", source: "youtube-music", id: "track-1", activity });

  assert.deepEqual(ackOf(frames), { t: "ack", source: "youtube-music", id: "track-1", ok: true });
  assert.equal(statusOf(frames, "connected").transport, "discord-ipc");
  assert.equal(ipc.clients.length, 1);
  const client = ipc.clients[0];
  assert.equal(client.connects, 1);
  assert.deepEqual(client.sent, [activity]);

  // Discord closes: the socket reports its own close and the host waits.
  client.ready = false;
  client.options.onClose({ reason: "discord-closed" });

  const waiting = statusOf(frames, "waiting");
  assert.equal(waiting.reason, "discord-closed");
  assert.equal(waiting.sources["youtube-music"], "waiting");
  assert.equal(timers.size(), 1, "a reconnect is armed");

  // Discord reopens: the armed reconnect connects again and resends the card.
  timers.fire();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ipc.clients.length, 1, "the pipe client is reused, not duplicated");
  assert.equal(client.connects, 2, "the reopened pipe was connected again");
  assert.deepEqual(client.sent, [activity, activity], "the retained activity is sent again");

  const reconnected = frames
    .filter((message) => message.t === "status" && message.state === "connected")
    .at(-1);
  assert.equal(reconnected.transport, "discord-ipc");
  assert.equal(reconnected.sources["youtube-music"], "connected");
  host.close();
  assert.equal(timers.size(), 0);
});

test("an unexpected socket close reports waiting and reconnects with backoff that doubles", async () => {
  const { frames, send } = collect();
  const fake = makeFakeClients();
  const timers = fakeTimers();
  const host = createHost({
    send,
    createClient: fake.createClient,
    setTimeoutImpl: timers.set,
    clearTimeoutImpl: timers.clear,
    reconnectDelayMs: 10,
    maxReconnectDelayMs: 40,
  });

  await host.handle({ t: "activity", source: "youtube-music", id: "act", activity: { details: "x" } });
  fake.scenario.failConnect = true;
  fake.clients[0].ready = false;
  fake.clients[0].options.onClose({ reason: "arrpc-closed" });

  const waiting = statusOf(frames, "waiting");
  assert.equal(waiting.reason, "arrpc-closed");
  assert.equal(timers.size(), 1);

  timers.fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.size(), 1, "failed reconnect re-arms");
  timers.fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(timers.delays, [10, 20]);
  host.close();
});

test("a hung reply reports an error and reconnects", async () => {
  const { frames, send } = collect();
  const fake = makeFakeClients();
  const timers = fakeTimers();
  const host = createHost({
    send,
    createClient: fake.createClient,
    setTimeoutImpl: timers.set,
    clearTimeoutImpl: timers.clear,
  });

  fake.scenario.failActivity = true;
  await host.handle({ t: "activity", source: "youtube-music", id: "act", activity: { details: "x" } });

  assert.deepEqual(ackOf(frames), {
    t: "ack",
    source: "youtube-music",
    id: "act",
    ok: false,
    error: "hung",
  });
  assert.equal(statusOf(frames, "error").reason, "hung");
  assert.equal(fake.clients[0].closed, true);
  assert.equal(timers.size(), 1);
  host.close();
});

test("hello with a new application id rebuilds the transport and resends the last activity", async () => {
  const nextId = "1234567890123456789";
  const { frames, send } = collect();
  const fake = makeFakeClients();
  const timers = fakeTimers();
  const host = createHost({
    send,
    createClient: fake.createClient,
    setTimeoutImpl: timers.set,
    clearTimeoutImpl: timers.clear,
  });

  await host.handle({ t: "activity", source: "youtube-music", id: "a", activity: { details: "one" } });
  await host.handle({ t: "hello", clientId: nextId, version: 1, transport: "arrpc" });

  assert.equal(fake.clients[0].closed, true, "the old application id is disconnected");
  assert.equal(timers.size(), 1, "the source reconnects immediately");

  timers.fire();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fake.clients.length, 2);
  assert.equal(fake.clients[1].options.clientId, nextId);
  assert.deepEqual(fake.clients[1].sent.at(-1), { details: "one" });
  assert.equal(statusOf(frames, "connected").sources["youtube-music"], "connected");
  host.close();
});

test("a malformed hello is rejected with status error, not silently accepted", async () => {
  const { frames, send } = collect();
  const host = createHost({ send });

  await host.handle({ t: "hello", clientId: "not-an-id", version: 1 });
  await host.handle({ t: "hello", clientId: DEFAULT_CLIENT_ID, version: 2 });

  const statuses = frames.filter((message) => message.t === "status");
  assert.equal(statuses.length, 2);
  assert.equal(statuses[0].state, "error");
  assert.equal(statuses[0].reason, "rejected");
  assert.equal(statuses[0].detail, "invalid client id");
  assert.equal(statuses[1].state, "error");
  assert.equal(statuses[1].detail, "unsupported protocol version 2");
  host.close();
});

test("activity before hello publishes under the built-in application id", async () => {
  const { send } = collect();
  const fake = makeFakeClients();
  const host = createHost({ send, createClient: fake.createClient });

  await host.handle({ t: "activity", source: "youtube-music", id: "a", activity: { details: "x" } });

  assert.equal(fake.clients[0].options.clientId, DEFAULT_CLIENT_ID);
  host.close();
});

test("a transport factory that throws is acked and does not poison the source queue", async () => {
  const { frames, send } = collect();
  const timers = fakeTimers();
  const host = createHost({
    send,
    createClient: () => {
      throw new Error("boom");
    },
    setTimeoutImpl: timers.set,
    clearTimeoutImpl: timers.clear,
  });

  await host.handle({ t: "activity", source: "youtube-music", id: "a", activity: { details: "x" } });
  await host.handle({ t: "activity", source: "youtube-music", id: "b", activity: { details: "y" } });

  const acks = frames.filter((message) => message.t === "ack");
  assert.deepEqual(
    acks.map((message) => [message.id, message.ok, message.error]),
    [
      ["a", false, "host-error"],
      ["b", false, "host-error"],
    ],
  );
  assert.equal(timers.size(), 1, "one reconnect is armed, not two");
  host.close();
});

test("close clears timers and transports, and later messages do nothing", async () => {
  const { frames, send } = collect();
  const fake = makeFakeClients();
  fake.scenario.failConnect = true;
  const timers = fakeTimers();
  const host = createHost({
    send,
    createClient: fake.createClient,
    setTimeoutImpl: timers.set,
    clearTimeoutImpl: timers.clear,
  });

  await host.handle({ t: "activity", source: "youtube-music", id: "a", activity: { details: "x" } });
  assert.equal(timers.size(), 1);
  const before = frames.length;

  host.close();
  assert.equal(timers.size(), 0);
  assert.equal(fake.clients[0].closed, true);

  await host.handle({ t: "ping" });
  assert.equal(frames.length, before);
});
