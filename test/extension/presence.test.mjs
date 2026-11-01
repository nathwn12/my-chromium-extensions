import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// Load the worker as a module without a `chrome` global: the file guards every
// chrome.* call on `hasChrome`. background.js imports config.js, so it is
// imported by path rather than as a data: URL (which cannot resolve imports).
const worker = await import(
  pathToFileURL(join(here, "..", "..", "extension", "background.js")).href
);

const {
  buildActivity,
  formatStateLine,
  pickBestTab,
  pickButtonUrl,
  isEligible,
  clampText,
  clock,
  createCoalescingLimiter,
  mergeFrame,
  resolveTab
} = worker;

const NOW = 1_700_000_000_000;
const TAB_URL = "https://www.crunchyroll.com/watch/G6VU774M5/the-beginning";

const playing = (overrides = {}) => ({
  series: "Frieren: Beyond Journey's End",
  episodeTitle: "The Beginning",
  seasonNumber: 1,
  episodeNumber: 5,
  artworkUrl: "https://img.crunchyroll.com/ep5.jpg",
  duration: 1440,
  position: 754,
  paused: false,
  pageUrl: TAB_URL,
  ...overrides
});

test("module loads without chrome and exposes only pure helpers", () => {
  assert.equal(worker.hasChrome, false);
  for (const fn of [buildActivity, formatStateLine, pickBestTab, pickButtonUrl, isEligible, clampText, clock]) {
    assert.equal(typeof fn, "function");
  }
});

test("full activity: WATCHING, capped text, artwork, button, timestamps while playing", () => {
  const activity = buildActivity(playing(), NOW);
  assert.deepEqual(activity, {
    type: 3,
    details: "Frieren: Beyond Journey's End",
    state: "S1 E5 · 12:34 / 24:00",
    assets: {
      large_image: "https://img.crunchyroll.com/ep5.jpg",
      large_text: "The Beginning"
    },
    buttons: [{ label: "Watch on Crunchyroll", url: TAB_URL }],
    timestamps: {
      start: NOW - 754_000,
      end: NOW + (1440 - 754) * 1000
    }
  });
});

test("paused playback carries no timestamps", () => {
  const activity = buildActivity(playing({ paused: true }), NOW);
  assert.equal(activity.timestamps, undefined);
  assert.equal(activity.state, "S1 E5 · 12:34 / 24:00");
});

test("unknown pause state never produces timestamps", () => {
  const activity = buildActivity(playing({ paused: null }), NOW);
  assert.equal(activity.timestamps, undefined);
});

test("no season/episode numbers collapses state to Crunchyroll", () => {
  const activity = buildActivity(playing({ seasonNumber: null, episodeNumber: null }), NOW);
  assert.equal(activity.state, "Crunchyroll");
});

test("episode number without season renders E<n> plus progress", () => {
  const activity = buildActivity(playing({ seasonNumber: null, episodeNumber: 12 }), NOW);
  assert.equal(activity.state, "E12 · 12:34 / 24:00");
});

test("numbers without a duration keep the short form", () => {
  assert.equal(formatStateLine({ seasonNumber: 2, episodeNumber: 7, duration: 0, position: 0 }), "S2 E7");
  assert.equal(formatStateLine({ seasonNumber: 2, episodeNumber: 7 }), "S2 E7");
  assert.equal(formatStateLine(null), "Crunchyroll");
});

test("details falls back to the episode title, then is absent without either", () => {
  const byEpisode = buildActivity(playing({ series: null }), NOW);
  assert.equal(byEpisode.details, "The Beginning");
  assert.equal(buildActivity({ seasonNumber: 1, episodeNumber: 1 }, NOW), null);
  assert.equal(buildActivity(null, NOW), null);
});

test("details, state and large_text are capped at 128 characters", () => {
  const activity = buildActivity(
    playing({ series: "S".repeat(300), episodeTitle: "E".repeat(300) }),
    NOW
  );
  assert.equal(activity.details.length, 128);
  assert.equal(activity.assets.large_text.length, 128);
  assert.ok(activity.state.length <= 128);
});

test("non-https artwork is dropped, and assets vanish with it", () => {
  const activity = buildActivity(playing({ artworkUrl: "http://img.crunchyroll.com/ep5.jpg" }), NOW);
  assert.equal(activity.assets, undefined);
});

test("button only for an https Crunchyroll URL", () => {
  assert.equal(buildActivity(playing({ pageUrl: "http://www.crunchyroll.com/watch/G1" }), NOW).buttons, undefined);
  assert.equal(buildActivity(playing({ pageUrl: "https://evil.example/watch/G1" }), NOW).buttons, undefined);
  assert.equal(buildActivity(playing({ pageUrl: null }), NOW).buttons, undefined);
  assert.equal(pickButtonUrl(TAB_URL), TAB_URL);
  assert.equal(pickButtonUrl("https://crunchyroll.com/watch/G1"), "https://crunchyroll.com/watch/G1");
  assert.equal(pickButtonUrl("not a url"), null);
});

test("timestamps clamp a position past the end", () => {
  const activity = buildActivity(playing({ position: 9999, duration: 1440 }), NOW);
  assert.equal(activity.timestamps.start, NOW - 9_999_000);
  assert.equal(activity.timestamps.end, NOW);
});

test("pickBestTab prefers playing, then the most recent update", () => {
  const paused = { tabId: 1, paused: true, hasVideo: true, visible: true, updatedAt: 500 };
  const playingOld = { tabId: 2, paused: false, hasVideo: true, visible: false, updatedAt: 100 };
  const playingNew = { tabId: 3, paused: false, hasVideo: true, visible: true, updatedAt: 900 };
  assert.equal(pickBestTab({ a: paused, b: playingOld, c: playingNew }).tabId, 3);
  assert.equal(pickBestTab({ a: paused, b: playingOld }).tabId, 2);
  assert.equal(pickBestTab({ a: paused, b: { ...paused, tabId: 9, updatedAt: 800 } }).tabId, 9);
  assert.equal(pickBestTab({}), null);
});

test("isEligible keeps playing background tabs and live visible tabs", () => {
  assert.equal(isEligible({ hasVideo: true, paused: false, visible: false }), true);
  assert.equal(isEligible({ hasVideo: true, paused: true, visible: true }), true);
  assert.equal(isEligible({ hasVideo: true, paused: true, visible: false }), false);
  assert.equal(isEligible({ hasVideo: false, paused: false, visible: true }), false);
  assert.equal(isEligible(null), false);
});

test("clock and clampText edges", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(754), "12:34");
  assert.equal(clock(1440), "24:00");
  assert.equal(clock(3661), "1:01:01");
  assert.equal(clampText("  a   b  "), "a b");
  assert.equal(clampText(""), null);
  assert.equal(clampText(null), null);
  assert.equal(clampText("x".repeat(200)).length, 128);
});

test("top-frame metadata merged with the iframe video report", () => {
  // The watch page carries the JSON-LD metadata; the player iframe carries the
  // video. Neither frame alone can build the activity.
  const entry = { tabId: 42, top: null, frames: {}, pageUrl: TAB_URL, updatedAt: 0 };

  mergeFrame(
    entry,
    {
      frameId: 0,
      series: "Frieren: Beyond Journey's End",
      episodeTitle: "The Beginning",
      seasonNumber: 1,
      episodeNumber: 5,
      artworkUrl: "https://img.crunchyroll.com/ep5.jpg",
      hasVideo: false,
      paused: null,
      position: null,
      duration: null,
      visible: true,
      signals: ["jsonLd"]
    },
    1000
  );

  mergeFrame(
    entry,
    {
      frameId: 3,
      hasVideo: true,
      paused: false,
      position: 754,
      duration: 1440,
      playbackRate: 1,
      signals: ["video"]
    },
    1200
  );

  const merged = resolveTab(entry, 1300);
  assert.equal(merged.series, "Frieren: Beyond Journey's End");
  assert.equal(merged.episodeTitle, "The Beginning");
  assert.equal(merged.position, 754);
  assert.equal(merged.hasVideo, true);
  assert.equal(merged.pageUrl, TAB_URL);
  assert.deepEqual(merged.signals, ["jsonLd", "video"]);

  const activity = buildActivity(merged, NOW);
  assert.equal(activity.details, "Frieren: Beyond Journey's End");
  assert.equal(activity.state, "S1 E5 · 12:34 / 24:00");
  assert.deepEqual(activity.assets, {
    large_image: "https://img.crunchyroll.com/ep5.jpg",
    large_text: "The Beginning"
  });
  assert.deepEqual(activity.timestamps, {
    start: NOW - 754_000,
    end: NOW + (1440 - 754) * 1000
  });
});

test("losing the video frame drops the tab to ineligible activity", () => {
  const entry = { tabId: 7, top: null, frames: {}, pageUrl: TAB_URL, updatedAt: 0 };
  mergeFrame(entry, { frameId: 0, series: "Frieren", hasVideo: false, visible: true, signals: ["jsonLd"] }, 20_000);
  mergeFrame(entry, { frameId: 2, hasVideo: true, paused: false, position: 10, duration: 100 }, 20_000);

  const fresh = resolveTab(entry, 30_000);
  assert.equal(fresh.hasVideo, true);
  assert.equal(isEligible(fresh), true);

  // The top frame keeps reporting metadata; the player frame stopped 130s ago.
  mergeFrame(entry, { frameId: 0, series: "Frieren", hasVideo: false, visible: true, signals: ["jsonLd"] }, 150_000);
  const stale = resolveTab(entry, 150_000);
  assert.equal(stale.hasVideo, false);
  assert.equal(stale.series, "Frieren");
  assert.equal(isEligible(stale), false);
  assert.equal(pickBestTab({ 7: stale }), null);
});

test("a crp-gone video frame is replaced by whatever frames remain", () => {
  const entry = { tabId: 9, top: null, frames: {}, pageUrl: TAB_URL, updatedAt: 0 };
  mergeFrame(entry, { frameId: 0, series: "Frieren", hasVideo: false, visible: true }, 1000);
  mergeFrame(entry, { frameId: 1, hasVideo: true, paused: false, duration: 100, position: 5 }, 1000);
  delete entry.frames[1];
  const merged = resolveTab(entry, 1100);
  assert.equal(merged.hasVideo, false);
  assert.equal(merged.series, "Frieren");
});

test("limiter allows 4 per 20s and coalesces the newest value", () => {
  const sent = [];
  const scheduled = [];
  let now = 0;
  const limiter = createCoalescingLimiter({
    send: (value) => sent.push(value),
    max: 4,
    windowMs: 20000,
    now: () => now,
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms });
      return scheduled.length;
    }
  });

  for (const value of ["a", "b", "c", "d", "e", "f", "g"]) limiter.push(value);
  assert.deepEqual(sent, ["a", "b", "c", "d"]);
  assert.equal(limiter.pending, "g");

  now = 20000;
  scheduled.shift().fn();
  assert.deepEqual(sent, ["a", "b", "c", "d", "g"]);

  limiter.push("h");
  assert.deepEqual(sent.at(-1), "h");
});
