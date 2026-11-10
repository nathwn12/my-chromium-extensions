import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CLIENT_ID } from "../../config.js";
import {
  ALARM_NAME,
  BACKOFF_MIN_MS,
  SESSION_TABS_KEY,
  TAB_TTL_MS,
  createWorker,
  pickBestTab,
  wire,
} from "../../background.js";
import { STATUS_KEY } from "../../bridge-status.js";

const BASE = 1_700_000_000_000;
const SECOND = 1000;

/* --------------------------------------------------------------- fakes -- */

function signal() {
  const handlers = new Set();
  return {
    addListener(fn) {
      handlers.add(fn);
    },
    removeListener(fn) {
      handlers.delete(fn);
    },
    fire(...args) {
      for (const fn of [...handlers]) fn(...args);
    },
    get size() {
      return handlers.size;
    },
  };
}

function makePort(name) {
  const onMessage = signal();
  const onDisconnect = signal();
  const sent = [];
  return {
    name,
    sent,
    onMessage,
    onDisconnect,
    disconnected: false,
    postMessage(message) {
      sent.push(message);
    },
    disconnect() {
      this.disconnected = true;
    },
  };
}

function fakeChrome({ clientId = null, session: initialSession = {} } = {}) {
  const runtime = { id: "ext-test-id", onMessage: signal(), onInstalled: signal(), lastError: null };
  const ports = [];
  runtime.connectNative = (name) => {
    const port = makePort(name);
    ports.push(port);
    return port;
  };
  const store = clientId ? { clientId } : {};
  const writes = [];
  const sessionStore = { ...initialSession };
  const storage = {
    local: {
      get: async () => ({ ...store }),
      set: async (values) => writes.push(values),
    },
    session: {
      get: async () => ({ ...sessionStore }),
      set: async (values) => {
        Object.assign(sessionStore, values);
        writes.push(values);
      },
    },
    onChanged: signal(),
  };
  const alarms = { create: () => {}, get: () => undefined, onAlarm: signal() };
  const tabs = { onRemoved: signal(), onUpdated: signal() };
  return { runtime, storage, alarms, tabs, ports, writes, store, sessionStore };
}

function fakeClock(start = BASE) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    schedule(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    cancel(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        due[1].fn();
      }
    },
    get pending() {
      return timers.size;
    },
  };
}

async function boot({ clientId, session } = {}) {
  const chrome = fakeChrome({ clientId, session });
  const clock = fakeClock();
  const worker = createWorker({
    chrome,
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  wire(worker, chrome);
  await worker.start();
  return { chrome, clock, worker, port: chrome.ports[0] };
}

const sender = (tabId, url, frameId = 0) => ({
  id: "ext-test-id",
  tab: { id: tabId, url },
  frameId,
  url,
});

function sendState(chrome, tabId, source, state, frameId = 0) {
  chrome.runtime.onMessage.fire(
    { t: "wdr-state", source, state },
    sender(tabId, state.pageUrl, frameId),
    () => {}
  );
}

function sendGone(chrome, tabId, source, scope = "tab") {
  chrome.runtime.onMessage.fire(
    { t: "wdr-gone", source, scope },
    sender(tabId, "https://www.youtube.com/"),
    () => {}
  );
}

function connect(port) {
  port.onMessage.fire({ t: "status", state: "connected", transport: "arrpc" });
}

const activities = (port) => port.sent.filter((message) => message.t === "activity");

function youtubeState(overrides = {}) {
  return {
    title: "Big Buck Bunny",
    channel: "Blender",
    album: null,
    artworkUrl: "https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg",
    pageUrl: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
    mediaId: "aqz-KE-bpKQ",
    duration: 100,
    position: 1,
    paused: false,
    playbackRate: 1,
    visible: true,
    ...overrides,
  };
}

function musicState(overrides = {}) {
  return {
    title: "A Song",
    channel: "An Artist",
    album: "An Album",
    artworkUrl: "https://lh3.googleusercontent.com/cover",
    pageUrl: "https://music.youtube.com/watch?v=song123",
    mediaId: "song123",
    duration: 200,
    position: 1,
    paused: false,
    playbackRate: 1,
    visible: true,
    ...overrides,
  };
}

/* --------------------------------------------------------------- tests -- */

test("boot opens one native port with the built-in application id and arRPC transport", async () => {
  const { chrome, port } = await boot();
  assert.equal(chrome.ports.length, 1);
  assert.equal(port.name, "com.nathwn12.web_discord_rpc");
  assert.deepEqual(port.sent[0], {
    t: "hello",
    clientId: DEFAULT_CLIENT_ID,
    version: 1,
    transport: "arrpc",
  });
});

test("one tab per source produces two simultaneous activities, WATCHING and LISTENING", async () => {
  const { chrome, port } = await boot();
  connect(port);
  sendState(chrome, 1, "youtube", youtubeState());
  sendState(chrome, 2, "youtube-music", musicState());

  const frames = activities(port);
  assert.equal(frames.length, 2);
  const youtube = frames.find((frame) => frame.source === "youtube");
  const music = frames.find((frame) => frame.source === "youtube-music");
  assert.equal(youtube.activity.type, 3);
  assert.equal(youtube.activity.name, "YouTube");
  assert.equal(youtube.activity.details, "Big Buck Bunny");
  assert.equal(music.activity.type, 2);
  assert.equal(music.activity.name, "YouTube Music");
  assert.equal(music.activity.state, "An Artist — An Album");
  assert.equal(typeof youtube.id, "string");
  assert.notEqual(youtube.id, music.id);
});

test("a playing tab wins over a paused tab for the same source", async () => {
  const { chrome, port } = await boot();
  connect(port);
  sendState(chrome, 1, "youtube", youtubeState({ title: "Paused Video", paused: true }));
  sendState(chrome, 2, "youtube", youtubeState({ title: "Playing Video", paused: false }));

  const frames = activities(port);
  assert.equal(frames.at(-1).activity.details, "Playing Video");
});

test("four sends per 20 s per source, newest wins, per source independently", async () => {
  const { chrome, clock, port } = await boot();
  connect(port);

  for (let position = 1; position <= 10; position += 1) {
    sendState(chrome, 1, "youtube", youtubeState({ position }));
  }
  assert.equal(activities(port).length, 4);

  for (let position = 1; position <= 5; position += 1) {
    sendState(chrome, 2, "youtube-music", musicState({ position }));
  }
  assert.equal(activities(port).filter((frame) => frame.source === "youtube-music").length, 4);
  assert.equal(activities(port).filter((frame) => frame.source === "youtube").length, 4);

  clock.advance(19000);
  assert.equal(activities(port).filter((frame) => frame.source === "youtube").length, 4);

  clock.advance(1001);
  const youtube = activities(port).filter((frame) => frame.source === "youtube");
  assert.equal(youtube.length, 5);
  assert.equal(youtube.at(-1).activity.timestamps.start, BASE - 10 * SECOND);
});

test("a port loss keeps the desired state and replays it after the reconnect", async () => {
  const { chrome, clock, worker, port } = await boot();
  connect(port);
  sendState(chrome, 1, "youtube", youtubeState({ position: 3 }));
  sendState(chrome, 2, "youtube-music", musicState({ position: 4 }));
  assert.equal(activities(port).length, 2);

  port.onDisconnect.fire();
  assert.equal(worker.status().bridgeState, "waiting");

  sendState(chrome, 1, "youtube", youtubeState({ position: 40 }));
  assert.equal(activities(port).length, 2, "nothing is sent down a dead port");

  clock.advance(BACKOFF_MIN_MS);
  assert.equal(chrome.ports.length, 2);
  const reconnected = chrome.ports[1];
  assert.equal(reconnected.sent[0].t, "hello");

  connect(reconnected);
  const replay = activities(reconnected);
  assert.equal(replay.length, 2);
  const youtube = replay.find((frame) => frame.source === "youtube");
  assert.equal(youtube.activity.timestamps.start, BASE - 40 * SECOND);
  assert.ok(replay.find((frame) => frame.source === "youtube-music"));
});

test("a tab-scoped gone clears that source only", async () => {
  const { chrome, port } = await boot();
  connect(port);
  sendState(chrome, 1, "youtube", youtubeState());
  sendState(chrome, 2, "youtube-music", musicState());
  assert.equal(activities(port).length, 2);

  sendGone(chrome, 1, "youtube");
  const frames = activities(port);
  assert.equal(frames.length, 3);
  assert.equal(frames.at(-1).source, "youtube");
  assert.equal(frames.at(-1).activity, null);
});

test("a closed tab drops its state", async () => {
  const { chrome, port } = await boot();
  connect(port);
  sendState(chrome, 7, "youtube", youtubeState());
  assert.equal(activities(port).length, 1);

  chrome.tabs.onRemoved.fire(7);
  assert.equal(activities(port).at(-1).activity, null);
});

test("foreign senders, untrusted frames and cross-source URLs are ignored", async () => {
  const { chrome, port } = await boot();
  connect(port);

  chrome.runtime.onMessage.fire({ t: "wdr-state", source: "youtube", state: youtubeState() }, {
    id: "other-extension",
    tab: { id: 1 },
    frameId: 0,
    url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
  }, () => {});

  sendState(chrome, 2, "youtube", youtubeState(), 1);
  sendState(chrome, 3, "youtube", musicState());
  chrome.runtime.onMessage.fire({ t: "wdr-state", source: "youtube", state: youtubeState() }, {
    id: "ext-test-id",
    frameId: 0,
  }, () => {});

  assert.equal(activities(port).length, 0);
});

test("status frames classify a closed arRPC as waiting and a rejected id as error", async () => {
  const { worker, port } = await boot();
  port.onMessage.fire({
    t: "status",
    state: "waiting",
    transport: "arrpc",
    reason: "arrpc-closed",
    detail: "connect ECONNREFUSED 127.0.0.1:6463",
  });
  const waiting = worker.status();
  assert.equal(waiting.bridgeState, "waiting");
  assert.equal(waiting.availability, "unavailable");
  assert.equal(waiting.reasonKind, "arrpc-closed");
  assert.equal(waiting.detail, "connect ECONNREFUSED 127.0.0.1:6463");

  port.onMessage.fire({
    t: "status",
    state: "error",
    transport: "arrpc",
    reason: "rejected",
    detail: "invalid client id",
  });
  const error = worker.status();
  assert.equal(error.bridgeState, "error");
  assert.equal(error.reasonKind, "rejected");
});

test("the status payload carries both activities and is persisted for the popup", async () => {
  const { chrome, port } = await boot();
  connect(port);
  sendState(chrome, 1, "youtube", youtubeState());
  sendState(chrome, 2, "youtube-music", musicState());

  let response;
  chrome.runtime.onMessage.fire({ t: "wdr-get-status" }, { id: "ext-test-id" }, (value) => {
    response = value;
  });
  assert.equal(response.bridgeState, "connected");
  assert.equal(response.activities.youtube.details, "Big Buck Bunny");
  assert.equal(response.activities["youtube-music"].details, "A Song");

  const persisted = chrome.writes.filter((write) => write[STATUS_KEY]).at(-1);
  assert.ok(persisted, "status is written to extension storage");
  assert.equal(persisted[STATUS_KEY].activities["youtube-music"].state, "An Artist — An Album");
});

test("a stored application id replaces the built-in one and reconnects", async () => {
  const { chrome } = await boot();
  chrome.storage.onChanged.fire({ clientId: { newValue: "1234567890123456789" } }, "local");
  assert.equal(chrome.ports.length, 2);
  assert.equal(chrome.ports[1].sent[0].clientId, "1234567890123456789");
});

test("a stale tab state is pruned by the watchdog and clears presence", async () => {
  const { chrome, clock, port } = await boot();
  connect(port);
  sendState(chrome, 1, "youtube", youtubeState());
  assert.equal(activities(port).length, 1);

  clock.advance(TAB_TTL_MS + 1);
  chrome.alarms.onAlarm.fire({ name: ALARM_NAME });

  assert.ok(port.sent.some((message) => message.t === "ping"));
  assert.equal(activities(port).at(-1).activity, null);
});

test("pickBestTab prefers playing, then the fresher report", () => {
  const entries = [
    { state: { title: "Older playing" }, at: 1, rankAt: 1 },
    { state: { title: "Newer playing" }, at: 2, rankAt: 2 },
    { state: { title: "Paused" }, at: 9, rankAt: 9 },
    { state: { title: null }, at: 10, rankAt: 10 },
  ];
  entries[0].state.paused = false;
  entries[1].state.paused = false;
  entries[2].state.paused = true;
  assert.equal(pickBestTab(entries).state.title, "Newer playing");

  entries[0].at = 3;
  entries[0].rankAt = 3;
  assert.equal(pickBestTab(entries).state.title, "Older playing");

  entries[1].state.paused = true;
  entries[1].rankAt = 1;
  assert.equal(pickBestTab(entries).state.title, "Older playing");
});

test("tab state is mirrored to storage.session on every change", async () => {
  const { chrome, port } = await boot();
  connect(port);
  sendState(chrome, 5, "youtube", youtubeState());

  const stored = chrome.sessionStore[SESSION_TABS_KEY];
  assert.equal(stored.youtube["5"].state.title, "Big Buck Bunny");
  assert.equal(stored.youtube["5"].at, BASE);
  assert.deepEqual(stored["youtube-music"], {});

  sendGone(chrome, 5, "youtube");
  assert.equal(chrome.sessionStore[SESSION_TABS_KEY].youtube["5"], undefined);
});

test("a fresh worker restores both sources and replays them after the port connects", async () => {
  const first = await boot();
  connect(first.port);
  sendState(first.chrome, 11, "youtube", youtubeState({ title: "Persisted Video", position: 7 }));
  sendState(first.chrome, 12, "youtube-music", musicState({ title: "Persisted Song", position: 9 }));

  const snapshot = first.chrome.sessionStore[SESSION_TABS_KEY];
  assert.ok(snapshot && snapshot.youtube["11"] && snapshot["youtube-music"]["12"]);

  const second = await boot({ session: { [SESSION_TABS_KEY]: snapshot } });
  assert.equal(activities(second.port).length, 0, "nothing is sent before the port is connected");

  connect(second.port);
  const replay = activities(second.port);
  assert.equal(replay.length, 2, "both sources are replayed after suspension");
  const youtube = replay.find((frame) => frame.source === "youtube");
  const music = replay.find((frame) => frame.source === "youtube-music");
  assert.equal(youtube.activity.details, "Persisted Video");
  assert.equal(youtube.activity.timestamps.start, BASE - 7 * SECOND);
  assert.equal(music.activity.details, "Persisted Song");
  assert.equal(music.activity.type, 2);
  assert.equal(second.worker.status().activities.youtube.details, "Persisted Video");
});

test("a corrupt or missing session value is ignored without breaking the worker", async () => {
  const cases = [
    {},
    { [SESSION_TABS_KEY]: "garbage" },
    { [SESSION_TABS_KEY]: { youtube: "nope", "youtube-music": [1, 2] } },
    {
      [SESSION_TABS_KEY]: {
        youtube: {
          notATab: { state: youtubeState(), at: BASE },
          1: { state: "nope", at: BASE },
          2: { state: youtubeState(), at: "never" },
          3: { state: youtubeState() },
        },
      },
    },
  ];

  for (const session of cases) {
    const { chrome, port, worker } = await boot({ session });
    connect(port);
    assert.equal(activities(port).length, 0, `no activity for ${JSON.stringify(session)}`);
    assert.equal(worker.status().bridgeState, "connected");
    assert.deepEqual(worker.status().activities, { youtube: null, "youtube-music": null });
  }
});

test("a report that lands before the restore resolves does not clobber the stored map", async () => {
  const stored = {
    youtube: {
      21: { state: youtubeState({ title: "Stored Video" }), at: BASE - 5000, rankAt: BASE - 5000 },
    },
    "youtube-music": {},
  };
  const chrome = fakeChrome({ session: { [SESSION_TABS_KEY]: stored } });
  const clock = fakeClock();
  const worker = createWorker({
    chrome,
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  wire(worker, chrome);

  const starting = worker.start();
  sendState(chrome, 22, "youtube", youtubeState({ title: "Live Video" }));
  await starting;

  connect(chrome.ports[0]);
  const replay = activities(chrome.ports[0]);
  assert.equal(replay.length, 2);
  assert.equal(replay.find((frame) => frame.source === "youtube").activity.details, "Live Video");
  assert.equal(replay.find((frame) => frame.source === "youtube-music").activity, null);

  const after = chrome.sessionStore[SESSION_TABS_KEY];
  assert.ok(after.youtube["21"], "the stored tab survives an early report");
  assert.ok(after.youtube["22"], "the early tab is persisted once the restore has settled");
});

test("a restored snapshot reconciles a source with no tab to a clear", async () => {
  const stored = {
    youtube: { 31: { state: youtubeState({ title: "Still Watching" }), at: BASE, rankAt: BASE } },
    "youtube-music": {},
  };
  const { chrome, port } = await boot({ session: { [SESSION_TABS_KEY]: stored } });
  connect(port);

  const frames = activities(port);
  assert.equal(frames.length, 2);
  assert.equal(frames.find((frame) => frame.source === "youtube").activity.details, "Still Watching");
  assert.equal(frames.find((frame) => frame.source === "youtube-music").activity, null);
  assert.equal(activities(port).filter((frame) => frame.source === "youtube").length, 1);
});
