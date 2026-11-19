import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const worker = await import(pathToFileURL(join(here, "..", "..", "background.js")).href);
const bgSource = readFileSync(join(here, "..", "..", "background.js"), "utf8");
const contentSource = readFileSync(join(here, "..", "..", "content.js"), "utf8");

const {
  buildActivity,
  createCoalescingLimiter,
  applyAckResult,
  applyGoneToEntry,
  isCrunchyrollPageUrl
} = worker;

const NOW = 1_700_000_000_000;
const base = (overrides = {}) => ({
  series: "Frieren: Beyond Journey's End",
  episodeTitle: "The Beginning",
  seasonNumber: 1,
  episodeNumber: 5,
  artworkUrl: "https://img.crunchyroll.com/ep5.jpg",
  duration: 1440,
  position: 754,
  paused: false,
  pageUrl: "https://www.crunchyroll.com/watch/G6VU774M5/the-beginning",
  ...overrides
});

test("limiter delivers a null clear payload", () => {
  const sent = [];
  const limiter = createCoalescingLimiter({ send: (v) => sent.push(v) });
  limiter.push(null);
  assert.deepEqual(sent, [null]);
  assert.equal(limiter.hasPending, false);
});

test("ack ok:false keeps bridge state and records lastError", () => {
  assert.equal(typeof applyAckResult, "function");
  const next = applyAckResult(
    { bridgeState: "connecting", lastError: null },
    { ok: false, error: "not connected" }
  );
  assert.equal(next.bridgeState, "connecting");
  assert.equal(next.lastError, "not connected");
  const connected = applyAckResult(
    { bridgeState: "connecting", lastError: "x" },
    { ok: true, appName: "Discord" }
  );
  assert.equal(connected.bridgeState, "connected");
});

test("background stashes offline payloads and flushes on status/ack", () => {
  assert.match(bgSource, /hasStashed/);
  assert.match(bgSource, /flushStashed/);
  assert.match(bgSource, /stashedActivity = activity/);
});

test("buildActivity timestamps are stable within one position second", () => {
  const a = buildActivity(base({ position: 754.1 }), NOW);
  const b = buildActivity(base({ position: 754.9 }), NOW + 400);
  assert.deepEqual(a.timestamps, b.timestamps);
  assert.deepEqual(a.timestamps, { start: NOW - 754_000, end: NOW + (1440 - 754) * 1000 });
});

test("buildActivity start is stable as position advances with the clock", () => {
  const a = buildActivity(base({ position: 10.2 }), NOW);
  const b = buildActivity(base({ position: 11.2 }), NOW + 1000);
  assert.equal(a.timestamps.start, b.timestamps.start);
});

test("applyGoneToEntry deletes the tab on tab-scoped gone", () => {
  assert.equal(typeof applyGoneToEntry, "function");
  const entry = {
    tabId: 9,
    top: { frameId: 0, series: "Frieren", receivedAt: 1000 },
    frames: { 1: { frameId: 1, hasVideo: true, receivedAt: 1000 } },
    pageUrl: "https://www.crunchyroll.com/watch/x",
    updatedAt: 1000
  };
  assert.equal(applyGoneToEntry(entry, 0, "tab", 2000), "delete");
  assert.equal(entry.updatedAt, 1000);
});

test("applyGoneToEntry drops only the top frame on frame-scoped gone", () => {
  const entry = {
    tabId: 9,
    top: { frameId: 0, series: "Frieren", receivedAt: 1000 },
    frames: { 1: { frameId: 1, hasVideo: true, receivedAt: 1000 } },
    pageUrl: "https://www.crunchyroll.com/watch/x",
    updatedAt: 1000
  };
  const out = applyGoneToEntry(entry, 0, "frame", 2000);
  assert.notEqual(out, "delete");
  assert.equal(entry.top, null);
  assert.ok(entry.frames[1]);
  assert.equal(entry.updatedAt, 1000);

  const last = applyGoneToEntry(entry, 1, "frame", 2000);
  assert.equal(last, "delete");
});

test("applyGoneToEntry drops one iframe frame without touching updatedAt", () => {
  const entry = {
    tabId: 9,
    top: { frameId: 0, series: "Frieren", receivedAt: 1000 },
    frames: {
      1: { frameId: 1, hasVideo: true, receivedAt: 1000 },
      2: { frameId: 2, hasVideo: true, receivedAt: 1000 }
    },
    pageUrl: "https://www.crunchyroll.com/watch/x",
    updatedAt: 1000
  };
  const out = applyGoneToEntry(entry, 1, "frame", 2000);
  assert.notEqual(out, "delete");
  assert.equal(entry.frames[1], undefined);
  assert.ok(entry.frames[2]);
  assert.equal(entry.updatedAt, 1000);
});

test("crunchyroll url predicate and tabs.onUpdated wiring", () => {
  assert.equal(isCrunchyrollPageUrl("https://www.crunchyroll.com/watch/G1"), true);
  assert.equal(isCrunchyrollPageUrl("https://crunchyroll.com/series/x"), true);
  assert.equal(isCrunchyrollPageUrl("https://example.com/"), false);
  assert.equal(isCrunchyrollPageUrl("not a url"), false);
  assert.match(bgSource, /onUpdated/);
  assert.match(bgSource, /isCrunchyrollPageUrl/);
});

test("watchdog checks for an existing alarm before creating", () => {
  assert.match(bgSource, /alarms\.get/);
});

test("limiter resetWindow releases a queued republish at once", () => {
  const sent = [];
  const scheduled = [];
  let now = 0;
  const limiter = createCoalescingLimiter({
    send: (v) => sent.push(v),
    max: 2,
    windowMs: 20000,
    now: () => now,
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms });
      return scheduled.length;
    }
  });
  limiter.push("a");
  assert.deepEqual(sent, ["a"]);
  limiter.push("b");
  assert.deepEqual(sent, ["a", "b"]);
  limiter.push("c");
  assert.deepEqual(sent, ["a", "b"]);
  assert.equal(scheduled.length, 1);
  limiter.resetWindow();
  assert.deepEqual(sent, ["a", "b", "c"]);
});

test("content script handles bfcache restore and paused keepalive", () => {
  assert.match(contentSource, /pageshow/);
  assert.match(contentSource, /KEEPALIVE_MS/);
  assert.match(contentSource, /lastReportAt/);
});

test("pause after a burst of position reports is delivered in the same tick", () => {
  assert.doesNotMatch(contentSource, /timeupdate/);
  const sent = [];
  const scheduled = [];
  let now = 0;
  const limiter = createCoalescingLimiter({
    send: (v) => sent.push(v),
    max: 4,
    windowMs: 20000,
    now: () => now,
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms });
      return scheduled.length;
    }
  });
  limiter.push({ paused: false, position: 10 });
  limiter.push({ paused: false, position: 20 });
  now = 500;
  limiter.push({ paused: true, position: 20 });
  assert.deepEqual(sent, [
    { paused: false, position: 10 },
    { paused: false, position: 20 },
    { paused: true, position: 20 }
  ]);
  assert.equal(scheduled.length, 0);
});

test("null clear after four rapid non-null updates is delivered immediately", () => {
  const sent = [];
  const scheduled = [];
  let now = 0;
  const limiter = createCoalescingLimiter({
    send: (v) => sent.push(v),
    max: 4,
    windowMs: 20000,
    now: () => now,
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms });
      return scheduled.length;
    }
  });
  for (const value of ["u1", "u2", "u3", "u4"]) limiter.push(value);
  assert.deepEqual(sent, ["u1", "u2", "u3", "u4"]);
  assert.equal(limiter.hasPending, false);
  limiter.push(null);
  assert.deepEqual(sent, ["u1", "u2", "u3", "u4", null]);
  assert.equal(limiter.hasPending, false);
  limiter.push("u5");
  assert.deepEqual(sent, ["u1", "u2", "u3", "u4", null]);
  assert.equal(limiter.pending, "u5");
  now = 20000;
  scheduled.shift().fn();
  assert.deepEqual(sent, ["u1", "u2", "u3", "u4", null, "u5"]);
});

test("a 1 Hz stream no longer fills the bucket (the old cadence is gone)", () => {
  assert.doesNotMatch(contentSource, /timeupdate/);
  assert.doesNotMatch(contentSource, /TIMUPDATE/);
  assert.match(contentSource, /KEEPALIVE_MS/);
  for (const name of [
    "loadedmetadata",
    "play",
    "pause",
    "seeking",
    "seeked",
    "ended",
    "ratechange"
  ]) {
    assert.match(contentSource, new RegExp(`"${name}"`));
  }
});
