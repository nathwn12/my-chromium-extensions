import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createWorker, wire } from "../../background.js";
import { audio, loadContent, musicPage, node } from "./helpers/fake-page.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const extractSource = readFileSync(join(here, "..", "..", "extract-youtube.js"), "utf8");
const contentSource = readFileSync(join(here, "..", "..", "content.js"), "utf8");

function loadExtractor() {
  const context = createContext({});
  runInContext(extractSource, context, { filename: "extract-youtube.js" });
  return context.YoutubeExtract;
}

const extractor = loadExtractor();
const PAGE_URL = "https://music.youtube.com/watch?v=bbbbbbbbbbb";
const BASE = 1_700_000_000_000;

function signal() {
  const handlers = new Set();
  return {
    addListener(fn) { handlers.add(fn); },
    removeListener(fn) { handlers.delete(fn); },
    fire(...args) { for (const fn of [...handlers]) fn(...args); },
  };
}

function fakeChrome() {
  const runtime = { id: "ext-test-id", onMessage: signal(), lastError: null };
  const port = {
    sent: [],
    onMessage: signal(),
    onDisconnect: signal(),
    postMessage(message) { this.sent.push(message); },
    disconnect() {},
  };
  runtime.connectNative = () => port;
  const storage = {
    local: { get: async () => ({ enabled: true }), set: async () => {} },
    session: { get: async () => ({}), set: async () => {} },
    onChanged: signal(),
  };
  return { runtime, storage, port };
}

function fakeClock() {
  let now = BASE;
  return {
    now: () => now,
    schedule() { return 1; },
    cancel() {},
    advance(ms) { now += ms; },
  };
}

async function bootWorker() {
  const chrome = fakeChrome();
  const clock = fakeClock();
  const worker = createWorker({ chrome, now: clock.now, schedule: clock.schedule, cancel: clock.cancel });
  wire(worker, chrome);
  await worker.start();
  return { chrome, clock, port: chrome.port };
}

function stateOf(page) {
  return JSON.parse(JSON.stringify(extractor.read(page.doc, page.navigator, page.location)));
}

function sendState(chrome, state) {
  chrome.runtime.onMessage.fire(
    { t: "ytmp-state", source: "youtube-music", state },
    { id: "ext-test-id", tab: { id: 1, url: PAGE_URL }, frameId: 0 },
    () => {}
  );
}

function frames(port) {
  return port.sent.filter((message) => message.t === "activity" && message.activity);
}

function bar(title, extra = {}) {
  return musicPage({
    href: PAGE_URL,
    title,
    byline: [node("a", { attrs: { href: "channel/UCsecond" }, text: "Second Artist" })],
    ...extra,
  });
}

test("a both-stale handoff sends no timestamp frame through the worker", async () => {
  const { chrome, clock, port } = await bootWorker();
  const page = musicPage({
    href: "https://music.youtube.com/watch?v=aaaaaaaaaaa",
    title: "First Song",
    byline: [node("a", { attrs: { href: "channel/UCfirst" }, text: "First Artist" })],
    children: [audio({ currentTime: 47, duration: 366, paused: false, playbackRate: 1 })]
  });
  const content = loadContent({ extractSource, contentSource, page });
  const first = content.messages[0].state;
  sendState(chrome, { ...first, at: BASE });
  assert.equal(frames(port)[0].activity.timestamps.end - frames(port)[0].activity.timestamps.start, 366);

  page.doc.querySelector("ytmusic-player-bar").append(
    node("span", { attrs: { class: "time" }, text: "0:47 / 6:06" })
  );
  page.navigator.mediaSession = { metadata: { title: "Second Song" }, playbackState: "playing" };
  page.setHref("https://music.youtube.com/watch?v=bbbbbbbbbbb");
  content.poll();
  const handoff = content.messages[content.messages.length - 1].state;
  assert.equal(handoff.title, "Second Song");
  assert.equal(handoff.duration, null, `title=${handoff.title} elapsed=${handoff.position} duration=${handoff.duration}`);

  clock.advance(1600);
  sendState(chrome, { ...handoff, at: clock.now() });
  assert.equal(
    frames(port)[1].activity.timestamps,
    undefined,
    `no old-song duration on the wire: title=${handoff.title} elapsed=${handoff.position} duration=${handoff.duration}`
  );
});

test("production worker frames never stretch the previous track's duration into the next", async () => {
  const { chrome, clock, port } = await bootWorker();

  const a = bar("Same Title", {
    children: [audio({ currentTime: 47, duration: 366, paused: false, playbackRate: 1 })],
  });
  const handoff = bar("Same Title", {
    mediaSession: { title: "Same Title", artist: "Second Artist" },
    children: [audio({ currentTime: 0, duration: 0, paused: true })],
  });
  handoff.navigator.mediaSession.playbackState = "playing";
  const coherent = bar("Same Title", {
    time: "0:48 / 2:09",
    mediaSession: { title: "Same Title", artist: "Second Artist" },
    children: [audio({ currentTime: 48, duration: 129, paused: false, playbackRate: 1 })],
  });

  const aState = stateOf(a);
  const handoffState = stateOf(handoff);
  const coherentState = stateOf(coherent);
  const detail = (state) => `title=${state.title} track=${state.trackUrl} elapsed=${state.position} duration=${state.duration} paused=${state.paused}`;
  assert.equal(aState.duration, 366, detail(aState));
  assert.equal(handoffState.duration, null, `extractor withholds ambiguous timing: ${detail(handoffState)}`);
  assert.equal(handoffState.paused, false, `extractor keeps playing metadata: ${detail(handoffState)}`);
  assert.equal(coherentState.duration, 129, detail(coherentState));

  sendState(chrome, { ...aState, at: BASE });
  assert.equal(frames(port).length, 1, detail(aState));
  assert.equal(frames(port)[0].activity.timestamps.end - frames(port)[0].activity.timestamps.start, 366, detail(aState));

  clock.advance(1600);
  sendState(chrome, { ...handoffState, at: clock.now() });
  assert.equal(frames(port).length, 2, detail(handoffState));
  assert.equal(frames(port)[1].activity.timestamps, undefined, `no borrowed 366 on the wire: ${detail(handoffState)}`);

  clock.advance(1600);
  sendState(chrome, { ...coherentState, at: clock.now() });
  assert.equal(frames(port).length, 3, detail(coherentState));
  const last = frames(port)[2].activity.timestamps;
  assert.equal(last.end - last.start, 129, `real total restored, never wall-time stretched: ${detail(coherentState)}`);
  assert.equal(last.start, Math.floor(clock.now() / 1000) - 48, `elapsed follows the playhead: ${detail(coherentState)}`);
});
