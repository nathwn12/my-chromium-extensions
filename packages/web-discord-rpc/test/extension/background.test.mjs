import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CLIENT_ID } from "../../config.js";
import {
  ALARM_NAME,
  BACKOFF_MIN_MS,
  MAX_UPDATES,
  SESSION_TABS_KEY,
  SOURCES,
  TAB_TTL_MS,
  createWorker,
  pickBestTab,
  sampleAt,
  wire,
} from "../../background.js";
import { STATUS_KEY } from "../../bridge-status.js";

const BASE = 1_700_000_000_000;

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
  enabled,
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
  const store = {};
  if (enabled !== undefined) store.enabled = enabled;
  // Legacy keys are accepted and ignored: the Music-only worker always uses
  // the built-in app over desktop IPC.
  for (const key of ["clientId", "transport", "youtubeEnabled", "youtubeMusicEnabled"]) {
    if (arguments[0] && arguments[0][key] !== undefined) store[key] = arguments[0][key];
  }
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

async function boot({ enabled, status, session, localReadFails, ...legacy } = {}) {
  const chrome = fakeChrome({ enabled, status, session, localReadFails, ...legacy });
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

function sendState(chrome, tabId, state, frameId = 0) {
  chrome.runtime.onMessage.fire(
    { t: "wdr-state", source: "youtube-music", state },
    sender(tabId, state.pageUrl, frameId),
    () => {}
  );
}

function sendGone(chrome, tabId, scope = "tab") {
  chrome.runtime.onMessage.fire(
    { t: "wdr-gone", source: "youtube-music", scope },
    sender(tabId, "https://music.youtube.com/"),
    () => {}
  );
}

function connect(port) {
  port.onMessage.fire({ t: "status", state: "connected", transport: "discord-ipc" });
}

const activities = (port) => port.sent.filter((message) => message.t === "activity");

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

test("music is the only source", () => {
  assert.deepEqual([...SOURCES], ["youtube-music"]);
});

test("boot opens one native port with the built-in application id and desktop IPC", async () => {
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
  chrome.runtime.onMessage.fire(
    { t: "wdr-state", source: "youtube-music", state: musicState() },
    sender(1, musicState().pageUrl),
    () => {}
  );
  await starting;

  assert.equal(chrome.ports.length, 1);
  assert.deepEqual(chrome.ports[0].sent[0], {
    t: "hello",
    clientId: DEFAULT_CLIENT_ID,
    version: 1,
    transport: "ipc",
  });
  assert.equal(worker.status().transportPreference, "ipc");
});

test("legacy stored transport, site flags and client id are ignored: hello stays Music-only IPC", async () => {
  const { chrome, worker } = await boot({
    transport: "arrpc",
    clientId: "1234567890123456789",
    youtubeEnabled: false,
    youtubeMusicEnabled: true,
  });
  assert.equal(chrome.ports[0].sent[0].transport, "ipc");
  assert.equal(chrome.ports[0].sent[0].clientId, DEFAULT_CLIENT_ID);
  assert.equal(worker.status().transportPreference, "ipc");

  chrome.storage.onChanged.fire({ transport: { newValue: "arrpc" } }, "local");
  assert.equal(chrome.ports.length, 1, "a legacy transport change never reconnects");
});

test("one Music tab produces one LISTENING activity with the artist line and display type 1", async () => {
  const { chrome, port } = await boot();
  connect(port);
  sendState(chrome, 2, musicState());

  const frames = activities(port);
  assert.equal(frames.length, 1);
  const music = frames[0];
  assert.equal(music.source, "youtube-music");
  assert.equal(music.activity.type, 2);
  assert.equal(music.activity.name, "YouTube Music");
  assert.equal(music.activity.details, "A Song");
  assert.equal(music.activity.state, "An Artist");
  assert.equal(music.activity.status_display_type, 1);
  assert.ok(typeof music.id === "string");
});

test("legacy YouTube reports are ignored and never published", async () => {
  const { chrome, port } = await boot();
  connect(port);
  chrome.runtime.onMessage.fire(
    {
      t: "wdr-state",
      source: "youtube",
      state: { ...musicState(), pageUrl: "https://www.youtube.com/watch?v=aqz-KE-bpKQ" },
    },
    sender(1, "https://www.youtube.com/watch?v=aqz-KE-bpKQ"),
    () => {}
  );
  assert.equal(activities(port).length, 0);
});

test("a playing tab wins over a paused tab", async () => {
  const { chrome, port } = await boot();
  connect(port);
  sendState(chrome, 1, musicState({ title: "Paused Song", paused: true }));
  sendState(chrome, 2, musicState({ title: "Playing Song", paused: false }));

  assert.equal(activities(port).at(-1).activity.details, "Playing Song");
});

test("four sends per 20 s, newest wins: rapid skips collapse to the latest song", async () => {
  const { chrome, clock, port } = await boot();
  connect(port);

  for (let position = 1; position <= 10; position += 1) {
    clock.advance(1000);
    sendState(chrome, position, musicState({ title: `Song ${position}`, position }));
  }
  const immediate = activities(port);
  assert.equal(immediate.length, 4);
  assert.equal(immediate.at(-1).activity.details, "Song 4");

  clock.advance(10000);
  assert.equal(activities(port).length, 4, "the window has not elapsed yet");

  clock.advance(1001);
  const flushed = activities(port);
  assert.equal(flushed.length, 5, "one deferred send after the window, newest wins");
  assert.equal(flushed.at(-1).activity.details, "Song 10");
  assert.equal(flushed.at(-1).activity.status_display_type, 1);
});

test("the outgoing SET_ACTIVITY frame carries artist state, display type 1 and real timestamps", async () => {
  const { chrome, port } = await boot();
  connect(port);
  sendState(chrome, 1, musicState({ duration: 184, position: 42 }));

  const frame = activities(port).at(-1);
  assert.equal(frame.activity.state, "An Artist");
  assert.equal(frame.activity.status_display_type, 1);
  assert.equal(frame.activity.name, "YouTube Music");
  assert.equal(frame.activity.details, "A Song");
  assert.deepEqual(frame.activity.timestamps, {
    start: Math.floor(BASE / 1000) - 42,
    end: Math.floor(BASE / 1000) - 42 + 184,
  });
});

test("a port loss keeps the desired state and replays it after the reconnect", async () => {
  const { chrome, clock, worker, port } = await boot();
  connect(port);
  sendState(chrome, 2, musicState({ position: 4 }));
  assert.equal(activities(port).length, 1);

  port.onDisconnect.fire();
  assert.equal(worker.status().bridgeState, "waiting");

  sendState(chrome, 2, musicState({ position: 40 }));
  assert.equal(activities(port).length, 1, "nothing is sent down a dead port");

  clock.advance(BACKOFF_MIN_MS);
  assert.equal(chrome.ports.length, 2);
  const reconnected = chrome.ports[1];
  assert.equal(reconnected.sent[0].t, "hello");

  connect(reconnected);
  const replay = activities(reconnected);
  assert.equal(replay.length, 1);
  assert.equal(replay[0].activity.timestamps.start, Math.floor(BASE / 1000) - 40);
});

test("a tab-scoped gone clears Music presence", async () => {
  const { chrome, port } = await boot();
  connect(port);
  sendState(chrome, 1, musicState());
  assert.equal(activities(port).length, 1);

  sendGone(chrome, 1);
  const frames = activities(port);
  assert.equal(frames.length, 2);
  assert.equal(frames.at(-1).source, "youtube-music");
  assert.equal(frames.at(-1).activity, null);
});

test("a closed tab drops its state", async () => {
  const { chrome, port } = await boot();
  connect(port);
  sendState(chrome, 7, musicState());
  assert.equal(activities(port).length, 1);

  chrome.tabs.onRemoved.fire(7);
  assert.equal(activities(port).at(-1).activity, null);
});

test("foreign senders, untrusted frames and cross-source URLs are ignored", async () => {
  const { chrome, port } = await boot();
  connect(port);

  chrome.runtime.onMessage.fire({ t: "wdr-state", source: "youtube-music", state: musicState() }, {
    id: "other-extension",
    tab: { id: 1 },
    frameId: 0,
    url: "https://music.youtube.com/",
  }, () => {});

  sendState(chrome, 2, musicState(), 1);
  chrome.runtime.onMessage.fire({ t: "wdr-state", source: "youtube-music", state: musicState() }, {
    id: "ext-test-id",
    frameId: 0,
  }, () => {});

  assert.equal(activities(port).length, 0);
});

test("status frames classify a closed pipe as waiting and a rejected id as error", async () => {
  const { worker, port } = await boot();
  port.onMessage.fire({
    t: "status",
    state: "waiting",
    transport: "discord-ipc",
    reason: "discord-closed",
    detail: "no Discord IPC pipe answered",
  });
  const waiting = worker.status();
  assert.equal(waiting.bridgeState, "waiting");
  assert.equal(waiting.reasonKind, "discord-closed");

  port.onMessage.fire({
    t: "status",
    state: "error",
    transport: "discord-ipc",
    reason: "rejected",
    detail: "invalid client id",
  });
  const error = worker.status();
  assert.equal(error.bridgeState, "error");
  assert.equal(error.reasonKind, "rejected");
});

test("the status payload carries the Music activity and is persisted for the popup", async () => {
  const { chrome, port } = await boot();
  connect(port);
  sendState(chrome, 2, musicState());

  let response;
  chrome.runtime.onMessage.fire({ t: "wdr-get-status" }, { id: "ext-test-id" }, (value) => {
    response = value;
  });
  assert.equal(response.bridgeState, "connected");
  assert.equal(response.transportPreference, "ipc");
  assert.equal(response.activities["youtube-music"].details, "A Song");
  assert.equal(response.activities["youtube-music"].status_display_type, 1);

  const persisted = chrome.writes.filter((write) => write[STATUS_KEY]).at(-1);
  assert.ok(persisted, "status is written to extension storage");
  assert.equal(persisted[STATUS_KEY].activities["youtube-music"].state, "An Artist");
});

test("the status payload names desktop IPC and the transport the host chose", async () => {
  const { worker, port } = await boot();
  assert.equal(worker.status().transportPreference, "ipc");
  assert.equal(worker.status().transport, null, "nothing is chosen before the host speaks");

  port.onMessage.fire({ t: "status", state: "connected", transport: "discord-ipc" });
  assert.equal(worker.status().transport, "discord-ipc");

  port.onMessage.fire({ t: "status", state: "connected", transport: "carrier-pigeon" });
  assert.equal(worker.status().transport, "discord-ipc");

  port.onDisconnect.fire();
  assert.equal(worker.status().transport, null, "a dead port has no chosen transport");
});

test("a start clears Music presence the last session published and has no tab for", async () => {
  const status = { activities: { "youtube-music": { details: "Old Song" } } };
  const { chrome, port } = await boot({ status });
  connect(port);

  const frames = activities(port);
  assert.equal(frames.length, 2, "only the stale source is cleared");
  assert.ok(frames.every((frame) => frame.source === "youtube-music" && frame.activity === null));
});

test("a start with nothing published last time sends no clear", async () => {
  const status = { activities: { "youtube-music": null } };
  const { port } = await boot({ status });
  connect(port);
  assert.equal(activities(port).length, 0);
});

test("a corrupt persisted status is ignored, never thrown", async () => {
  for (const status of [null, "junk", { activities: "nope" }, { activities: { "youtube-music": "nope" } }]) {
    const { port } = await boot({ status });
    connect(port);
    assert.equal(activities(port).length, 0, JSON.stringify(status));
  }
});

test("a restored tab wins over a stale published activity", async () => {
  const session = {
    [SESSION_TABS_KEY]: {
      "youtube-music": { 42: { state: musicState({ title: "Live Now" }), at: BASE, rankAt: BASE } },
    },
  };
  const status = { activities: { "youtube-music": { details: "Old Song" } } };
  const { port } = await boot({ session, status });
  connect(port);

  const frames = activities(port);
  const music = frames.find((frame) => frame.activity);
  assert.equal(music.activity.details, "Live Now", "the live tab is republished, not cleared");
});

test("enabled:false opens no port, and a watchdog tick does not open one either", async () => {
  const { chrome, clock, worker } = await boot({ enabled: false });
  assert.equal(chrome.ports.length, 0);
  assert.equal(worker.status().bridgeState, "idle");

  clock.advance(TAB_TTL_MS + 1);
  chrome.alarms.onAlarm.fire({ name: ALARM_NAME });
  assert.equal(chrome.ports.length, 0);
});

test("turning presence off clears Music, closes the port and stays closed", async () => {
  const { chrome, clock, port } = await boot();
  connect(port);
  sendState(chrome, 1, musicState());
  const before = activities(port).length;

  chrome.storage.onChanged.fire({ enabled: { newValue: false } }, "local");

  const clears = activities(port).slice(before);
  assert.equal(clears.length, 1, "one clear for the one source");
  assert.equal(clears[0].activity, null);
  assert.equal(port.disconnected, true);

  clock.advance(12000);
  assert.equal(chrome.ports.length, 1, "no reconnect while presence is off");
});

test("turning presence back on reconnects and replays the desired state", async () => {
  const session = {
    [SESSION_TABS_KEY]: {
      "youtube-music": {
        51: { state: musicState({ title: "Paused For Now", paused: true }), at: BASE, rankAt: BASE },
      },
    },
  };
  const { chrome } = await boot({ enabled: false, session });
  assert.equal(chrome.ports.length, 0);

  chrome.storage.onChanged.fire({ enabled: { newValue: true } }, "local");
  assert.equal(chrome.ports.length, 1);
  assert.equal(chrome.ports[0].sent[0].t, "hello");
  connect(chrome.ports[0]);

  const frames = activities(chrome.ports[0]);
  assert.equal(frames.find((frame) => frame.activity).activity.details, "Paused For Now");

  chrome.storage.onChanged.fire({ enabled: { newValue: undefined } }, "local");
  assert.equal(chrome.ports.length, 1, "a removed flag means enabled and is already connected");
});

test("a stale tab state is pruned by the watchdog and clears presence", async () => {
  const { chrome, clock, port } = await boot();
  connect(port);
  sendState(chrome, 1, musicState());
  assert.equal(activities(port).length, 1);

  clock.advance(TAB_TTL_MS + 1);
  chrome.alarms.onAlarm.fire({ name: ALARM_NAME });

  assert.ok(port.sent.some((message) => message.t === "ping"));
  assert.equal(activities(port).at(-1).activity, null);
});

test("a watchdog tick 45 s later publishes no second frame: the anchor is the sample", async () => {
  const { chrome, clock, worker, port } = await boot();
  connect(port);
  sendState(chrome, 1, musicState({ position: 40, at: BASE }));
  const first = activities(port);
  assert.equal(first.length, 1);
  const anchor = first[0].activity.timestamps.start;
  assert.equal(anchor, Math.floor(BASE / 1000) - 40);

  clock.advance(45_000);
  chrome.alarms.onAlarm.fire({ name: ALARM_NAME });

  assert.equal(activities(port).length, 1, "the same sample is not a resend");
  assert.equal(worker.status().activities["youtube-music"].timestamps.start, anchor);
});

test("a later report from a paused tab does not move the playing tab's anchor", async () => {
  const { chrome, clock, worker, port } = await boot();
  connect(port);
  sendState(chrome, 1, musicState({ position: 40, at: BASE }));
  const anchor = activities(port)[0].activity.timestamps.start;

  clock.advance(45_000);
  sendState(chrome, 2, musicState({ title: "Paused Song", paused: true, position: 10, at: BASE + 45_000 }));

  assert.equal(worker.status().activities["youtube-music"].details, "A Song");
  assert.equal(worker.status().activities["youtube-music"].timestamps.start, anchor);
  assert.equal(activities(port).at(-1).activity.timestamps.start, anchor);
});

test("a future-dated sample falls back to the stored instant, not to the clock", async () => {
  const { chrome, clock, worker, port } = await boot();
  connect(port);
  // 60 s ahead of its own receipt: junk, so the receipt time is the anchor.
  sendState(chrome, 1, musicState({ position: 40, at: BASE + 60_000 }));
  const publish = activities(port);
  assert.equal(publish.length, 1);
  const anchor = Math.floor(BASE / 1000) - 40;
  assert.equal(publish[0].activity.timestamps.start, anchor);
  const frame = JSON.stringify(publish[0].activity);

  clock.advance(45_000);
  chrome.alarms.onAlarm.fire({ name: ALARM_NAME });
  clock.advance(45_000);
  chrome.alarms.onAlarm.fire({ name: ALARM_NAME });

  assert.equal(
    worker.status().activities["youtube-music"].timestamps.start,
    anchor,
    "a rejected sample must not re-anchor to the rebuild clock"
  );
  assert.equal(activities(port).length, 1, "only the first frame is published");
  assert.equal(
    JSON.stringify(worker.status().activities["youtube-music"]),
    frame,
    "the same sample rebuilds byte-identically"
  );
});

test("the same sample rebuilt 45 s later is byte-identical", async () => {
  const { chrome, clock, worker, port } = await boot();
  connect(port);
  sendState(chrome, 1, musicState({ position: 40, at: BASE }));
  const atPublish = JSON.stringify(worker.status().activities["youtube-music"]);

  clock.advance(45_000);
  chrome.alarms.onAlarm.fire({ name: ALARM_NAME });

  assert.equal(
    JSON.stringify(worker.status().activities["youtube-music"]),
    atPublish
  );
});

test("sampleAt refuses a sample instant from the future", () => {
  assert.equal(sampleAt({ state: { at: BASE + 60_000 }, at: BASE }, BASE), BASE);
  assert.equal(sampleAt({ state: { at: BASE - 1000 }, at: BASE }, BASE), BASE - 1000);
  assert.equal(sampleAt({ state: {}, at: BASE }, BASE), BASE);
  assert.equal(sampleAt({ state: {} }, BASE), BASE);
});

test("sampleAt takes the state's own stamp, else the report time", () => {
  assert.equal(sampleAt({ state: { at: BASE - 250 }, at: BASE }, BASE), BASE - 250);
  assert.equal(sampleAt({ state: {}, at: BASE }), BASE);
  assert.equal(sampleAt({ state: { at: "junk" }, at: BASE }), BASE);
  assert.equal(sampleAt({ state: { at: null }, at: BASE }), BASE);
  assert.equal(sampleAt({ state: {} }, BASE - 1000), BASE - 1000);
  assert.equal(sampleAt(null, BASE), BASE);
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
  sendState(chrome, 5, musicState());

  const stored = chrome.sessionStore[SESSION_TABS_KEY];
  assert.equal(stored["youtube-music"]["5"].state.title, "A Song");
  assert.equal(stored["youtube-music"]["5"].at, BASE);

  sendGone(chrome, 5);
  assert.equal(chrome.sessionStore[SESSION_TABS_KEY]["youtube-music"]["5"], undefined);
});

test("a fresh worker restores Music state and replays it after the port connects", async () => {
  const first = await boot();
  connect(first.port);
  first.chrome.runtime.onMessage.fire(
    { t: "wdr-state", source: "youtube-music", state: musicState({ title: "Persisted Song", position: 7 }) },
    sender(11, musicState().pageUrl),
    () => {}
  );

  const snapshot = first.chrome.sessionStore[SESSION_TABS_KEY];
  assert.ok(snapshot && snapshot["youtube-music"]["11"]);

  const second = await boot({ session: { [SESSION_TABS_KEY]: snapshot } });
  const handedOver = activities(second.port);
  assert.equal(handedOver.length, 1, "the restored source reaches the host while connecting");
  assert.equal(handedOver[0].activity.details, "Persisted Song");
  assert.equal(handedOver[0].activity.timestamps.start, Math.floor(BASE / 1000) - 7);
  assert.equal(handedOver[0].activity.type, 2);

  connect(second.port);
  const replay = activities(second.port);
  assert.equal(replay.length, 2, "the source is replayed once the host is connected");
  assert.equal(second.worker.status().activities["youtube-music"].details, "Persisted Song");
});

test("a corrupt or missing session value is ignored without breaking the worker", async () => {
  const cases = [
    {},
    { [SESSION_TABS_KEY]: "garbage" },
    { [SESSION_TABS_KEY]: { "youtube-music": [1, 2] } },
    {
      [SESSION_TABS_KEY]: {
        "youtube-music": {
          notATab: { state: musicState(), at: BASE },
          1: { state: "nope", at: BASE },
          2: { state: musicState(), at: "never" },
          3: { state: musicState() },
        },
      },
    },
  ];

  for (const session of cases) {
    const { chrome, port, worker } = await boot({ session });
    connect(port);
    assert.equal(activities(port).length, 0, `no activity for ${JSON.stringify(session)}`);
    assert.equal(worker.status().bridgeState, "connected");
    assert.deepEqual(worker.status().activities, { "youtube-music": null });
  }
});

test("a report that lands before the restore resolves does not clobber the stored map", async () => {
  const stored = {
    "youtube-music": {
      21: { state: musicState({ title: "Stored Song" }), at: BASE - 5000, rankAt: BASE - 5000 },
    },
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
  chrome.runtime.onMessage.fire(
    { t: "wdr-state", source: "youtube-music", state: musicState({ title: "Live Song" }) },
    sender(22, musicState().pageUrl),
    () => {}
  );
  await starting;

  connect(chrome.ports[0]);
  const replay = activities(chrome.ports[0]);
  assert.equal(replay.find((frame) => frame.activity).activity.details, "Live Song");

  const after = chrome.sessionStore[SESSION_TABS_KEY];
  assert.ok(after["youtube-music"]["21"], "the stored tab survives an early report");
  assert.ok(after["youtube-music"]["22"], "the early tab is persisted once the restore has settled");
});

test("a restored snapshot reconciles a tab-less source to a clear", async () => {
  const stored = {
    "youtube-music": { 31: { state: musicState({ title: "Still Listening" }), at: BASE, rankAt: BASE } },
  };
  const { chrome, port } = await boot({ session: { [SESSION_TABS_KEY]: stored } });
  connect(port);

  const frames = activities(port);
  assert.equal(frames.length, 2, "the source is handed over while connecting, then replayed");
  assert.equal(frames.find((frame) => frame.activity).activity.details, "Still Listening");
});

test("a desired activity is handed over while the bridge is still connecting", async () => {
  const { chrome, port, worker } = await boot();
  sendState(chrome, 1, musicState());

  assert.equal(port.sent[0].t, "hello", "the hello goes out before any activity");
  assert.equal(worker.status().bridgeState, "connecting");
  const frames = activities(port);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].source, "youtube-music");
  assert.equal(frames[0].activity.details, "A Song");
  assert.equal(frames[0].activity.status_display_type, 1);
});

test("a connecting bridge sends through the budget and the newest report wins", async () => {
  const { chrome, clock, port } = await boot();
  for (let i = 1; i <= 10; i += 1) {
    clock.advance(1000);
    sendState(chrome, i, musicState({ title: `Song ${i}`, position: i }));
  }
  assert.equal(activities(port).length, MAX_UPDATES, "a connecting bridge is not spammed");

  clock.advance(20001);
  const frames = activities(port);
  assert.equal(frames.length, MAX_UPDATES + 1, "one deferred send after the window");
  assert.equal(frames.at(-1).activity.details, "Song 10");
});

test("a waiting bridge hands the activity over so the host can arm its reconnect", async () => {
  const { chrome, port, worker } = await boot();
  port.onMessage.fire({
    t: "status",
    state: "waiting",
    transport: "discord-ipc",
    reason: "discord-closed",
    detail: "no Discord IPC pipe answered on 10 path(s)",
  });
  assert.equal(worker.status().bridgeState, "waiting");
  assert.equal(worker.status().reasonKind, "discord-closed", "the host's hint is not dropped");

  sendState(chrome, 1, musicState());
  assert.equal(activities(port).length, 1, "the host keeps the last activity and retries");
});

test("an error or an unknown bridge state never hands an activity over", async () => {
  const { chrome, port } = await boot();
  port.onMessage.fire({
    t: "status",
    state: "error",
    transport: "discord-ipc",
    reason: "rejected",
    detail: "invalid client id",
  });
  sendState(chrome, 1, musicState());
  assert.equal(activities(port).length, 0, "a rejected id is not retried with an activity");

  port.onMessage.fire({ t: "status", state: "percolating", transport: "discord-ipc" });
  sendState(chrome, 2, musicState());
  assert.equal(activities(port).length, 0, "an unknown state is never guessed into a send");
});
