import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CLIENT_ID } from "../config.js";
import { createHost, isReplayable } from "../native/host.mjs";

const NOW = 1_700_000_000_000;
const NOW_SEC = Math.floor(NOW / 1000);

test("isReplayable refuses a pair whose end has passed", () => {
  assert.equal(isReplayable({ timestamps: { start: 1, end: 2 } }, NOW), false);
  assert.equal(
    isReplayable({ timestamps: { start: NOW_SEC - 10, end: NOW_SEC } }, NOW),
    false,
    "an end at now is already finished"
  );
  assert.equal(
    isReplayable({ timestamps: { start: NOW - 20_000, end: NOW - 1 } }, NOW),
    false,
    "a millisecond end in the past"
  );
});

test("isReplayable keeps a pair whose end is in the future", () => {
  assert.equal(isReplayable({ timestamps: { start: NOW_SEC, end: NOW_SEC + 60 } }, NOW), true);
  assert.equal(isReplayable({ timestamps: { start: NOW, end: NOW + 60_000 } }, NOW), true);
});

test("isReplayable keeps unknown ranges", () => {
  const unknowns = [
    null,
    {},
    { timestamps: null },
    { timestamps: "junk" },
    { timestamps: {} },
    { timestamps: { end: "nonsense" } },
    { timestamps: { end: null } },
    { timestamps: { end: "" } },
    { timestamps: { end: Infinity } },
  ];
  for (const activity of unknowns) {
    assert.equal(isReplayable(activity, NOW), true, JSON.stringify(activity));
  }
});

function fakeHost() {
  const clients = [];
  const timers = new Map();
  let nextId = 1;
  const createClient = () => {
    const client = {
      ready: false,
      sent: [],
      async connect() {
        this.ready = true;
        return { ok: true };
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
  const host = createHost({
    send() {},
    createClient,
    createIpcClient: createClient,
    setTimeoutImpl: (fn) => {
      const id = nextId++;
      timers.set(id, fn);
      return id;
    },
    clearTimeoutImpl: (id) => timers.delete(id),
    randomImpl: () => 0.5,
  });
  return { host, clients, timers };
}

async function fireReconnect(fx) {
  const [fire] = [...fx.timers.values()];
  assert.ok(fire, "a reconnect was scheduled");
  fx.timers.clear();
  fire();
  await new Promise((resolve) => setImmediate(resolve));
}

test("reconnect does not replay an expired pair", async () => {
  const fx = fakeHost();
  await fx.host.handle({ t: "hello", clientId: DEFAULT_CLIENT_ID, version: 1, transport: "arrpc" });
  await fx.host.handle({
    t: "activity",
    source: "youtube-music",
    id: "a1",
    activity: { details: "Song", timestamps: { start: 1, end: 2 } },
  });
  assert.equal(fx.clients.at(-1).sent.length, 1, "the live activity was delivered");

  // A changed client id resets the client and schedules a reconnect.
  await fx.host.handle({ t: "hello", clientId: "1566530911514923189", version: 1, transport: "arrpc" });
  await fireReconnect(fx);
  assert.equal(fx.clients.at(-1).sent.length, 0, "no expired replay after reconnect");
  fx.host.close();
});

test("reconnect still replays an untimed activity", async () => {
  const fx = fakeHost();
  await fx.host.handle({ t: "hello", clientId: DEFAULT_CLIENT_ID, version: 1, transport: "arrpc" });
  await fx.host.handle({
    t: "activity",
    source: "youtube-music",
    id: "a2",
    activity: { details: "Song" },
  });
  await fx.host.handle({ t: "hello", clientId: "1566530911514923189", version: 1, transport: "arrpc" });
  await fireReconnect(fx);
  assert.equal(fx.clients.at(-1).sent.length, 1, "an unknown range is still replayed");
  fx.host.close();
});
