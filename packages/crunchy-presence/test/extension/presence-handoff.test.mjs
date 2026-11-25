/**
 * Episode handoff at the worker boundary.
 *
 * The top frame carries episode identity; the player frame carries video
 * timing. Neither frame sends a shared episode ID, so this file proves only
 * what the fixture boundary can prove: a frameId-tagged message stream. When
 * one source changes and the other has not reported the change, no card may
 * join them. Once both report the new episode, a coherent card must appear.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createContext, runInContext } from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..", "..");
const contentSource = readFileSync(join(pkg, "content.js"), "utf8");
const worker = await import(pathToFileURL(join(pkg, "background.js")).href);
const {
  mergeFrame,
  resolveTab,
  buildActivity,
  applyGoneToEntry,
  pickBestTab,
  isEligible
} = worker;

const NOW = 1_700_000_000_000;
const EP = {
  A: {
    series: "Alpha Show", episodeTitle: "Episode A", seasonNumber: 1, episodeNumber: 1,
    artworkUrl: "https://img.crunchyroll.com/a.jpg", duration: 100, position: 10, paused: false
  },
  B: {
    series: "Beta Show", episodeTitle: "Episode B", seasonNumber: 2, episodeNumber: 4,
    artworkUrl: "https://img.crunchyroll.com/b.jpg", duration: 200, position: 20, paused: false
  }
};
const urlFor = (id) => `https://www.crunchyroll.com/watch/G${id.toUpperCase()}000/${id.toLowerCase()}`;
const metaOf = (e) => ({
  hasVideo: false, series: e.series, episodeTitle: e.episodeTitle,
  seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber, artworkUrl: e.artworkUrl,
  duration: null, position: null, paused: null, signals: ["fixture"]
});
const vidOf = (e) => ({
  hasVideo: true, series: null, episodeTitle: null, seasonNumber: null,
  episodeNumber: null, artworkUrl: null, duration: e.duration, position: e.position,
  paused: e.paused, signals: ["fixture"]
});
const fullOf = (e) => ({ ...metaOf(e), hasVideo: true, duration: e.duration, position: e.position, paused: e.paused });

function makeClock() {
  let now = NOW;
  let seq = 0;
  const timers = new Map();
  const add = (fn, ms, period) => {
    const id = ++seq;
    timers.set(id, { fn, due: now + (Number(ms) || 0), period, active: true });
    return id;
  };
  return {
    now: () => now,
    setTimeout: (fn, ms) => add(fn, ms, null),
    clearTimeout: (id) => { const t = timers.get(id); if (t) t.active = false; },
    setInterval: (fn, ms) => add(fn, ms, Number(ms) || 0),
    clearInterval: (id) => { const t = timers.get(id); if (t) t.active = false; },
    advance(ms) {
      const target = now + ms;
      let guard = 0;
      while (guard++ < 1000) {
        let next = null;
        for (const [id, t] of timers) {
          if (!t.active || t.due > target) continue;
          if (!next || t.due < next.t.due || (t.due === next.t.due && id < next.id)) next = { id, t };
        }
        if (!next) break;
        now = next.t.due;
        if (next.t.period !== null) next.t.due = now + next.t.period;
        else next.t.active = false;
        next.t.fn();
      }
      now = target;
    }
  };
}

/** Boot the real content.js. Every sendMessage is tagged with its frameId. */
function bootFrame({ extract, frameId = 0, href = urlFor("A"), sink = null } = {}) {
  const clock = makeClock();
  const messages = [];
  const docL = new Map();
  const winL = new Map();
  const video = { tagName: "VIDEO" };
  let curHref = href;
  let curExtract = extract;
  const add = (bag) => (type, fn) => {
    if (!bag.has(type)) bag.set(type, []);
    bag.get(type).push(fn);
  };
  const document = {
    readyState: "complete",
    visibilityState: "visible",
    documentElement: {},
    addEventListener: add(docL),
    querySelector: (selector) => (selector === "video" ? video : selector === "#player-container" ? {} : null)
  };
  const chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(message, cb) {
        const copy = JSON.parse(JSON.stringify(message));
        messages.push({ frameId, message: copy });
        if (sink) sink(frameId, copy);
        if (typeof cb === "function") cb();
      }
    },
    storage: {
      local: { get(_keys, cb) { if (typeof cb === "function") cb({ enabled: true }); } },
      onChanged: { addListener() {} }
    }
  };
  const sandbox = {
    document,
    window: { addEventListener: add(winL) },
    location: { get href() { return curHref; } },
    navigator: {},
    chrome,
    CrunchyrollExtract: { extract: () => curExtract() },
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    Date: class { static now() { return clock.now(); } }
  };
  runInContext(contentSource, createContext(sandbox), { filename: "content.js" });
  return {
    messages, clock,
    setHref(v) { curHref = v; },
    setExtractor(fn) { curExtract = fn; },
    fireWin(type) { for (const fn of winL.get(type) || []) fn({}); },
    fireDoc(type) { for (const fn of docL.get(type) || []) fn({ target: video }); }
  };
}

/**
 * Feed tagged messages into the real worker merge helpers. A card is recorded
 * only when the worker would actually have a resolved tab state to send.
 */
function makeTab() {
  const entry = { tabId: 1, top: null, frames: {}, pageUrl: urlFor("A"), updatedAt: 0, rankAt: 0 };
  const cards = [];
  let at = NOW;
  function receive(frameId, message) {
    at += 1;
    if (message.kind === "crp-gone") {
      if (applyGoneToEntry(entry, frameId, message.scope || "frame", at) === "delete") {
        entry.top = null;
        entry.frames = {};
      }
      return;
    }
    if (message.kind !== "crp-state") return;
    mergeFrame(entry, { ...message, frameId, receivedAt: at }, at);
    const resolved = resolveTab(entry, at);
    if (resolved) cards.push({ at, activity: buildActivity(resolved, NOW) });
  }
  return {
    entry, cards, receive,
    drain(rig) { for (const { frameId, message } of rig.messages) receive(frameId, message); },
    size() { return cards.length; },
    from(n) { return cards.slice(n); },
    last() { return cards.at(-1)?.activity ?? null; }
  };
}

const assertCoherent = (card, exp, label) => {
  assert.ok(card?.activity ?? card, `${label}: a card reached the worker boundary`);
  const a = card.activity ?? card;
  assert.equal(a.details, exp.series, `${label}: identity`);
  assert.equal(a.timestamps?.start, Math.round(NOW - Math.floor(exp.position) * 1000), `${label}: timing`);
};
const isMixed = (card, stale, fresh) => {
  const a = card?.activity ?? card;
  if (!a) return false;
  return a.details === fresh.series &&
    a.timestamps?.start === Math.round(NOW - Math.floor(stale.position) * 1000);
};

function twoFrames() {
  const tagged = [];
  const top = bootFrame({ extract: () => metaOf(EP.A), frameId: 0, sink: (id, m) => tagged.push({ frameId: id, message: m }) });
  const vf = bootFrame({ extract: () => vidOf(EP.A), frameId: 1, sink: (id, m) => tagged.push({ frameId: id, message: m }) });
  const tab = makeTab();
  let cursor = 0;
  const drain = () => {
    while (cursor < tagged.length) {
      const { frameId, message } = tagged[cursor];
      tab.receive(frameId, message);
      cursor += 1;
    }
  };
  drain();
  return { top, vf, tab, tagged, drain };
}

// ------------------------------------------------------------ RED regressions

test("a stale A media event after crp-gone cannot republish A", () => {
  const rig = bootFrame({ extract: () => fullOf(EP.A) });
  const tab = makeTab();
  rig.setExtractor(() => fullOf({ ...EP.A, paused: true }));
  rig.fireDoc("pause");
  rig.setHref(urlFor("B"));
  rig.fireWin("popstate");           // gone; extractor still A (page lag)
  rig.fireDoc("play");               // stale event from A's video element
  const goneAt = rig.messages.findIndex((m) => m.message.kind === "crp-gone");
  assert.ok(goneAt >= 0, "navigation sent a gone");
  for (const { message } of rig.messages.slice(goneAt + 1)) {
    if (message.kind !== "crp-state") continue;
    assert.notEqual(message.series, EP.A.series, "no A state after gone");
    assert.notEqual(message.episodeTitle, EP.A.episodeTitle, "no A episode after gone");
  }
  rig.setExtractor(() => fullOf(EP.B));
  rig.clock.advance(301);            // settle publishes the real B
  tab.drain(rig);
  assertCoherent(tab.last(), EP.B, "stale-resurrection");
});

test("top-first conflict blocks B title with A timing until video catches up", () => {
  const { top, vf, tab, drain } = twoFrames();
  assertCoherent(tab.last(), EP.A, "top-first pre");
  const before = tab.size();
  top.setHref(urlFor("B"));
  top.setExtractor(() => metaOf(EP.B));
  top.fireWin("popstate");
  top.clock.advance(301);
  drain();
  const conflict = tab.from(before);
  assert.equal(conflict.filter((c) => c.activity).length, 0,
    "no card may join B metadata with A video evidence");
  assert.equal(conflict.some((c) => isMixed(c, EP.A, EP.B)), false, "no mixed B + A-timing card");

  vf.setExtractor(() => vidOf(EP.B));
  vf.fireDoc("play");
  drain();
  assertCoherent(tab.last(), EP.B, "top-first converged");
});

test("video-first conflict blocks A title with B timing until metadata catches up", () => {
  const { top, vf, tab, drain } = twoFrames();
  assertCoherent(tab.last(), EP.A, "video-first pre");
  const before = tab.size();
  vf.setExtractor(() => vidOf(EP.B));
  vf.fireDoc("play");
  drain();
  const conflict = tab.from(before);
  assert.equal(conflict.filter((c) => c.activity).length, 0,
    "no card may join A metadata with B video evidence");
  assert.equal(conflict.some((c) => isMixed(c, EP.B, EP.A)), false, "no mixed A + B-timing card");

  top.setHref(urlFor("B"));
  top.setExtractor(() => metaOf(EP.B));
  top.fireWin("popstate");
  top.clock.advance(301);
  drain();
  assertCoherent(tab.last(), EP.B, "video-first converged");
});

// ------------------------------------------------------------ preserved behavior

test("untrusted frame metadata stays ignored while its video still merges", () => {
  const entry = { tabId: 5, top: null, frames: {}, pageUrl: urlFor("A"), updatedAt: 0, rankAt: 0 };
  mergeFrame(entry, { frameId: 0, series: "Alpha Show", hasVideo: false, visible: true }, 1000);
  mergeFrame(entry, {
    frameId: 5, series: "Forged", hasVideo: true, paused: false, position: 1, duration: 10
  }, 1100);
  const resolved = resolveTab(entry, 1200);
  assert.notEqual(resolved.series, "Forged", "non-top metadata ignored");
  assert.equal(resolved.hasVideo, true, "video truth still merges");
  assert.equal(resolved.position, 1);
});

test("same-episode reports keep publishing and never look like a handoff", () => {
  const rig = bootFrame({ extract: () => fullOf(EP.A) });
  const tab = makeTab();
  tab.drain(rig);
  rig.fireDoc("play");
  rig.fireDoc("seeked");
  rig.clock.advance(1000);
  tab.drain(rig);
  assert.ok(tab.cards.length >= 2, "same-episode reports still reach the worker");
  assertCoherent(tab.last(), EP.A, "same-episode");
});

test("a valid older playing tab still wins over a newer paused tab", () => {
  const a = { tabId: 1, top: null, frames: {}, pageUrl: urlFor("A"), updatedAt: 0, rankAt: 0 };
  const b = { tabId: 2, top: null, frames: {}, pageUrl: urlFor("B"), updatedAt: 0, rankAt: 0 };
  mergeFrame(a, { frameId: 0, series: EP.A.series, hasVideo: true, paused: false, position: 10, duration: 100 }, 1000);
  mergeFrame(b, { frameId: 0, series: EP.B.series, hasVideo: true, paused: true, position: 20, duration: 200 }, 2000);
  const tabs = { 1: resolveTab(a, 2100), 2: resolveTab(b, 2100) };
  assert.equal(pickBestTab(tabs).tabId, 1, "playing beats recency");
  assert.equal(isEligible(tabs[1]), true);
});

test("paused playback still clears timestamps through the real activity builder", () => {
  const rig = bootFrame({ extract: () => fullOf({ ...EP.A, paused: true }) });
  const tab = makeTab();
  tab.drain(rig);
  const card = tab.last();
  assert.ok(card, "a paused tab still resolves");
  assert.equal(card.timestamps, undefined, "no live bar while paused");
});
