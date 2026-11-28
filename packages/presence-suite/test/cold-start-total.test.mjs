import { test } from "node:test";
import assert from "node:assert/strict";

import { createWorker } from "../background.js";
import { SOURCE_CRUNCHY, SOURCE_YOUTUBE_MUSIC, TOTALS_KEY } from "../config.js";

const BASE = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WATCH_URL = "https://music.youtube.com/watch?v=abc12345678";

/** The same fake chrome shape background.test.mjs drives, with an injectable clock. */
function fakeChrome(seedTotals) {
  const clock = { t: BASE };
  const timers = [];
  const writes = [];
  let nextHandle = 1;
  const state = { local: { [TOTALS_KEY]: seedTotals }, session: {} };
  const area = (name) => ({
    async get(keys) {
      if (keys == null) return { ...state[name] };
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of list) if (key in state[name]) out[key] = state[name][key];
      return out;
    },
    async set(values) {
      writes.push({ area: name, values: { ...values } });
      Object.assign(state[name], values);
    },
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
    alarms: {
      create() {},
      get() { return null; },
      onAlarm: { addListener() {} },
    },
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
    api, state, clock, timers, writes, port, worker,
    flushTimers() {
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.at > clock.t) continue;
        const index = timers.findIndex((entry) => entry.handle === timer.handle);
        if (index < 0) continue;
        timers.splice(index, 1);
        timer.fn();
      }
    },
  };
}

function coldState(mediaId) {
  return {
    title: "Song Name",
    channel: "An Artist",
    paused: false,
    position: 0,
    duration: null,
    mediaId,
    pageUrl: WATCH_URL,
  };
}

function sendYoutube(worker, state) {
  worker.handleState(
    { t: "presence-state", source: SOURCE_YOUTUBE_MUSIC, state },
    { id: "extension-under-test", frameId: 0, url: WATCH_URL, tab: { id: 7, url: WATCH_URL } }
  );
}

const CRUNCHY_URL = "https://www.crunchyroll.com/watch/G6VU774M5/episode";

function crunchyState(extra = {}) {
  return {
    series: "Series Name",
    episodeTitle: "Episode Name",
    seasonNumber: 1,
    episodeNumber: 2,
    seriesUrl: "https://www.crunchyroll.com/series/G6VU774M5",
    episodeUrl: CRUNCHY_URL,
    hasVideo: true,
    paused: false,
    duration: 1200,
    position: 0,
    visible: true,
    ...extra,
  };
}

function sendCrunchy(worker, state) {
  worker.handleState(
    { t: "presence-state", source: SOURCE_CRUNCHY, state },
    { id: "extension-under-test", frameId: 0, url: CRUNCHY_URL, tab: { id: 8, url: CRUNCHY_URL } }
  );
}

function activityOf(port) {
  return port.posts.filter((message) => message.t === "activity").at(-1)?.activity ?? null;
}

function spanOf(activity) {
  return activity.timestamps ? activity.timestamps.end - activity.timestamps.start : null;
}

test("a cold playing sample borrows the remembered total for a timed first frame", async () => {
  const fx = fakeChrome({ "youtube-music|track-A": { total: 167.4, at: BASE - 1000 } });
  await fx.worker.start();
  sendYoutube(fx.worker, coldState("track-A"));

  const activity = activityOf(fx.port);
  assert.ok(activity?.timestamps, "the first frame carries a range");
  assert.equal(spanOf(activity), Math.floor(167.4), "the real total is shown, floored to seconds");
  assert.equal(Math.floor(BASE / 1000) - activity.timestamps.start, 0, "the live playhead stays at 0:00");
});

test("no cache fails closed and the first live total goes out without waiting", async () => {
  const fx = fakeChrome({});
  await fx.worker.start();
  sendYoutube(fx.worker, coldState("track-B"));
  assert.equal("timestamps" in activityOf(fx.port), false, "no total means no invented range");

  fx.clock.t += 10; // well inside the 1.5 s gap
  sendYoutube(fx.worker, { ...coldState("track-B"), duration: 200 });
  assert.equal(spanOf(activityOf(fx.port)), 200);
  assert.equal(
    fx.port.posts.filter((message) => message.t === "activity").length,
    2,
    "the newly timed card is urgent, not deferred"
  );
});

test("a remembered total is never borrowed across tracks", async () => {
  const fx = fakeChrome({ "youtube-music|track-A": { total: 167, at: BASE - 1000 } });
  await fx.worker.start();
  sendYoutube(fx.worker, coldState("track-C"));
  assert.equal("timestamps" in activityOf(fx.port), false, "a different mediaId gets no range");
});

test("a live total overwrites the cache and the next rebuild uses it", async () => {
  const key = "youtube-music|track-D";
  const fx = fakeChrome({ [key]: { total: 100, at: BASE - 1000 } });
  await fx.worker.start();

  sendYoutube(fx.worker, { ...coldState("track-D"), duration: 200 });
  assert.equal(spanOf(activityOf(fx.port)), 200, "the live read wins over the cached 100");

  fx.clock.t += 10;
  sendYoutube(fx.worker, coldState("track-D"));
  assert.equal(spanOf(activityOf(fx.port)), 200, "the next cold rebuild uses the live value");

  fx.flushTimers();
  assert.equal(fx.state.local[TOTALS_KEY][key].total, 200, "the updated value is persisted");
});

test("a five-year-old remembered total is still reused", async () => {
  const fx = fakeChrome({
    "youtube-music|track-E": { total: 167, at: BASE - 5 * 365 * DAY_MS, plays: 1 },
  });
  await fx.worker.start();
  sendYoutube(fx.worker, coldState("track-E"));
  assert.equal(spanOf(activityOf(fx.port)), 167, "there is no age prune at all");
});

test("relevance beats recency when the ceiling is reached", async () => {
  const seed = {};
  for (let i = 0; i < 998; i += 1) {
    seed["youtube-music|filler-" + i] = { total: 200, at: BASE, plays: 1 };
  }
  seed["youtube-music|stale-one-play"] = { total: 200, at: BASE - DAY_MS, plays: 1 };
  seed["youtube-music|six-plays-old"] = { total: 200, at: BASE - 200 * DAY_MS, plays: 6 };
  const fx = fakeChrome(seed);
  await fx.worker.start();

  fx.clock.t += 1000;
  sendYoutube(fx.worker, { ...coldState("new-arrival"), duration: 240 });

  const final = fx.state.local[TOTALS_KEY];
  assert.equal(Object.keys(final).length, 1000, "the cap still holds");
  assert.equal(
    "youtube-music|stale-one-play" in final,
    false,
    "one play from yesterday is the least relevant entry"
  );
  assert.equal(
    "youtube-music|six-plays-old" in final,
    true,
    "six plays from 200 days ago outrank one recent play"
  );
  assert.equal("youtube-music|new-arrival" in final, true, "the newcomer is kept");
});

test("plays count sessions, not rebuilds", async () => {
  const fx = fakeChrome({});
  const key = "youtube-music|track-S";
  const writeCount = () => fx.writes
    .filter((write) => write.area === "local" && write.values[TOTALS_KEY]).length;
  await fx.worker.start();

  sendYoutube(fx.worker, { ...coldState("track-S"), duration: 200 });
  assert.equal(fx.state.local[TOTALS_KEY][key].plays, 1, "the first session is one play");
  const afterFirst = writeCount();

  fx.clock.t += 2000;
  sendYoutube(fx.worker, { ...coldState("track-S"), duration: 200 });
  assert.equal(writeCount(), afterFirst, "a 2 s re-anchor only refreshes at");
  assert.equal(fx.state.local[TOTALS_KEY][key].plays, 1, "no extra play for the rebuild");

  fx.clock.t += 11 * 60 * 1000;
  sendYoutube(fx.worker, { ...coldState("track-S"), duration: 200 });
  assert.equal(fx.state.local[TOTALS_KEY][key].plays, 2, "an 11-minute gap is a new session");
  assert.equal(writeCount(), afterFirst + 1, "a play change writes immediately");
});

test("missing or junk play counts load as one", async () => {
  const fx = fakeChrome({
    "youtube-music|a": { total: 100, at: BASE },
    "youtube-music|b": { total: 100, at: BASE, plays: "junk" },
    "youtube-music|c": { total: 100, at: BASE, plays: 0 },
  });
  await fx.worker.start();
  sendYoutube(fx.worker, { ...coldState("fresh"), duration: 150 });
  const stored = fx.state.local[TOTALS_KEY];
  for (const key of ["youtube-music|a", "youtube-music|b", "youtube-music|c"]) {
    assert.equal(stored[key].plays, 1, key + " normalizes to one play");
  }
});

test("corrupt storage and identityless states fail closed", async () => {
  const fx = fakeChrome({});
  fx.state.local[TOTALS_KEY] = "not an object";
  await fx.worker.start();

  const noIdentity = coldState(undefined);
  sendYoutube(fx.worker, { ...noIdentity, duration: 180 });
  assert.equal(spanOf(activityOf(fx.port)), 180, "a timed card still works without an identity");
  fx.flushTimers();
  assert.equal(
    typeof fx.state.local[TOTALS_KEY],
    "string",
    "no identity writes no cache entry, even over corrupt storage"
  );

  sendYoutube(fx.worker, noIdentity);
  assert.equal("timestamps" in activityOf(fx.port), false, "no identity means nothing is borrowed");
});

test("the 1001st distinct track evicts the least relevant one and never exceeds the cap", async () => {
  const fx = fakeChrome({});
  await fx.worker.start();

  for (let i = 0; i <= 1000; i += 1) {
    fx.clock.t += 1;
    sendYoutube(fx.worker, { ...coldState("track-" + i), duration: 100 + i });
  }

  const final = fx.state.local[TOTALS_KEY];
  assert.equal(Object.keys(final).length, 1000, "the map holds exactly 1000 entries");
  assert.equal("youtube-music|track-0" in final, false, "the lowest score is the one evicted");
  assert.ok(
    Object.values(final).every((entry) => entry.plays >= 1),
    "every entry carries a play count"
  );
  assert.equal("youtube-music|track-1" in final, true, "the next entry survives");
  assert.equal("youtube-music|track-1000" in final, true, "the newest entry survives");

  const sizes = fx.writes
    .filter((write) => write.area === "local" && write.values[TOTALS_KEY])
    .map((write) => Object.keys(write.values[TOTALS_KEY]).length);
  assert.equal(sizes.length, 1001, "each new track is persisted immediately");
  assert.equal(sizes[0], 1, "the first entry was written alone");
  assert.equal(Math.max(...sizes), 1000, "no persisted snapshot exceeds the cap");
  assert.equal(sizes.at(-1), 1000, "the final snapshot holds exactly 1000");
});

test("a new total is written immediately and a same-total refresh is debounced", async () => {
  const fx = fakeChrome({});
  await fx.worker.start();
  const key = "youtube-music|track-F";

  sendYoutube(fx.worker, { ...coldState("track-F"), duration: 210 });
  assert.equal(
    fx.state.local[TOTALS_KEY][key]?.total,
    210,
    "a new total is on disk before any timer fires"
  );
  const afterNew = fx.writes
    .filter((write) => write.area === "local" && write.values[TOTALS_KEY]).length;
  assert.equal(afterNew, 1, "the first publish wrote once");

  fx.clock.t += 10;
  sendYoutube(fx.worker, { ...coldState("track-F"), duration: 210 });
  const afterRefresh = fx.writes
    .filter((write) => write.area === "local" && write.values[TOTALS_KEY]).length;
  assert.equal(afterRefresh, 1, "a same-total refresh adds no write");
  assert.ok(
    fx.timers.some((timer) => timer.at > fx.clock.t),
    "the timestamp refresh waits for the pending timer"
  );
});

test("two sources never steal each other's play sessions", async () => {
  const fx = fakeChrome({});
  // Crunchyroll frames expire against the real clock; keep the injected clock near it.
  fx.clock.t = Date.now();
  await fx.worker.start();
  for (let i = 0; i < 50; i += 1) {
    fx.clock.t += 1000;
    sendYoutube(fx.worker, { ...coldState("track-Two"), duration: 300, position: i });
    sendCrunchy(fx.worker, crunchyState({ position: i }));
  }
  const stored = fx.state.local[TOTALS_KEY];
  assert.equal(
    stored["youtube-music|track-Two"].plays,
    1,
    "50 rebuilds alongside another source are one play"
  );
  assert.equal(stored["crunchy|" + CRUNCHY_URL].plays, 1, "the episode is also one play");
});

test("a key switch is a session inside the gap; the other source is untouched", async () => {
  const fx = fakeChrome({});
  // Crunchyroll frames expire against the real clock; keep the injected clock near it.
  fx.clock.t = Date.now();
  await fx.worker.start();
  sendYoutube(fx.worker, { ...coldState("track-A"), duration: 200 });
  sendCrunchy(fx.worker, crunchyState());
  fx.clock.t += 1000;
  sendYoutube(fx.worker, { ...coldState("track-B"), duration: 200 });
  fx.clock.t += 1000;
  sendCrunchy(fx.worker, crunchyState());
  fx.clock.t += 1000;
  sendYoutube(fx.worker, { ...coldState("track-A"), duration: 200 });

  const stored = fx.state.local[TOTALS_KEY];
  assert.equal(stored["youtube-music|track-A"].plays, 2, "A -> B -> A is two sessions");
  assert.equal(stored["youtube-music|track-B"].plays, 1);
  assert.equal(stored["crunchy|" + CRUNCHY_URL].plays, 1, "interleaved episodes add no play");
});

test("20 continuous rebuilds of one key are one play", async () => {
  const fx = fakeChrome({});
  // Crunchyroll frames expire against the real clock; keep the injected clock near it.
  fx.clock.t = Date.now();
  await fx.worker.start();
  sendCrunchy(fx.worker, crunchyState());
  for (let i = 0; i < 20; i += 1) {
    fx.clock.t += 2000;
    sendYoutube(fx.worker, { ...coldState("track-Continuous"), duration: 300, position: i });
  }
  const stored = fx.state.local[TOTALS_KEY];
  assert.equal(stored["youtube-music|track-Continuous"].plays, 1, "2 s re-anchors are not new plays");
  assert.equal(stored["crunchy|" + CRUNCHY_URL].plays, 1, "the other source inherits no rebuilds");
});
