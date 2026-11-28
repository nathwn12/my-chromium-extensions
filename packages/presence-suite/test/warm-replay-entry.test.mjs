// Production entry for a warm replay: the REAL extractor and content script
// run in one sandbox, and the state they actually send is fed to the REAL
// worker so the native-port card is checked on both sides. A titleless sample
// is eligible only with the exact current video ID; nothing is invented.
// No browser, no network, no audio, no live playback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createWorker } from "../background.js";
import { SOURCE_YOUTUBE_MUSIC, TOTALS_KEY } from "../config.js";

const dir = fileURLToPath(new URL("..", import.meta.url));
const extractCode = readFileSync(join(dir, "extract-youtube.js"), "utf8");
const contentCode = readFileSync(join(dir, "content.js"), "utf8");

const BASE = 1_700_000_000_000;
const ID = "aaaaaaaaaaa";
const OTHER = "bbbbbbbbbbb";
const WATCH = "https://music.youtube.com/watch?v=" + ID;
const OTHER_WATCH = "https://music.youtube.com/watch?v=" + OTHER;
const KEY = SOURCE_YOUTUBE_MUSIC + "|" + ID;

/** A playing page with no title source at all, but a player-bar track link. */
function contentHarness({ link = WATCH, playbackState = "playing" } = {}) {
  const node = { getAttribute: (name) => (name === "href" ? link : null), textContent: "" };
  const sent = [];
  const doc = {
    readyState: "complete",
    visibilityState: "visible",
    title: "",
    querySelector(selector) {
      return selector === "ytmusic-player-bar .title a" ? node : null;
    },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, cb) { sent.push(message); if (cb) cb(); },
    },
    storage: {
      local: { get: (_keys, cb) => cb({ enabled: { "youtube-music": true } }) },
      onChanged: { addListener() {} },
    },
  };
  const ctx = createContext({
    console, JSON, Math, String, Number, Boolean, Object, Array, isFinite, RegExp,
    parseInt, parseFloat,
    Date: { now: () => BASE },
    document: doc,
    window: { addEventListener() {} },
    chrome,
    navigator: { mediaSession: { playbackState, metadata: null } },
    location: { href: WATCH },
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
  });
  runInContext("globalThis.top = globalThis", ctx);
  runInContext(extractCode, ctx);
  runInContext(contentCode, ctx);
  return {
    sent,
    states: () => sent.filter((message) => message.t === "presence-state"),
    raw: () => ctx.YoutubeExtract.read(doc, ctx.navigator, ctx.location),
  };
}

/** The same worker harness cached-text-metadata.test.mjs drives. */
function workerHarness(seedTotals) {
  const state = { local: { [TOTALS_KEY]: seedTotals }, session: {} };
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
      local: area("local"), session: area("session"), onChanged: { addListener() {} },
    },
    alarms: { create() {}, get() { return null; }, onAlarm: { addListener() {} } },
    tabs: { onRemoved: { addListener() {} } },
  };
  const worker = createWorker({
    chrome: api, now: () => BASE, schedule: () => 1, cancel: () => {},
  });
  return {
    worker, port,
    async start() { await worker.start(); },
    feed(message) {
      worker.handleState(message, {
        id: "extension-under-test", frameId: 0, url: WATCH, tab: { id: 7, url: WATCH },
      });
    },
    activity() { return port.posts.filter((m) => m.t === "activity").at(-1)?.activity ?? null; },
  };
}

const warm = {
  total: 1088, at: BASE - 1000, plays: 1,
  title: "Warm Song", channel: "Warm Artist", album: "Warm Album",
};

test("a titleless playing sample with the exact current ID reaches the worker and answers early", async () => {
  const page = contentHarness();
  const extracted = page.raw();
  assert.equal(extracted.title, null, "the extractor invents no title");
  assert.equal(extracted.mediaId, ID, "the URL names the current video");
  assert.equal(extracted.trackUrl, WATCH, "the player bar names the same video");
  assert.equal(extracted.position, null, "no playhead is invented");
  assert.equal(extracted.duration, null, "no total is invented");

  const sent = page.states();
  assert.equal(sent.length, 1, "the content script reports the titleless playing sample");
  const state = sent[0].state;
  assert.equal(state.title, null);
  assert.equal(state.paused, false);
  assert.equal(state.position, null);

  const fx = workerHarness({ [KEY]: { ...warm } });
  await fx.start();
  fx.feed(sent[0]);
  const card = fx.activity();
  assert.ok(card, "the warm cache produces a card before live text exists");
  assert.equal(card.details, "Warm Song", "title comes from the confirmed-ID cache");
  assert.equal(card.state, "Warm Artist");
  assert.equal("timestamps" in card, false, "no cached playhead is invented");
});

test("the same production sample with no cache publishes nothing", async () => {
  const page = contentHarness();
  const sent = page.states();
  assert.equal(sent.length, 1, "the content side still reports the sample");

  const fx = workerHarness({});
  await fx.start();
  fx.feed(sent[0]);
  assert.equal(fx.activity(), null, "a cache miss cannot publish a titleless card");
});

test("a stale page ID that disagrees with the player bar never leaves the content script", () => {
  const page = contentHarness({ link: OTHER_WATCH });
  assert.equal(page.raw(), null, "the extractor refuses the unconfirmed identity");
  assert.equal(page.states().length, 0, "no titleless state is sent to the worker");
});

test("a titleless paused sample is not promoted to a warm card", () => {
  const page = contentHarness({ playbackState: "paused" });
  assert.equal(page.raw(), null, "paused is not an eligible replay");
  assert.equal(page.states().length, 0);
});
