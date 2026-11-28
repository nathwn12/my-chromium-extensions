import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALARM_NAME,
  createWorker,
  isPongOverdue,
  pickBestYoutubeTab,
} from "../background.js";
import { CLOCK_DETAILED, HOST_NAME, SETTINGS_KEY, SOURCE_CRUNCHY, SOURCE_YOUTUBE_MUSIC, TABS_KEY } from "../config.js";

function fakeChrome() {
  const listeners = { message: [], alarm: [], removed: [], changed: [] };
  const writes = [];
  const state = { local: {}, session: {} };
  const alarms = [];
  const connected = [];

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
      connectNative(name) { connected.push(name); return port; },
      onMessage: { addListener(fn) { listeners.message.push(fn); } },
    },
    storage: {
      local: area("local"),
      session: area("session"),
      onChanged: { addListener(fn) { listeners.changed.push(fn); } },
    },
    alarms: {
      create(name, info) { alarms.push({ name, info }); },
      get(name, callback) { if (typeof callback === "function") callback(null); return null; },
      onAlarm: { addListener(fn) { listeners.alarm.push(fn); } },
    },
    tabs: { onRemoved: { addListener(fn) { listeners.removed.push(fn); } } },
  };

  return { api, writes, alarms, connected, port, listeners, state };
}

test("worker arms the new watchdog and opens the suite host", async () => {
  const chrome = fakeChrome();
  const worker = createWorker({ chrome: chrome.api });
  await worker.start();
  assert.equal(ALARM_NAME, "presence-watchdog");
  assert.deepEqual(chrome.alarms.map((entry) => entry.name), ["presence-watchdog"]);
  assert.deepEqual(chrome.connected, [HOST_NAME]);
  const hello = chrome.port.posts.find((message) => message.t === "hello");
  assert.equal(hello.transport, "ipc");
});

test("one tab id can hold both sources without overwriting either", async () => {
  const chrome = fakeChrome();
  const worker = createWorker({ chrome: chrome.api });
  await worker.start();

  const sender = {
    id: "extension-under-test",
    frameId: 0,
    url: "https://music.youtube.com/watch?v=abc12345678",
    tab: { id: 7, url: "https://music.youtube.com/watch?v=abc12345678" },
  };
  worker.handleMessage(
    {
      t: "presence-state",
      source: SOURCE_YOUTUBE_MUSIC,
      state: {
        title: "Track Name",
        channel: "Artist",
        paused: false,
        position: 10,
        duration: 100,
        pageUrl: "https://music.youtube.com/watch?v=abc12345678",
      },
    },
    sender
  );
  assert.equal(worker.status().activities[SOURCE_YOUTUBE_MUSIC].details, "Track Name");
  assert.equal(worker.status().activities[SOURCE_CRUNCHY], null);

  const crunchySender = {
    id: "extension-under-test",
    frameId: 0,
    url: "https://www.crunchyroll.com/watch/G6VU774M5/episode",
    tab: { id: 7, url: "https://www.crunchyroll.com/watch/G6VU774M5/episode" },
  };
  worker.handleMessage(
    {
      t: "presence-state",
      source: SOURCE_CRUNCHY,
      state: {
        series: "Series Name",
        episodeTitle: "Episode Name",
        seasonNumber: 1,
        episodeNumber: 2,
        hasVideo: true,
        paused: false,
        duration: 120,
        position: 10,
        visible: true,
      },
    },
    crunchySender
  );

  const snapshot = chrome.writes.filter((write) => write.area === "session" && write.values[TABS_KEY]).at(-1);
  assert.ok(snapshot, "tabs were snapshotted to session storage");
  assert.ok(snapshot.values[TABS_KEY][SOURCE_YOUTUBE_MUSIC]["7"], "youtube tab kept");
  assert.ok(snapshot.values[TABS_KEY][SOURCE_CRUNCHY]["7"], "crunchy tab kept on the same id");
  assert.equal(worker.status().activities[SOURCE_YOUTUBE_MUSIC].details, "Track Name");
});

test("presence-get-status answers with the shared status payload", () => {
  const chrome = fakeChrome();
  const worker = createWorker({ chrome: chrome.api });
  let response = null;
  const consumed = worker.handleMessage({ t: "presence-get-status" }, {}, (value) => { response = value; });
  assert.equal(consumed, false);
  assert.equal(response.bridgeState, "idle");
  assert.deepEqual(Object.keys(response.activities).sort(), [SOURCE_CRUNCHY, SOURCE_YOUTUBE_MUSIC].sort());
  assert.deepEqual(response.enabled, { crunchy: true, "youtube-music": true });
});

test("pure worker helpers keep their contracts", () => {
  assert.equal(isPongOverdue(1000, 0, 11000), true);
  assert.equal(isPongOverdue(1000, 1000, 11000), false);
  assert.equal(pickBestYoutubeTab([]), null);
  const best = pickBestYoutubeTab([
    { at: 1, state: { title: "Paused", paused: true } },
    { at: 2, state: { title: "Playing", paused: false } },
  ]);
  assert.equal(best.state.title, "Playing");
});

const BASE = 1_700_000_000_000;
const SEC = Math.floor(BASE / 1000);
const WATCH = "https://music.youtube.com/watch?v=abc12345678";
const OTHER = "https://music.youtube.com/watch?v=bbbbbbbbbbb";

function musicState(extra = {}) {
  return {
    title: "Song", channel: "Artist", mediaId: "abc12345678",
    trackUrl: WATCH, pageUrl: WATCH, albumUrl: "https://music.youtube.com/browse/MPREabc",
    paused: false, duration: 100, position: 10, at: BASE,
    ...extra,
  };
}

function sendMusic(worker, state, url = WATCH) {
  worker.handleMessage(
    { t: "presence-state", source: SOURCE_YOUTUBE_MUSIC, state },
    { id: "extension-under-test", frameId: 0, url, tab: { id: 7, url } }
  );
}

test("minimal clock anchors to the first play, survives a loop and a pause, and resets on a new identity", async () => {
  const chrome = fakeChrome();
  let clock = BASE;
  const worker = createWorker({ chrome: chrome.api, now: () => clock });
  await worker.start();
  const activity = () => worker.status().activities[SOURCE_YOUTUBE_MUSIC];

  sendMusic(worker, musicState());
  assert.deepEqual(activity().timestamps, { start: SEC });
  assert.equal("end" in activity().timestamps, false);
  assert.deepEqual(activity().buttons.map((button) => button.label), ["Listen on YouTube Music", "View album"]);

  clock += 3_600_000; // one hour, one loop of the same identity
  sendMusic(worker, musicState({ position: 0, at: clock }));
  assert.deepEqual(activity().timestamps, { start: SEC }, "the timer climbs past the loop instead of jumping");

  sendMusic(worker, musicState({ paused: true, position: 20, at: clock }));
  assert.equal(activity(), null, "a paused tab publishes nothing");
  sendMusic(worker, musicState({ position: 20, at: clock }));
  assert.deepEqual(activity().timestamps, { start: SEC }, "resume keeps the anchor");

  sendMusic(worker, musicState({
    mediaId: "bbbbbbbbbbb", trackUrl: OTHER, pageUrl: OTHER, position: 0, at: clock,
  }), OTHER);
  assert.deepEqual(activity().timestamps, { start: Math.floor(clock / 1000) }, "a new song starts fresh");
});

test("stored settings win, corrupt falls back to minimal, and a storage change switches live", async () => {
  const chrome = fakeChrome();
  chrome.state.local[SETTINGS_KEY] = { clock: CLOCK_DETAILED, listenButton: false, albumButton: true };
  const worker = createWorker({ chrome: chrome.api, now: () => BASE });
  await worker.start();
  sendMusic(worker, musicState());
  const activity = () => worker.status().activities[SOURCE_YOUTUBE_MUSIC];

  assert.deepEqual(activity().timestamps, { start: SEC - 10, end: SEC + 90 }, "the stored detailed mode wins");
  assert.deepEqual(activity().buttons, [
    { label: "View album", url: "https://music.youtube.com/browse/MPREabc" },
  ], "the stored listen-button switch is respected");

  worker.handleStorageChange({ [SETTINGS_KEY]: { newValue: "junk" } }, "local");
  assert.deepEqual(activity().timestamps, { start: SEC }, "a corrupt record falls back to minimal");
  assert.deepEqual(activity().buttons.map((button) => button.label), ["Listen on YouTube Music", "View album"]);

  worker.handleStorageChange({
    [SETTINGS_KEY]: { newValue: { clock: CLOCK_DETAILED, listenButton: true, albumButton: false } },
  }, "local");
  assert.deepEqual(activity().timestamps, { start: SEC - 10, end: SEC + 90 }, "detailed is restored live");
  assert.deepEqual(activity().buttons.map((button) => button.label), ["Listen on YouTube Music"]);
});

test("a playing tab with no track identity gets no minimal anchor; a paused tab gets no timestamps in either mode", async () => {
  for (const stored of [null, { [SETTINGS_KEY]: { clock: CLOCK_DETAILED } }]) {
    const chrome = fakeChrome();
    if (stored) Object.assign(chrome.state.local, stored);
    const worker = createWorker({ chrome: chrome.api, now: () => BASE });
    await worker.start();
    const activity = () => worker.status().activities[SOURCE_YOUTUBE_MUSIC];

    sendMusic(worker, musicState({
      mediaId: undefined, trackUrl: undefined, pageUrl: undefined, paused: true,
    }));
    assert.equal(activity(), null, "paused publishes nothing in either mode");
    sendMusic(worker, musicState({
      mediaId: undefined, trackUrl: undefined, pageUrl: undefined,
    }));
    const card = activity();
    assert.ok(card, "a playing card still publishes");
    if (stored) {
      assert.deepEqual(card.timestamps, { start: SEC - 10, end: SEC + 90 });
    } else {
      assert.equal("timestamps" in card, false, "no stable identity means no invented anchor");
    }
  }
});
