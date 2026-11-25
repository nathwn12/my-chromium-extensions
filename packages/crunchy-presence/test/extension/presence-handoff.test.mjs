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

test("a duplicate A metadata report does not release a video-first hold", () => {
  const { top, vf, tab, drain } = twoFrames();
  vf.setExtractor(() => vidOf(EP.B));
  vf.fireDoc("play");
  drain();
  const held = tab.size();
  top.fireDoc("play");                 // outgoing duplicate, extractor still A
  drain();
  assert.equal(tab.size(), held, "unchanged A metadata must not confirm B video");
  assert.equal(tab.from(held).some((c) => isMixed(c, EP.B, EP.A)), false);
  top.setHref(urlFor("B"));
  top.setExtractor(() => metaOf(EP.B));
  top.fireWin("popstate");
  top.clock.advance(301);
  drain();
  assertCoherent(tab.last(), EP.B, "released by real B metadata");
});

test("a duplicate A video report does not release a top-first hold", () => {
  const { top, vf, tab, drain } = twoFrames();
  top.setHref(urlFor("B"));
  top.setExtractor(() => metaOf(EP.B));
  top.fireWin("popstate");
  top.clock.advance(301);
  drain();
  const held = tab.size();
  vf.fireDoc("play");                  // outgoing duplicate, extractor still A
  drain();
  assert.equal(tab.size(), held, "unchanged A video must not confirm B metadata");
  assert.equal(tab.from(held).some((c) => isMixed(c, EP.A, EP.B)), false);
  vf.setExtractor(() => vidOf(EP.B));
  vf.fireDoc("play");
  drain();
  assertCoherent(tab.last(), EP.B, "released by real B video");
});

test("a new player frame does not release a hold with duplicate A timing", () => {
  const { top, tab, drain } = twoFrames();
  top.setHref(urlFor("B"));
  top.setExtractor(() => metaOf(EP.B));
  top.fireWin("popstate");
  top.clock.advance(301);
  drain();
  const held = tab.size();
  tab.receive(1, { kind: "crp-gone", scope: "frame" });  // old player frame removed
  tab.receive(2, {
    kind: "crp-state", hasVideo: true, visible: true, paused: false,
    position: 12, duration: 100
  });
  assert.equal(tab.size(), held, "unchanged A duration on a new frame confirms nothing");
  tab.receive(3, {
    kind: "crp-state", hasVideo: true, visible: true, paused: false,
    position: 20, duration: 200
  });
  assertCoherent(tab.last(), EP.B, "new frame B timing releases the hold");
});

test("a pruned player frame does not latch the hold when B arrives on a new frame", () => {
  const entry = { tabId: 12, top: null, frames: {}, pageUrl: urlFor("A"), updatedAt: 0, rankAt: 0 };
  const topA = { frameId: 0, series: EP.A.series, episodeTitle: EP.A.episodeTitle,
    seasonNumber: 1, episodeNumber: 1, hasVideo: false, visible: true };
  const topB = { frameId: 0, series: EP.B.series, episodeTitle: EP.B.episodeTitle,
    seasonNumber: 2, episodeNumber: 4, hasVideo: false, visible: true };
  mergeFrame(entry, topA, 1000);
  mergeFrame(entry, { frameId: 1, hasVideo: true, paused: false, position: 10, duration: 100 }, 1100);
  mergeFrame(entry, topB, 2000);
  assert.equal(resolveTab(entry, 2100), null, "hold is active");
  mergeFrame(entry, topB, 100000);   // keep top fresh while frame 1 ages out
  mergeFrame(entry, topB, 130000);   // frame 1 is now past FRAME_TTL_MS
  assert.equal(entry.frames[1], undefined, "old player frame was pruned");
  mergeFrame(entry, { frameId: 2, hasVideo: true, paused: false, position: 12, duration: 100 }, 130050);
  assert.equal(resolveTab(entry, 130100), null, "duplicate A on a fresh frame does not release");
  mergeFrame(entry, { frameId: 3, hasVideo: true, paused: false, position: 20, duration: 200 }, 130200);
  const resolved = resolveTab(entry, 130300);
  assert.ok(resolved, "genuine B on a fresh frame releases the hold");
  assert.equal(resolved.series, EP.B.series);
  assert.equal(resolved.position, 20);
});

test("changed evidence pins the video frame on an equal receivedAt tie", () => {
  const entry = { tabId: 13, top: null, frames: {}, pageUrl: urlFor("A"), updatedAt: 0, rankAt: 0 };
  mergeFrame(entry, { frameId: 0, series: EP.A.series, hasVideo: false, visible: true }, 1000);
  mergeFrame(entry, { frameId: 1, hasVideo: true, paused: false, position: 10, duration: 100 }, 1100);
  mergeFrame(entry, { frameId: 0, series: EP.B.series, hasVideo: false, visible: true }, 2000);
  assert.equal(resolveTab(entry, 2100), null, "hold is active");
  mergeFrame(entry, {
    frameId: 2, hasVideo: true, paused: false, position: 12, duration: 100, receivedAt: 2000
  }, 2000);
  assert.equal(resolveTab(entry, 2100), null, "duplicate A on a new frame does not release");
  mergeFrame(entry, {
    frameId: 3, hasVideo: true, paused: false, position: 20, duration: 200, receivedAt: 2000
  }, 2000);
  const resolved = resolveTab(entry, 2100);
  assert.ok(resolved, "hold released");
  assert.equal(resolved.series, EP.B.series);
  assert.equal(resolved.position, 20, "changed frame wins the equal-time tie");
});

function heldEntry(tabId = 20) {
  const entry = { tabId, top: null, frames: {}, pageUrl: urlFor("A"), updatedAt: 0, rankAt: 0 };
  mergeFrame(entry, { frameId: 0, series: EP.A.series, episodeTitle: EP.A.episodeTitle,
    seasonNumber: 1, episodeNumber: 1, hasVideo: false, visible: true }, 1000);
  mergeFrame(entry, { frameId: 1, hasVideo: true, paused: false, position: 10, duration: 100 }, 1100);
  mergeFrame(entry, { frameId: 0, series: EP.B.series, episodeTitle: EP.B.episodeTitle,
    seasonNumber: 2, episodeNumber: 4, hasVideo: false, visible: true }, 2000);
  assert.equal(resolveTab(entry, 2100), null, "hold is active");
  return entry;
}

test("a delayed A duplicate cannot freeze progress after a completed handoff", () => {
  const entry = heldEntry(21);
  mergeFrame(entry, { frameId: 3, hasVideo: true, paused: false, position: 20, duration: 200,
    receivedAt: 3000 }, 3000);
  const done = resolveTab(entry, 3100);
  assert.equal(done.series, EP.B.series);
  assert.equal(done.position, 20, "handoff completed on frame 3");
  // A late outgoing duplicate from the old episode carries a different
  // duration. It is not a new episode and must not open another hold.
  mergeFrame(entry, { frameId: 5, hasVideo: true, paused: false, position: 12, duration: 100,
    receivedAt: 3000 }, 3000);
  const afterDup = resolveTab(entry, 3100);
  assert.ok(afterDup, "duplicate does not block the card");
  assert.equal(afterDup.position, 20, "duplicate does not own the card");
  // A genuine same-episode replacement advances while the old frame lingers,
  // even with the same receivedAt as the duplicate.
  mergeFrame(entry, { frameId: 4, hasVideo: true, paused: false, position: 60, duration: 200,
    receivedAt: 3000 }, 3000);
  const afterAdvance = resolveTab(entry, 3100);
  assert.ok(afterAdvance, "replacement keeps the card live");
  assert.equal(afterAdvance.position, 60, "stale pinned timing does not freeze progress");
});

test("a fresh ad during a hold does not release it", () => {
  const entry = heldEntry(22);
  mergeFrame(entry, { frameId: 7, hasVideo: true, paused: false, position: 1, duration: 15,
    receivedAt: 3000 }, 3000);
  assert.equal(resolveTab(entry, 3100), null, "ad timing cannot confirm the new episode");
});

test("a foreign-identity video frame during a hold does not release it", () => {
  const entry = heldEntry(23);
  mergeFrame(entry, {
    frameId: 9, series: "Other Show", episodeTitle: "Other", seasonNumber: 9, episodeNumber: 9,
    hasVideo: true, paused: false, position: 5, duration: 300, receivedAt: 3000
  }, 3000);
  assert.equal(resolveTab(entry, 3100), null, "unrelated identity cannot confirm the hold");
});

test("an unrelated non-video frame during a hold does not release it", () => {
  const entry = heldEntry(24);
  mergeFrame(entry, {
    frameId: 8, series: "Other Show", episodeTitle: "Other", seasonNumber: 9, episodeNumber: 9,
    hasVideo: false, visible: true, receivedAt: 3000
  }, 3000);
  assert.equal(resolveTab(entry, 3100), null, "metadata-only frame owns no video truth");
});

test("a pinned frame reporting B identity before the top opens a hold", () => {
  const entry = { tabId: 30, top: null, frames: {}, pageUrl: urlFor("A"), updatedAt: 0, rankAt: 0 };
  mergeFrame(entry, { frameId: 0, ...EP.A, hasVideo: false, visible: true }, 1000);
  mergeFrame(entry, { frameId: 5, ...EP.A, hasVideo: true, paused: false,
    position: 10, duration: 100 }, 1100);
  assert.equal(resolveTab(entry, 1200).series, EP.A.series, "coherent A before conflict");
  // The trusted video frame changes to B while the top still says A. The
  // disagreement must hold the card, not publish A identity with B timing.
  mergeFrame(entry, { frameId: 5, ...EP.B, hasVideo: true, paused: false,
    position: 20, duration: 200 }, 2000);
  assert.equal(resolveTab(entry, 2100), null, "identity conflict opens a hold");
  mergeFrame(entry, { frameId: 0, ...EP.B, hasVideo: false, visible: true }, 3000);
  const resolved = resolveTab(entry, 3100);
  assert.equal(resolved.series, EP.B.series);
  assert.equal(resolved.position, 20);
});

test("a supported short episode with matching identity is not an ad", () => {
  const SHORT = { series: "Short Show", episodeTitle: "Short Episode",
    seasonNumber: 3, episodeNumber: 7 };
  const entry = { tabId: 31, top: null, frames: {}, pageUrl: urlFor("A"), updatedAt: 0, rankAt: 0 };
  mergeFrame(entry, { frameId: 0, ...EP.A, hasVideo: false, visible: true }, 1000);
  mergeFrame(entry, { frameId: 5, ...EP.A, hasVideo: true, paused: false,
    position: 10, duration: 100 }, 1100);
  applyGoneToEntry(entry, 0, "frame", 2000);
  mergeFrame(entry, { frameId: 0, ...SHORT, hasVideo: false, visible: true }, 2100);
  assert.equal(resolveTab(entry, 2200), null, "hold for the new top identity");
  mergeFrame(entry, { frameId: 5, ...SHORT, hasVideo: true, paused: false,
    position: 5, duration: 30 }, 2300);
  const resolved = resolveTab(entry, 2400);
  assert.ok(resolved, "matching identity confirms the short episode");
  assert.equal(resolved.series, SHORT.series);
  assert.equal(resolved.duration, 30, "short duration is the episode, not an ad");
  assert.equal(resolved.position, 5);
});

test("a real A keepalive does not release a top-first hold", () => {
  const { top, vf, tab, drain } = twoFrames();
  top.setHref(urlFor("B"));
  top.setExtractor(() => metaOf(EP.B));
  top.fireWin("popstate");
  top.clock.advance(301);
  drain();
  const held = tab.size();
  vf.clock.advance(30000);             // the poll sends a real keepalive from A
  drain();
  assert.equal(tab.size(), held, "keepalive carries no new episode evidence");
  assert.equal(tab.from(held).some((c) => isMixed(c, EP.A, EP.B)), false);
  vf.setExtractor(() => vidOf(EP.B));
  vf.fireDoc("play");
  drain();
  assertCoherent(tab.last(), EP.B, "released by real B video");
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

test("an equal-duration cross-origin seek is not rejected as a handoff", () => {
  // Production signals here: frameId 5 is untrusted for metadata, duration is
  // unchanged at 100, only position moves. An equal-duration cross-origin
  // episode change is indistinguishable from this seek. We do not invent an
  // ID and we do not blanket-reject seeks; the seek still publishes.
  const entry = { tabId: 6, top: null, frames: {}, pageUrl: urlFor("A"), updatedAt: 0, rankAt: 0 };
  mergeFrame(entry, { frameId: 0, series: EP.A.series, episodeTitle: EP.A.episodeTitle,
    seasonNumber: 1, episodeNumber: 1, hasVideo: false, visible: true }, 1000);
  mergeFrame(entry, { frameId: 5, hasVideo: true, paused: false, position: 10, duration: 100 }, 1100);
  assertCoherent({ activity: buildActivity(resolveTab(entry, 1200), NOW) }, EP.A, "seek pre");
  mergeFrame(entry, { frameId: 5, hasVideo: true, paused: false, position: 55, duration: 100 }, 2100);
  const after = resolveTab(entry, 2200);
  assert.ok(after, "a seek keeps the tab resolvable");
  assert.equal(after.position, 55, "seek position reaches the card");
  assert.equal(after.series, EP.A.series, "seek keeps the top identity");
});

test("same-episode recovery resumes after a real identity change", () => {
  const { top, vf, tab, drain } = twoFrames();
  vf.setExtractor(() => vidOf(EP.B));
  vf.fireDoc("play");
  drain();
  const held = tab.size();
  assert.equal(tab.size(), held, "hold is active");
  // The top moves back to its own new identity. Changed evidence, not a
  // duplicate, releases the hold.
  top.setHref(urlFor("B"));
  top.setExtractor(() => metaOf(EP.B));
  top.fireWin("popstate");
  top.clock.advance(301);
  drain();
  assertCoherent(tab.last(), EP.B, "recovery publishes B");
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
