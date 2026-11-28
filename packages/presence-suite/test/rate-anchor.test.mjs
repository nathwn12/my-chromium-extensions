import { test } from "node:test";
import assert from "node:assert/strict";

import { isRateScaled, rateBiasMs, sampleAt, createWorker } from "../background.js";
import { SOURCE_YOUTUBE_MUSIC } from "../config.js";

const BASE = 1_700_000_000_000;
const WATCH_URL = "https://music.youtube.com/watch?v=abc12345678";

/** Same fake chrome as the worker tests, with a fixed injectable sample clock. */
function fakeWorker() {
  const clock = { t: BASE };
  const port = {
    posts: [],
    onMessage: { addListener() {}, removeListener() {} },
    onDisconnect: { addListener() {}, removeListener() {} },
    postMessage(message) { this.posts.push(message); },
    disconnect() {},
  };
  const area = () => ({
    async get() { return {}; },
    async set() {},
  });
  const api = {
    runtime: {
      id: "extension-under-test",
      connectNative: () => port,
      onMessage: { addListener() {} },
    },
    storage: { local: area(), session: area(), onChanged: { addListener() {} } },
    alarms: { create() {}, get() { return null; }, onAlarm: { addListener() {} } },
    tabs: { onRemoved: { addListener() {} } },
  };
  const worker = createWorker({
    chrome: api,
    now: () => clock.t,
    schedule: () => 1,
    cancel() {},
  });
  return { worker, port, clock };
}

function musicState(extra = {}) {
  return {
    title: "A Song",
    channel: "An Artist",
    album: "An Album",
    artworkUrl: "https://lh3.googleusercontent.com/cover",
    mediaId: "rate-track",
    paused: false,
    duration: 207,
    position: 10,
    ...extra,
  };
}

async function frameAt(offsetMs, extra = {}) {
  const fx = fakeWorker();
  await fx.worker.start();
  fx.clock.t = BASE + offsetMs;
  fx.worker.handleState(
    { t: "presence-state", source: SOURCE_YOUTUBE_MUSIC, state: musicState(extra) },
    { id: "extension-under-test", frameId: 0, url: WATCH_URL, tab: { id: 7, url: WATCH_URL } }
  );
  return fx.port.posts.filter((message) => message.t === "activity").at(-1).activity;
}

test("rate helpers classify only a real non-1x rate", () => {
  assert.equal(isRateScaled({ playbackRate: 1.5 }), true);
  assert.equal(isRateScaled({ playbackRate: 1 }), false);
  assert.equal(isRateScaled({}), false);
  assert.equal(isRateScaled({ playbackRate: null }), false);
  assert.equal(isRateScaled({ playbackRate: "1.5" }), false);
});

test("rate bias is half an interval, clamped by what has played", () => {
  assert.equal(rateBiasMs({ playbackRate: 1.5 }), -625);
  assert.equal(rateBiasMs({ playbackRate: 0.75 }), 312.5);
  assert.equal(rateBiasMs({ playbackRate: 1 }), 0);
  assert.equal(rateBiasMs({}), 0);
  assert.equal(rateBiasMs({ playbackRate: 0.7, position: 0 }), 0, "0:00 never reads ahead");
  assert.ok(Math.abs(rateBiasMs({ playbackRate: 0.7, position: 1 }) - 375) < 1e-9);
});

test("sampleAt trusts a recent stamp but rejects a future one", () => {
  assert.equal(sampleAt({ state: { at: BASE }, at: BASE + 6000 }, BASE + 6000), BASE);
  assert.equal(sampleAt({ state: { at: BASE + 6000 }, at: BASE }, BASE), BASE);
  assert.equal(sampleAt({ state: {}, at: BASE + 10 }, BASE), BASE + 10);
  assert.equal(sampleAt(null, BASE), BASE);
});

test("at 1.5x the anchor is biased half an interval earlier", async () => {
  const activity = await frameAt(500, { playbackRate: 1.5, position: 10, duration: 200 });
  const unbiased = Math.floor((BASE + 500) / 1000) - 10;
  const biased = Math.floor((BASE + 500 - 625) / 1000) - 10;
  assert.equal(activity.timestamps.start, biased, "the builder sees the biased sample");
  assert.equal(biased - unbiased, -1, "625 ms earlier crosses one whole second here");
  assert.equal(activity.timestamps.end, biased + 200, "the span stays the real duration");
});

test("at 1x the outgoing frame is byte-identical and unbiased", async () => {
  const activity = await frameAt(123, { playbackRate: 1 });
  assert.deepEqual(activity, {
    name: "YouTube Music",
    type: 2,
    details: "A Song",
    state: "An Artist",
    status_display_type: 1,
    assets: {
      large_image: "https://lh3.googleusercontent.com/cover",
      large_text: "An Album",
    },
    timestamps: {
      start: Math.floor((BASE + 123) / 1000) - 10,
      end: Math.floor((BASE + 123) / 1000) - 10 + 207,
    },
  });
});

test("at 0.75x the anchor is biased later", async () => {
  const activity = await frameAt(800, { playbackRate: 0.75, position: 10 });
  const unbiased = Math.floor((BASE + 800) / 1000) - 10;
  assert.equal(activity.timestamps.start, Math.floor((BASE + 1112.5) / 1000) - 10);
  assert.ok(activity.timestamps.start > unbiased, "a slower rate starts later");
});

test("the total span stays 207 seconds at 0.70x, 1x and 1.30x", async () => {
  for (const rate of [0.7, 1, 1.3]) {
    const activity = await frameAt(123, { playbackRate: rate });
    assert.equal(activity.timestamps.end - activity.timestamps.start, 207, "span at " + rate + "x");
  }
});

test("a track at position zero reads 0:00 at every rate", async () => {
  for (const rate of [0.7, 1, 1.3]) {
    const activity = await frameAt(123, { playbackRate: rate, position: 0 });
    const sample = BASE + 123;
    assert.equal(Math.floor(sample / 1000) - activity.timestamps.start, 0, "0:00 at " + rate + "x");
  }
});
