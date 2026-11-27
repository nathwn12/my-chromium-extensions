import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALARM_NAME,
  createWorker,
  isPongOverdue,
  pickBestYoutubeTab,
} from "../background.js";
import { HOST_NAME, SOURCE_CRUNCHY, SOURCE_YOUTUBE_MUSIC, TABS_KEY } from "../config.js";

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
