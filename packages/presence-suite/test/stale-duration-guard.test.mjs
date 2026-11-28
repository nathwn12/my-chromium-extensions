// A live duration is evidence only when it is owned. The worker already
// remembers a total per identity; a stale read from an outgoing media element
// must not replace that total mid-track. Mirrors the content-script guards in
// content.js (ownsFreshTiming / playheadInside / pendingTiming): a changed
// total needs a near-zero measured playhead on a freshly owned source, or a
// coherent new identity. No browser, no network, no live playback.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createWorker } from "../background.js";
import { SOURCE_YOUTUBE_MUSIC, TOTALS_KEY } from "../config.js";

const BASE = 1_700_000_000_000;
const ID = "aaaaaaaaaaa";
const OTHER = "bbbbbbbbbbb";
const WATCH = "https://music.youtube.com/watch?v=" + ID;
const OTHER_WATCH = "https://music.youtube.com/watch?v=" + OTHER;
const KEY = SOURCE_YOUTUBE_MUSIC + "|" + ID;
const OTHER_KEY = SOURCE_YOUTUBE_MUSIC + "|" + OTHER;

/** Same fake chrome shape the other timing tests drive, with an injectable clock. */
function fakeChrome(seedTotals) {
  const clock = { t: BASE };
  const timers = [];
  const state = { local: { [TOTALS_KEY]: seedTotals }, session: {} };
  let nextHandle = 1;
  const area = (name) => ({
    async get(keys) {
      if (keys == null) return { ...state[name] };
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of list) if (key in state[name]) out[key] = state[name][key];
      return out;
    },
    async set(values) { Object.assign(state[name], values); },
  });
  const port = {
    posts: [],
    onMessage: { addListener() {}, removeListener() {} },
    onDisconnect: { addListener() {}, removeListener() {} },
    postMessage(message) { this.posts.push(message); },
    disconnect() {},
  };
  const api = {
    runtime: {
      id: "extension-under-test",
      lastError: undefined,
      connectNative() { return port; },
      onMessage: { addListener() {} },
    },
    storage: {
      local: area("local"), session: area("session"), onChanged: { addListener() {} },
    },
    alarms: { create() {}, get() { return null; }, onAlarm: { addListener() {} } },
    tabs: { onRemoved: { addListener() {} } },
  };
  const worker = createWorker({
    chrome: api,
    now: () => clock.t,
    schedule: (fn, ms) => {
      const handle = nextHandle++;
      timers.push({ handle, at: clock.t + ms, fn });
      return handle;
    },
    cancel: (handle) => {
      const index = timers.findIndex((timer) => timer.handle === handle);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  return {
    api, state, clock, timers, port, worker,
    async start() { await worker.start(); },
    feed(overrides = {}) {
      const state = {
        title: "Song Name", channel: "An Artist", paused: false,
        mediaId: ID, trackUrl: WATCH, pageUrl: WATCH,
        duration: null, position: 0,
        ...overrides,
      };
      worker.handleState(
        { t: "presence-state", source: SOURCE_YOUTUBE_MUSIC, state },
        { id: "extension-under-test", frameId: 0, url: WATCH, tab: { id: 7, url: WATCH } }
      );
    },
    activity() {
      return port.posts.filter((message) => message.t === "activity").at(-1)?.activity ?? null;
    },
  };
}

const spanOf = (activity) =>
  activity?.timestamps ? activity.timestamps.end - activity.timestamps.start : null;

const remembered = (fx) => ({
  total: 1088, at: BASE - 1000, plays: 1, title: "Song Name", channel: "An Artist",
});

test("a stale live 200 mid-track keeps the remembered 1088 and never overwrites the cache", async () => {
  const fx = fakeChrome({ [KEY]: remembered() });
  await fx.start();

  // A published, timed card puts the worker mid-track on this identity.
  fx.feed({ duration: null, position: 30 });
  assert.equal(spanOf(fx.activity()), 1088, "the remembered total drives the mid-track card");

  // The outgoing element reports its old total with a reset playhead. There
  // is no fresh source ownership here, so neither the card nor the cache moves.
  fx.feed({ duration: 200, position: 0 });
  assert.equal(spanOf(fx.activity()), 1088, "the outgoing card still spans the remembered total");
  assert.equal(fx.state.local[TOTALS_KEY][KEY].total, 1088, "the stale read leaves the cache alone");
});

test("a real cold start with owned near-zero evidence accepts a live 200", async () => {
  const fx = fakeChrome({ [KEY]: remembered() });
  await fx.start();

  // First live read for this identity: coherent URL/bar ID plus a measured
  // playhead at the start is a freshly owned source, so the live total wins.
  fx.feed({ duration: 200, position: 0 });
  assert.equal(spanOf(fx.activity()), 200, "the owned live total is used");
  assert.equal(fx.state.local[TOTALS_KEY][KEY].total, 200, "the owned live total is cached");

  fx.clock.t += 10;
  fx.feed({ duration: null, position: 0 });
  assert.equal(spanOf(fx.activity()), 200, "the next cold rebuild reuses it");
});

test("a different confirmed ID always gets its own live total", async () => {
  const fx = fakeChrome({ [KEY]: remembered() });
  await fx.start();

  fx.feed({ mediaId: OTHER, trackUrl: OTHER_WATCH, pageUrl: OTHER_WATCH, duration: 200, position: 0 });
  assert.equal(spanOf(fx.activity()), 200, "a new identity uses its own live total");
  assert.equal(fx.state.local[TOTALS_KEY][OTHER_KEY].total, 200, "the new identity is cached on its own key");
  assert.equal(fx.state.local[TOTALS_KEY][KEY].total, 1088, "the other track's total is untouched");
});

test("a stale read without a measured playhead gains no timestamps and changes no cache", async () => {
  const fx = fakeChrome({ [KEY]: remembered() });
  await fx.start();

  fx.feed({ duration: null, position: 30 });
  assert.ok(fx.activity()?.timestamps, "the measured mid-track read is timed");

  // No playhead at all is never a fresh play: no pair may be invented and the
  // remembered total stays authoritative for the card when a head returns.
  fx.feed({ duration: 200, position: null });
  assert.equal("timestamps" in (fx.activity() ?? {}), false, "no playhead means no invented timestamps");
  assert.equal(fx.state.local[TOTALS_KEY][KEY].total, 1088, "the stale read cannot overwrite the cache");

  fx.clock.t += 10;
  fx.feed({ duration: null, position: 31 });
  assert.equal(spanOf(fx.activity()), 1088, "the remembered total is still the outgoing total");
});
