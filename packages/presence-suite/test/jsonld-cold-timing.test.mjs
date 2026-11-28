// A cold playing YTM read whose only total is JSON-LD must not invent a
// playhead. The bar can appear mid-track later; that measured pair is the
// first timer. Loads both real classic scripts in one vm sandbox, so the
// outgoing state is what the extractor and content script actually produce.
// No browser, no network, no audio, no live playback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildActivity } from "../activity.js";

const dir = fileURLToPath(new URL("..", import.meta.url));
const extractCode = readFileSync(join(dir, "extract-youtube.js"), "utf8");
const contentCode = readFileSync(join(dir, "content.js"), "utf8");

const NOW = 1_700_000_000_000;
const LOC = { href: "https://music.youtube.com/watch?v=aaaaaaaaaaa" };
/** PT18M8S is 1088 seconds — the 18:08 total in the hold candidate. */
const LD = { "@type": "VideoObject", name: "Mid Song", duration: "PT18M8S" };

function progressBar(position, total) {
  return {
    getAttribute(name) {
      if (name === "aria-valuenow") return String(position);
      if (name === "aria-valuemax") return String(total);
      return null;
    },
  };
}

function harness(bar = null) {
  const nodes = {
    'script[type="application/ld+json"]': [{ textContent: JSON.stringify(LD) }],
    "ytmusic-player-bar *": [],
    "#progress-bar": bar,
    "input.ytMusicMiniPlayerProgressBar": null,
  };
  const listeners = Object.create(null);
  const doc = {
    readyState: "complete",
    visibilityState: "visible",
    title: "Mid Song - YouTube Music",
    querySelector(selector) {
      const found = nodes[selector];
      return found && !Array.isArray(found) ? found : null;
    },
    querySelectorAll(selector) {
      const found = nodes[selector];
      return Array.isArray(found) ? found : [];
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
  };
  const sent = [];
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, cb) { sent.push(message); if (cb) cb(); },
    },
    storage: {
      local: { get: (_keys, cb) => cb({ enabled: { "youtube-music": true } }) },
      onChanged: { addListener() {} },
    },
  };
  const ctx = createContext({
    console, JSON, Math, String, Number, Boolean, Object, Array, isFinite, RegExp,
    parseInt, parseFloat,
    Date: { now: () => NOW },
    document: doc,
    window: { addEventListener() {} },
    chrome,
    navigator: { mediaSession: { playbackState: "playing", metadata: null } },
    location: LOC,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
  });
  runInContext("globalThis.top = globalThis", ctx);
  runInContext(extractCode, ctx);
  runInContext(contentCode, ctx);

  const last = () => sent[sent.length - 1];
  return {
    sent,
    last,
    activity: () => buildActivity(last().state, NOW),
    setProgress: (position, total) => { nodes["#progress-bar"] = progressBar(position, total); },
    fire: (type, event) => (listeners[type] || []).forEach((fn) => fn(event)),
  };
}

test("an unknown playhead with a JSON-LD total publishes metadata with no timer", () => {
  const h = harness();
  assert.equal(h.sent.length, 1, "boot publishes the cold card");
  const state = h.last().state;
  assert.equal(state.duration, 1088, "the JSON-LD total still goes out");
  assert.equal(state.position, null, "no measured playhead was reported");
  assert.equal(state.paused, false, "MediaSession says playing");
  assert.equal("timestamps" in h.activity(), false, "no invented 0:00 timer");
});

test("a measured mid-track playhead is the first valid outgoing pair", () => {
  const h = harness();
  assert.equal("timestamps" in h.activity(), false, "the cold card is untimed");

  h.setProgress(513, 1088);
  h.fire("play", { type: "play", target: { tagName: "VIDEO" } });

  assert.equal(h.sent.length, 2, "the measured read is published");
  const state = h.last().state;
  assert.equal(state.duration, 1088, "the total is the real one");
  assert.equal(state.position, 513, "the measured 8:33 playhead wins");
  const activity = h.activity();
  assert.ok(activity.timestamps, "the first valid pair goes out now");
  assert.equal(Math.floor(NOW / 1000) - activity.timestamps.start, 513, "start stamps 513 s ago");
  assert.equal(activity.timestamps.end - activity.timestamps.start, 1088, "the full 18:08 span");
});

test("a real zero playhead still gets the full timer", () => {
  const h = harness(progressBar(0, 1088));
  const state = h.last().state;
  assert.equal(state.position, 0, "zero here is measured, not invented");
  assert.equal(state.duration, 1088);
  const activity = h.activity();
  assert.ok(activity.timestamps, "a measured start is pairable");
  assert.equal(Math.floor(NOW / 1000) - activity.timestamps.start, 0, "starts at 0:00");
  assert.equal(activity.timestamps.end - activity.timestamps.start, 1088, "full 18:08 span");
});
