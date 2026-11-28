// The JSON-LD branch of readUnsafe is the only one that can return a total
// with no playhead on a cold playing read. No playhead is invented there;
// every measured timing source must win and a conflict must yield nothing.
// Pure vm sandbox: no browser, no network, no audio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("..", import.meta.url));
const code = readFileSync(join(dir, "extract-youtube.js"), "utf8");

const LOC = { href: "https://music.youtube.com/watch?v=abcdefghijk" };
const LD = {
  "@type": "VideoObject",
  name: "Cold Song",
  duration: "PT2M47S",
};

/** A fake document: only the selectors the extractor uses need to exist. */
function fakeDoc(overrides = {}) {
  const nodes = Object.assign(
    {
      'script[type="application/ld+json"]': [{ textContent: JSON.stringify(LD) }],
      "ytmusic-player-bar *": [],
      "#progress-bar": null,
      "input.ytMusicMiniPlayerProgressBar": null,
    },
    overrides
  );
  return {
    visibilityState: "visible",
    title: "Cold Song - YouTube Music",
    querySelector(selector) {
      const found = nodes[selector];
      return found && !Array.isArray(found) ? found : null;
    },
    querySelectorAll(selector) {
      const key = Array.isArray(selector) ? selector.join(",") : selector;
      const found = nodes[key];
      return Array.isArray(found) ? found : [];
    },
  };
}

function read(doc, playbackState = "playing") {
  const ctx = createContext({
    console,
    JSON,
    Math,
    String,
    Number,
    Boolean,
    Object,
    Array,
    isFinite,
    RegExp,
    Date,
  });
  runInContext(code, ctx);
  const nav = { mediaSession: { playbackState, metadata: null } };
  return ctx.YoutubeExtract.read(doc, nav, LOC);
}

test("a cold playing read with only JSON-LD timing keeps an unpaired total", () => {
  const state = read(fakeDoc());
  assert.equal(state.duration, 167, "the JSON-LD total is finite");
  assert.ok(Number.isFinite(state.duration), "duration is a number");
  assert.equal(state.position, null, "an unmeasured playhead stays unknown");
  assert.equal(state.paused, false, "MediaSession says playing");
});

test("a real position is never overwritten by the cold-start fallback", () => {
  const bar = { getAttribute: (name) => (name === "aria-valuenow" ? "30" : "167") };
  const state = read(fakeDoc({ "#progress-bar": bar }));
  assert.equal(state.duration, 167);
  assert.equal(state.position, 30, "the progress bar wins");
});

test("a paused read gets no position", () => {
  const state = read(fakeDoc(), "paused");
  assert.equal(state.duration, 167);
  assert.equal(state.position, null, "a paused track is not implicitly at its start");
});

test("a conflicting clock still yields nothing", () => {
  const doc = fakeDoc({
    "ytmusic-player-bar .time": [
      { textContent: "0:30 / 2:47" },
      { textContent: "0:31 / 2:47" },
    ],
  });
  const state = read(doc);
  assert.equal(state.duration, null, "a disagreement is not an absent clock");
  assert.equal(state.position, null, "a conflict never pins a start");
});

test("a real playhead is clamped inside the total (clamp invariant)", () => {
  const video = {
    duration: 167, currentTime: 300, paused: false, playbackRate: 1,
    currentSrc: "https://music.youtube.com/audio",
  };
  // readVideoEntries queries the whole selector list as one comma-joined string.
  const VIDEO_SELECTORS = "#movie_player video.html5-main-video,video.html5-main-video,video,audio";
  const state = read(fakeDoc({ [VIDEO_SELECTORS]: [video] }));
  assert.equal(state.duration, 167);
  assert.equal(state.position, 167, "a measured overrun clamps to the total");
  assert.ok(state.position <= state.duration, "position never exceeds duration");
});
