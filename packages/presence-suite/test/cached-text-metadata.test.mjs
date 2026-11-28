// Warm text metadata: the worker fills only missing text for the exact current
// YouTube Music video ID, never art/links, and never invents an elapsed time.
// Red-first: every assertion here is about the outgoing native-port payload.
// No browser, no network, no audio, no live playback.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createWorker } from "../background.js";
import { CLOCK_DETAILED, SETTINGS_KEY, SOURCE_YOUTUBE_MUSIC, TOTALS_KEY } from "../config.js";

const BASE = 1_700_000_000_000;
const ID = "aaaaaaaaaaa";
const OTHER = "bbbbbbbbbbb";
const WATCH_URL = "https://music.youtube.com/watch?v=" + ID;
const OTHER_URL = "https://music.youtube.com/watch?v=" + OTHER;
const KEY = SOURCE_YOUTUBE_MUSIC + "|" + ID;
const ART = "https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg";

/** Same fake-chrome shape cold-start-total.test.mjs drives, injectable clock. */
function fakeChrome(seedTotals) {
  const clock = { t: BASE };
  const timers = [];
  let nextHandle = 1;
  // The seek/total assertions below are detailed-mode behaviour.
  const state = {
    local: { [TOTALS_KEY]: seedTotals, [SETTINGS_KEY]: { clock: CLOCK_DETAILED } },
    session: {},
  };
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
      local: area("local"),
      session: area("session"),
      onChanged: { addListener() {} },
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
    api, state, clock, port, worker,
    activityOf() { return port.posts.filter((m) => m.t === "activity").at(-1)?.activity ?? null; },
    postsOf() { return port.posts.filter((m) => m.t === "activity"); },
  };
}

function warm(extra = {}) {
  return {
    total: 1088, at: BASE - 1000, plays: 1,
    title: "Warm Song", channel: "Warm Artist", album: "Warm Album",
    views: "1.2K views",
    ...extra,
  };
}

/** A cold replay sample: identity is confirmed, text and timing are not live yet. */
function replay(extra = {}) {
  return {
    title: null, channel: null, album: null, views: null, artworkUrl: null,
    artistUrl: null, albumUrl: null,
    mediaId: ID, trackUrl: WATCH_URL, pageUrl: WATCH_URL,
    paused: false, duration: null, position: null, playbackRate: 1,
    ...extra,
  };
}

function sendYoutube(worker, state, url = WATCH_URL) {
  worker.handleState(
    { t: "presence-state", source: SOURCE_YOUTUBE_MUSIC, state },
    { id: "extension-under-test", frameId: 0, url, tab: { id: 7, url } }
  );
}

test("a warm exact-ID cache fills text before live metadata, with no invented elapsed", async () => {
  const fx = fakeChrome({ [KEY]: warm() });
  await fx.worker.start();
  sendYoutube(fx.worker, replay());

  const card = fx.activityOf();
  assert.ok(card, "the first card goes out from the warm cache");
  assert.equal(card.details, "Warm Song", "title is filled");
  assert.equal(card.state, "Warm Artist", "artist is filled");
  assert.equal(card.assets, undefined, "no art is invented with the text");
  assert.equal("timestamps" in card, false, "no playhead means no timer");
});

test("live artwork is used on a warm card and cached text fills the tooltip", async () => {
  const fx = fakeChrome({ [KEY]: warm() });
  await fx.worker.start();
  sendYoutube(fx.worker, replay({ artworkUrl: ART }));

  const card = fx.activityOf();
  assert.equal(card.assets?.large_image, ART, "art comes only from live state");
  assert.equal(card.assets?.large_text, "Warm Album", "cached album is the tooltip");
});

test("cold, unknown and mismatched IDs cannot borrow cached text", async () => {
  const cold = fakeChrome({});
  await cold.worker.start();
  sendYoutube(cold.worker, replay({ title: "Live Song" }));
  assert.equal(cold.activityOf()?.details, "Live Song", "nothing to borrow stays live-only");
  assert.equal("timestamps" in cold.activityOf(), false);

  const other = fakeChrome({
    [KEY]: warm(), [SOURCE_YOUTUBE_MUSIC + "|" + OTHER]: warm({ title: "Other Song" }),
  });
  await other.worker.start();
  const different = replay({ title: null, mediaId: OTHER, trackUrl: OTHER_URL, pageUrl: OTHER_URL });
  sendYoutube(other.worker, different, OTHER_URL);
  assert.equal(other.activityOf()?.details, "Other Song", "a different ID borrows only its own text");
  assert.notEqual(other.activityOf()?.details, "Warm Song", "the first ID's text never crosses over");

  const mismatch = fakeChrome({ [KEY]: warm() });
  await mismatch.worker.start();
  // The page URL names A while the player bar names B: the ID is not confirmed.
  sendYoutube(mismatch.worker, replay({ title: null, trackUrl: OTHER_URL }));
  assert.equal(mismatch.activityOf(), null, "a stale page ID cannot borrow A's text");
});

test("partial live details override only the fields they own", async () => {
  const fx = fakeChrome({ [KEY]: warm() });
  await fx.worker.start();
  sendYoutube(fx.worker, replay({ title: "Live Title", artworkUrl: ART }));

  let card = fx.activityOf();
  assert.equal(card.details, "Live Title", "live title wins");
  assert.equal(card.state, "Warm Artist", "untouched artist stays warm");
  assert.equal(card.assets?.large_text, "Warm Album", "untouched album stays warm");

  fx.clock.t += 10;
  sendYoutube(fx.worker, replay({ title: "Live Title", channel: "Live Artist", artworkUrl: ART }));
  card = fx.activityOf();
  assert.equal(card.details, "Live Title");
  assert.equal(card.state, "Live Artist", "live artist wins when it arrives");
  assert.equal(card.assets?.large_text, "Warm Album", "album is still the warm one");
});

test("late seek positions are used directly; a real zero still gets a full timer", async () => {
  const fx = fakeChrome({ [KEY]: warm() });
  await fx.worker.start();
  sendYoutube(fx.worker, replay({ title: "Live Song" }));
  assert.equal("timestamps" in fx.activityOf(), false, "no cached playhead is invented");

  fx.clock.t += 10;
  sendYoutube(fx.worker, replay({ title: "Live Song", position: 513 }));
  let card = fx.activityOf();
  assert.equal(Math.floor(BASE / 1000) - card.timestamps.start, 513, "the seek is stamped at 8:33");
  assert.equal(card.timestamps.end - card.timestamps.start, 1088, "the remembered total pairs with it");

  fx.clock.t += 10;
  sendYoutube(fx.worker, replay({ title: "Live Song", position: 0 }));
  card = fx.activityOf();
  assert.equal(Math.floor((BASE + 20) / 1000) - card.timestamps.start, 0, "real zero starts at 0:00");
  assert.equal(card.timestamps.end - card.timestamps.start, 1088);
});

test("a title-only to timed upgrade adds no entry or extra play, and persists no art or links", async () => {
  const fx = fakeChrome({ [KEY]: warm() });
  await fx.worker.start();
  sendYoutube(fx.worker, replay({ title: "Live Title", artworkUrl: ART, channel: "New Artist" }));
  assert.equal("timestamps" in fx.activityOf(), false);
  assert.deepEqual(Object.keys(fx.state.local[TOTALS_KEY]), [KEY], "no second entry");
  assert.equal(fx.state.local[TOTALS_KEY][KEY].plays, 1, "no play while untimed");

  fx.clock.t += 10;
  sendYoutube(fx.worker, replay({ title: "Live Title", artworkUrl: ART, channel: "New Artist", duration: 1088, position: 30 }));
  assert.ok(fx.activityOf().timestamps, "the timed upgrade publishes a full timer");
  const records = fx.state.local[TOTALS_KEY];
  assert.deepEqual(Object.keys(records), [KEY], "still one entry");
  assert.equal(records[KEY].plays, 2, "one new play for the new timed session");
  assert.equal(records[KEY].title, "Live Title", "live text is persisted under the same ID");
  assert.equal(records[KEY].channel, "New Artist");
  for (const forbidden of ["artworkUrl", "artistUrl", "albumUrl", "image", "large_image", "src"]) {
    assert.equal(Object.hasOwn(records[KEY], forbidden), false, forbidden + " is never persisted");
  }

  fx.clock.t += 10;
  sendYoutube(fx.worker, replay({ title: "Live Title", artworkUrl: ART, channel: "New Artist", duration: 1088, position: 40 }));
  assert.equal(records[KEY].plays, 2, "a same-session rebuild is not a second play");
});

test("paused tabs never publish a warm card", async () => {
  const fx = fakeChrome({ [KEY]: warm() });
  await fx.worker.start();
  sendYoutube(fx.worker, replay({ title: "Live Song", paused: true }), WATCH_URL);
  assert.equal(fx.activityOf(), null, "paused is ineligible even with a warm cache");
});
