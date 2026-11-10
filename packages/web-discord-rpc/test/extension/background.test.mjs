import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CLIENT_ID } from "../../config.js";
import {
  ALARM_NAME,
  BACKOFF_MIN_MS,
  SESSION_TABS_KEY,
  SOURCES,
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

function fakeChrome({
  clientId = null,
  transport,
  enabled,
  youtubeEnabled,
  youtubeMusicEnabled,
  status,
  session: initialSession = {},
  localReadFails = false,
} = {}) {
  const runtime = { id: "ext-test-id", onMessage: signal(), onInstalled: signal(), lastError: null };
  const ports = [];
  runtime.connectNative = (name) => {
    const port = makePort(name);
    ports.push(port);
    return port;
  };
  const store = clientId ? { clientId } : {};
  if (transport !== undefined) store.transport = transport;
  if (enabled !== undefined) store.enabled = enabled;
  if (youtubeEnabled !== undefined) store.youtubeEnabled = youtubeEnabled;
  if (youtubeMusicEnabled !== undefined) store.youtubeMusicEnabled = youtubeMusicEnabled;
  if (status !== undefined) store[STATUS_KEY] = status;
  const writes = [];
  const sessionStore = { ...initialSession };
  const storage = {
    local: {
      get: async () => {
        if (localReadFails) throw new Error("storage unavailable");
        return { ...store };
      },
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

async function boot({
  clientId,
  transport,
  enabled,
  youtubeEnabled,
  youtubeMusicEnabled,
  status,
  session,
  localReadFails,
} = {}) {
  const chrome = fakeChrome({
    clientId,
    transport,
    enabled,
    youtubeEnabled,
    youtubeMusicEnabled,
    status,
    session,
    localReadFails,
  });
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

test("boot opens one native port with the built-in application id and the desktop IPC preference", async () => {
  const { chrome, port } = await boot();
  assert.equal(chrome.ports.length, 1);
  assert.equal(port.name, "com.nathwn12.web_discord_rpc");
  assert.deepEqual(port.sent[0], {
    t: "hello",
    clientId: DEFAULT_CLIENT_ID,
    version: 1,
    transport: "ipc",
  });
});

test("a storage read failure and an early report still put desktop IPC in the first hello", async () => {
  // start() is async: a content script can report before loadConfig settles, so
  // the worker's initial transport must already be the default, not auto.
  const chrome = fakeChrome({ localReadFails: true });
  const clock = fakeClock();
  const worker = createWorker({
    chrome,
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  wire(worker, chrome);

  const starting = worker.start();
  sendState(chrome, 1, "youtube", youtubeState());
  await starting;

  assert.equal(chrome.ports.length, 1);
  assert.deepEqual(chrome.ports[0].sent[0], {
    t: "hello",
    clientId: DEFAULT_CLIENT_ID,
    version: 1,
    transport: "ipc",
  });
  assert.equal(worker.status().transportPreference, "ipc");
  assert.deepEqual(worker.status().sites, { youtube: true, "youtube-music": true });
});

test("a stored transport reaches hello and a change reconnects with the new preference", async () => {
  const { chrome } = await boot({ transport: "ipc" });
  assert.equal(chrome.ports[0].sent[0].transport, "ipc");

  chrome.storage.onChanged.fire({ transport: { newValue: "arrpc" } }, "local");
  assert.equal(chrome.ports.length, 2);
  assert.equal(chrome.ports[0].disconnected, true, "the old preference's port is closed");
  assert.deepEqual(chrome.ports[1].sent[0], {
    t: "hello",
    clientId: DEFAULT_CLIENT_ID,
    version: 1,
    transport: "arrpc",
  });
});

test("an unknown stored transport falls back to desktop IPC in hello", async () => {
  const { chrome } = await boot({ transport: "carrier-pigeon" });
  assert.equal(chrome.ports[0].sent[0].transport, "ipc");
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

test("the status payload names the stored preference and the transport the host chose", async () => {
  const { worker, port } = await boot({ transport: "ipc" });
  assert.equal(worker.status().transportPreference, "ipc");
  assert.equal(worker.status().transport, null, "nothing is chosen before the host speaks");

  port.onMessage.fire({ t: "status", state: "connected", transport: "discord-ipc" });
  assert.equal(worker.status().transport, "discord-ipc");

  // A host that names something unrecognised never leaks it to a surface.
  port.onMessage.fire({ t: "status", state: "connected", transport: "carrier-pigeon" });
  assert.equal(worker.status().transport, "discord-ipc");

  port.onDisconnect.fire();
  assert.equal(worker.status().transport, null, "a dead port has no chosen transport");
});

test("a start clears presence the last session published and has no tab for", async () => {
  const status = { activities: { youtube: { details: "Old Video" }, "youtube-music": null } };
  const { chrome, port } = await boot({ status });
  connect(port);

  const frames = activities(port);
  assert.equal(frames.length, 1, "only the stale source is cleared");
  assert.equal(frames[0].source, "youtube");
  assert.equal(frames[0].activity, null);
});

test("a start with nothing published last time sends no clear", async () => {
  const status = { activities: { youtube: null, "youtube-music": null } };
  const { port } = await boot({ status });
  connect(port);
  assert.equal(activities(port).length, 0);
});

test("a corrupt persisted status is ignored, never thrown", async () => {
  for (const status of [null, "junk", { activities: "nope" }, { activities: { youtube: "nope" } }]) {
    const { port } = await boot({ status });
    connect(port);
    assert.equal(activities(port).length, 0, JSON.stringify(status));
  }
});

test("a restored tab wins over a stale published activity for the same source", async () => {
  const session = {
    [SESSION_TABS_KEY]: {
      youtube: { 41: { state: youtubeState({ title: "Live Now" }), at: BASE, rankAt: BASE } },
      "youtube-music": {},
    },
  };
  const status = { activities: { youtube: { details: "Old Video" }, "youtube-music": { details: "Old Song" } } };
  const { port } = await boot({ session, status });
  connect(port);

  const frames = activities(port);
  const youtube = frames.find((frame) => frame.source === "youtube");
  const music = frames.find((frame) => frame.source === "youtube-music");
  assert.equal(youtube.activity.details, "Live Now", "the live tab is republished, not cleared");
  assert.equal(music.activity, null, "a stale source with no tab is cleared");
});

test("enabled:false opens no port, and a watchdog tick does not open one either", async () => {
  const { chrome, clock, worker } = await boot({ enabled: false });
  assert.equal(chrome.ports.length, 0);
  assert.equal(worker.status().bridgeState, "idle");

  clock.advance(TAB_TTL_MS + 1);
  chrome.alarms.onAlarm.fire({ name: ALARM_NAME });
  assert.equal(chrome.ports.length, 0);
});

test("turning presence off clears both sources, closes the port and stays closed", async () => {
  const { chrome, clock, port } = await boot();
  connect(port);
  sendState(chrome, 1, "youtube", youtubeState());
  const before = activities(port).length;

  chrome.storage.onChanged.fire({ enabled: { newValue: false } }, "local");

  const clears = activities(port).slice(before);
  assert.equal(clears.length, 2, "one clear per source");
  assert.ok(clears.every((frame) => frame.activity === null));
  assert.equal(port.disconnected, true);

  clock.advance(12000);
  assert.equal(chrome.ports.length, 1, "no reconnect while presence is off");
});

test("turning presence back on reconnects and replays the desired state", async () => {
  const session = {
    [SESSION_TABS_KEY]: {
      youtube: {
        51: { state: youtubeState({ title: "Paused For Now", paused: true }), at: BASE, rankAt: BASE },
      },
      "youtube-music": {},
    },
  };
  const { chrome } = await boot({ enabled: false, session });
  assert.equal(chrome.ports.length, 0);

  chrome.storage.onChanged.fire({ enabled: { newValue: true } }, "local");
  assert.equal(chrome.ports.length, 1);
  assert.equal(chrome.ports[0].sent[0].t, "hello");
  connect(chrome.ports[0]);

  const frames = activities(chrome.ports[0]);
  assert.equal(frames.find((frame) => frame.source === "youtube").activity.details, "Paused For Now");
  assert.equal(frames.find((frame) => frame.source === "youtube-music").activity, null);

  chrome.storage.onChanged.fire({ enabled: { newValue: undefined } }, "local");
  assert.equal(chrome.ports.length, 1, "a removed flag means enabled and is already connected");
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

test("YouTube Music is processed first, so its frame is the first one after a connect", async () => {
  assert.deepEqual([...SOURCES], ["youtube-music", "youtube"]);

  const session = {
    [SESSION_TABS_KEY]: {
      youtube: { 61: { state: youtubeState(), at: BASE, rankAt: BASE } },
      "youtube-music": { 62: { state: musicState(), at: BASE, rankAt: BASE } },
    },
  };
  const { port } = await boot({ session });
  connect(port);

  assert.deepEqual(
    activities(port).map((frame) => frame.source),
    ["youtube-music", "youtube"]
  );
});

test("both site flags are on by default and the status payload carries them", async () => {
  const { worker } = await boot();
  const { sites } = worker.status();
  assert.deepEqual(sites, { youtube: true, "youtube-music": true });
  assert.deepEqual(Object.keys(sites), ["youtube-music", "youtube"], "music is processed first");
});

test("a disabled site publishes nothing while the other site still does", async () => {
  const { chrome, port, worker } = await boot({ youtubeEnabled: false });
  assert.equal(worker.status().sites.youtube, false);

  connect(port);
  sendState(chrome, 1, "youtube", youtubeState());
  assert.equal(activities(port).length, 0, "the disabled site never reaches Discord");

  sendState(chrome, 2, "youtube-music", musicState());
  assert.equal(activities(port).length, 1);
  assert.equal(activities(port)[0].source, "youtube-music");
});

test("turning a site off clears it, ignores later reports, and turning it back on republishes", async () => {
  const { chrome, port } = await boot();
  connect(port);
  sendState(chrome, 1, "youtube", youtubeState());
  assert.equal(activities(port).length, 1);

  chrome.storage.onChanged.fire({ youtubeEnabled: { newValue: false } }, "local");
  assert.equal(activities(port).length, 2, "the now-disabled site is cleared at once");
  assert.equal(activities(port).at(-1).source, "youtube");
  assert.equal(activities(port).at(-1).activity, null);

  sendState(chrome, 1, "youtube", youtubeState({ position: 4 }));
  assert.equal(activities(port).length, 2, "a report from a disabled site is ignored");

  sendState(chrome, 2, "youtube-music", musicState());
  assert.equal(activities(port).at(-1).source, "youtube-music", "the other site is unaffected");

  chrome.storage.onChanged.fire({ youtubeEnabled: { newValue: true } }, "local");
  assert.equal(activities(port).at(-1).source, "youtube");
  assert.equal(activities(port).at(-1).activity.details, "Big Buck Bunny");
});

test("a start clears a disabled site the last session left published", async () => {
  const status = { activities: { youtube: { details: "Old Video" }, "youtube-music": null } };
  const { port } = await boot({ youtubeEnabled: false, status });
  connect(port);

  const frames = activities(port);
  assert.equal(frames.length, 1, "the disabled site's stale presence is removed");
  assert.equal(frames[0].source, "youtube");
  assert.equal(frames[0].activity, null);
});
