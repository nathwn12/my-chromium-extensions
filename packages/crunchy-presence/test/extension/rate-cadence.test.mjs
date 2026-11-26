/**
 * Non-1x playback cadence at the content/worker boundary.
 *
 * buildActivity anchors `start` at the send instant minus the media position.
 * That is exact only between reports; the worker paces real sends at 4/20 s,
 * so a video playing slower or faster than 1x drifts between the content
 * script's 30 s keepalives. While the playhead rate is not 1x, the content
 * script must emit short reports so the worker can re-anchor on the media
 * clock. This file proves the report reaches the worker and re-anchors before
 * the 30 s keepalive, and that 1x gains no extra report stream.
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
const { mergeFrame, resolveTab, buildActivity, createCoalescingLimiter } = worker;

const NOW = 1_700_000_000_000;
const START_POS = 600;
const DURATION = 1440;
const HREF = "https://www.crunchyroll.com/watch/G6VU774M5/the-beginning";

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

/** Boot the real content.js with a fake clock; tag every send with its time. */
function bootContent({ clock, extract, videoProps = {} }) {
  const messages = [];
  const docL = new Map();
  const winL = new Map();
  const video = { tagName: "VIDEO", ...videoProps };
  const add = (bag) => (type, fn) => {
    if (!bag.has(type)) bag.set(type, []);
    bag.get(type).push(fn);
  };
  const document = {
    readyState: "complete",
    visibilityState: "visible",
    documentElement: {},
    addEventListener: add(docL),
    querySelector: (selector) =>
      selector === "video" ? video : selector === "#player-container" ? {} : null
  };
  const chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(message, cb) {
        messages.push({ at: clock.now(), message: JSON.parse(JSON.stringify(message)) });
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
    location: { href: HREF },
    navigator: {},
    chrome,
    CrunchyrollExtract: { extract: () => extract(clock.now()) },
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    Date: class { static now() { return clock.now(); } }
  };
  runInContext(contentSource, createContext(sandbox), { filename: "content.js" });
  return { messages };
}

/** Feed tagged reports through the real worker helpers and its limiter. */
function makeWorker(clock) {
  const entry = { tabId: 1, top: null, frames: {}, pageUrl: HREF, updatedAt: 0, rankAt: 0 };
  const sent = [];
  let nowAt = NOW;
  const limiter = createCoalescingLimiter({
    send: (activity) => { if (activity) sent.push({ at: nowAt, activity }); },
    now: () => nowAt,
    schedule: (fn, ms) => clock.setTimeout(fn, ms)
  });
  let lastJson = "";
  return {
    sent,
    receive(frameId, message, at) {
      nowAt = at;
      mergeFrame(entry, { ...message, frameId, receivedAt: at }, at);
      const resolved = resolveTab(entry, at);
      if (!resolved) return;
      const activity = buildActivity(resolved, at);
      const json = JSON.stringify(activity);
      if (json === lastJson) return;
      lastJson = json;
      limiter.push(activity);
    }
  };
}

const stateAt = (pos, rate) => ({
  hasVideo: true,
  series: "Frieren: Beyond Journey's End",
  episodeTitle: "The Beginning",
  seasonNumber: 1,
  episodeNumber: 5,
  artworkUrl: null,
  duration: DURATION,
  position: pos,
  paused: false,
  playbackRate: rate
});

const messageLine = (rig) => JSON.stringify(
  rig.messages.map((m) => ({
    t: m.at - NOW, kind: m.message.kind,
    position: m.message.position, keepalive: m.message.keepalive === true
  }))
);
const frameLine = (worker) => JSON.stringify(
  worker.sent.map((f) => ({ t: f.at - NOW, start: f.activity.timestamps?.start }))
);

test("a 0.8x report inside 10 s re-anchors the worker on the media clock", () => {
  const clock = makeClock();
  const rate = 0.8;
  const positionAt = (at) => START_POS + rate * (at - NOW) / 1000;
  const rig = bootContent({
    clock,
    extract: (at) => stateAt(positionAt(at), rate),
    videoProps: { paused: false, playbackRate: rate }
  });
  const workerSide = makeWorker(clock);
  let cursor = 0;
  const drain = () => {
    while (cursor < rig.messages.length) {
      const { frameId, message, at } = rig.messages[cursor++];
      workerSide.receive(frameId, message, at);
    }
  };

  drain();
  const initial = workerSide.sent.at(-1);
  assert.ok(initial, "the boot report reaches the worker");
  const oldStart = initial.activity.timestamps.start;
  assert.equal(oldStart, NOW - START_POS * 1000, "initial anchor is sendNow - position");

  clock.advance(10000);
  drain();

  const freshReports = rig.messages.filter(
    (m) => m.message.kind === "crp-state" && m.at > NOW
  );
  assert.ok(freshReports.length > 0,
    `a playing 0.8x video must report before the 30 s keepalive; ` +
    `messages: ${messageLine(rig)}; frames: ${frameLine(workerSide)}`);

  const fresh = workerSide.sent.find((f) => f.at > NOW && f.at - NOW <= 5000);
  assert.ok(fresh,
    `the worker must emit a re-anchored frame within ~5 s; frames: ${frameLine(workerSide)}`);
  const expectedStart =
    Math.floor(fresh.at / 1000) * 1000 - Math.floor(positionAt(fresh.at)) * 1000;
  assert.equal(fresh.activity.timestamps.start, expectedStart,
    `start must track sendNow - mediaPosition at 0.8x; frames: ${frameLine(workerSide)}`);
  assert.notEqual(fresh.activity.timestamps.start, oldStart,
    "the frame must not keep the old send anchor");
});

test("at 1x the short cadence does not fire", () => {
  const clock = makeClock();
  const positionAt = (at) => START_POS + (at - NOW) / 1000;
  const rig = bootContent({
    clock,
    extract: (at) => stateAt(positionAt(at), 1),
    videoProps: { paused: false, playbackRate: 1 }
  });
  assert.equal(rig.messages.length, 1, "only the boot report at 1x");

  clock.advance(10000);
  const reports = rig.messages.filter((m) => m.message.kind === "crp-state");
  assert.equal(reports.length, 1,
    `no short cadence at 1x (keepalive still 30 s); messages: ${messageLine(rig)}`);
});
