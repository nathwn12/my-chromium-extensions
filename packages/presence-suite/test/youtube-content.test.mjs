// Proves the timeupdate gate added to content.js: a steady playhead costs no
// extractor read, a backward jump still reads and reports, and a non-media
// target is ignored. Revert the gate in content.js and test 1 goes red.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("..", import.meta.url));
const code = readFileSync(join(dir, "content.js"), "utf8");

function add(map, type, fn) {
  (map[type] = map[type] || []).push(fn);
}

function harness() {
  const listeners = Object.create(null);
  const windowListeners = Object.create(null);
  const sent = [];
  let reads = 0;
  let state = { title: "Song", paused: false, position: 10, duration: 200, playbackRate: 1 };

  const doc = {
    readyState: "complete",
    visibilityState: "visible",
    addEventListener: (type, fn) => add(listeners, type, fn),
  };
  const win = { addEventListener: (type, fn) => add(windowListeners, type, fn) };
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage: (message, cb) => {
        sent.push(message);
        if (cb) cb();
      },
    },
    storage: {
      local: { get: (_keys, cb) => cb({ enabled: { "youtube-music": true } }) },
      onChanged: { addListener: () => {} },
    },
  };

  const ctx = createContext({
    document: doc,
    window: win,
    chrome,
    navigator: {},
    location: { href: "https://music.youtube.com/watch?v=abcdefghijk" },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    console,
    Date,
    JSON,
    Math,
    String,
    Number,
    Boolean,
    Object,
    Array,
    isFinite,
    YoutubeExtract: {
      read: () => {
        reads += 1;
        return Object.assign({}, state);
      },
      sourceForLocation: () => "youtube-music",
      mediaSourceOf: () => null,
      clockAgreesOf: () => false,
    },
  });
  runInContext("globalThis.top = globalThis", ctx);
  runInContext(code, ctx);

  return {
    sent,
    reads: () => reads,
    setState: (next) => { state = next; },
    fire: (type, event) => (listeners[type] || []).forEach((fn) => fn(event)),
  };
}

test("a steady playhead costs no extractor read", () => {
  const h = harness();
  assert.equal(h.sent.length, 1, "boot report");
  const reads = h.reads();
  for (const at of [10.2, 10.6, 11.0, 11.4, 11.8, 12.2]) {
    h.fire("timeupdate", { type: "timeupdate", target: { tagName: "VIDEO", currentTime: at } });
  }
  assert.equal(h.reads(), reads, "no read on a steady or forward playhead");
  assert.equal(h.sent.length, 1, "no send on a steady playhead");
});

test("a backward jump still reads and reports", () => {
  const h = harness();
  const reads = h.reads();
  h.setState({ title: "Song", paused: false, position: 2, duration: 200, playbackRate: 1 });
  h.fire("timeupdate", { type: "timeupdate", target: { tagName: "VIDEO", currentTime: 2 } });
  assert.equal(h.reads(), reads + 1, "one read after the jump");
  assert.equal(h.sent.length, 2, "the jump is published");
});

test("a non-media target is ignored", () => {
  const h = harness();
  const reads = h.reads();
  h.fire("timeupdate", { type: "timeupdate", target: { tagName: "DIV", currentTime: 0 } });
  assert.equal(h.reads(), reads);
});
import { buildActivity } from "../activity.js";

/**
 * A second harness with a fake wall clock: the predicted playhead is exact,
 * not racy, and every read is an explicit state the test supplies.
 */
function timingHarness(initial) {
  const listeners = Object.create(null);
  const windowListeners = Object.create(null);
  const sent = [];
  let nowMs = 1700000000000;
  let state = initial;
  let sourceOf = () => null;
  let agrees = () => false;

  const doc = {
    readyState: "complete",
    visibilityState: "visible",
    addEventListener: (type, fn) => add(listeners, type, fn),
  };
  const win = { addEventListener: (type, fn) => add(windowListeners, type, fn) };
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage: (message, cb) => { sent.push(message); if (cb) cb(); },
    },
    storage: {
      local: { get: (_keys, cb) => cb({ enabled: { "youtube-music": true } }) },
      onChanged: { addListener: () => {} },
    },
  };

  const ctx = createContext({
    document: doc,
    window: win,
    chrome,
    navigator: {},
    location: { href: "https://music.youtube.com/watch?v=aaaaaaaaaaa" },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    console,
    Date: { now: () => nowMs },
    JSON, Math, String, Number, Boolean, Object, Array, isFinite,
    YoutubeExtract: {
      read: () => Object.assign({}, state),
      sourceForLocation: () => "youtube-music",
      mediaSourceOf: () => sourceOf(),
      clockAgreesOf: () => agrees(),
    },
  });
  runInContext("globalThis.top = globalThis", ctx);
  runInContext(code, ctx);

  const last = () => sent[sent.length - 1];
  return {
    sent,
    last,
    setState: (next) => { state = next; },
    setSource: (fn) => { sourceOf = fn; },
    setAgrees: (fn) => { agrees = fn; },
    advance: (ms) => { nowMs += ms; },
    fire: (type, event) => (listeners[type] || []).forEach((fn) => fn(event)),
    fireWindow: (type, event) => (windowListeners[type] || []).forEach((fn) => fn(event)),
    activity: () => buildActivity(last().state, nowMs),
  };
}

const play = { type: "play", target: { tagName: "VIDEO" } };
const songA = {
  title: "Alpha", channel: "Artist", trackUrl: "https://music.youtube.com/watch?v=aaaaaaaaaaa",
  mediaId: "aaaaaaaaaaa", paused: false, position: 10, duration: 200, playbackRate: 1,
};
const songB = {
  title: "Beta", channel: "Artist", trackUrl: "https://music.youtube.com/watch?v=bbbbbbbbbbb",
  mediaId: "bbbbbbbbbbb", paused: false, position: 2, duration: 2, playbackRate: 1,
};

test("collapsed shrink on the same track keeps the credited total and bar", () => {
  const h = timingHarness(songA);
  assert.equal(h.sent.length, 1, "boot publishes the timed sample");
  assert.equal(h.last().state.duration, 200);

  h.advance(3000);
  h.setState({ ...songA, position: 2, duration: 2 });
  h.fire("play", play);

  assert.equal(h.sent.length, 2);
  const out = h.last().state;
  assert.equal(out.duration, 200, "a collapsed clock does not erase the credited total");
  assert.equal(out.position, 13, "playhead predicted from the last timed sample");
  const activity = h.activity();
  assert.ok(activity.timestamps, "the withheld read still publishes a bar");
  assert.equal(activity.timestamps.end - activity.timestamps.start, 200, "same total on the wire");
});

test("pendingTiming release hold on the same track keeps the credited total", () => {
  const h = timingHarness(songA);
  assert.equal(h.last().state.duration, 200);

  h.fireWindow("pagehide", { type: "pagehide" });
  assert.equal(h.last().t, "presence-gone", "the blank page armed the hold");

  h.advance(3000);
  h.setState({ ...songA, position: 60, duration: 200 });
  h.fire("play", play);

  const out = h.last().state;
  assert.equal(out.duration, 200, "the hold cannot strip the bar of its own track");
  assert.equal(out.position, 13, "the hold predicts the running playhead");
  const activity = h.activity();
  assert.ok(activity.timestamps, "the pendingTiming hold still publishes a bar");
  assert.equal(activity.timestamps.end - activity.timestamps.start, 200, "same total on the wire");
});

test("clock-only handover on a new track stays unpaired and keeps the baseline", () => {
  const h = timingHarness(songA);
  assert.equal(h.last().state.duration, 200);

  h.advance(3000);
  h.setState(songB);
  h.fire("play", play);

  const out = h.last().state;
  assert.equal(out.duration, null, "a new identity never borrows the old total");
  assert.equal(out.position, null);
  assert.equal(h.activity().timestamps, undefined, "no bar for an uncredited new track");

  h.advance(1000);
  h.setState({ ...songB, position: 3, duration: 180 });
  h.fire("play", play);
  assert.equal(h.last().state.duration, 180, "the withheld read did not corrupt the baseline");
});

test("a predicted playhead clamps at duration - 1 (repeat boundary)", () => {
  const nearEnd = { ...songA, position: 179, duration: 180 };
  const h = timingHarness(nearEnd);
  assert.equal(h.last().state.duration, 180);

  h.advance(60000);
  h.setState({ ...nearEnd, position: 2, duration: 2 });
  h.fire("play", play);

  const out = h.last().state;
  assert.equal(out.duration, 180);
  assert.equal(out.position, 179, "clamped to the repeat boundary");
  assert.ok(out.position < out.duration, "position stays strictly inside the total");
});

test("a predicted playhead never goes negative", () => {
  const start = { ...songA, position: 0, duration: 180 };
  const h = timingHarness(start);
  assert.equal(h.last().state.duration, 180);

  h.advance(-10000);
  h.setState({ ...start, position: 2, duration: 2 });
  h.fire("play", play);

  const out = h.last().state;
  assert.equal(out.position, 0, "a backwards clock still clamps at zero");
  assert.ok(out.position >= 0);
});

test("the prediction uses a finite positive playback rate", () => {
  const fast = { ...songA, playbackRate: 2 };
  const h = timingHarness(fast);
  h.advance(3000);
  h.setState({ ...fast, position: 2, duration: 2, playbackRate: 2 });
  h.fire("play", play);
  assert.equal(h.last().state.position, 16, "2x advances the predicted head twice as far");
});
