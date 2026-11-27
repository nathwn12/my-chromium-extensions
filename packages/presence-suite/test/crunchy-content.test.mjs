import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// The content script is a classic script, so evaluate it in a vm with a tiny
// fake DOM/chrome/window harness. All timers are captured, not real, so a tick
// or a pagehide can be driven synchronously and asserted on.
const SOURCE = readFileSync(fileURLToPath(new URL("../sources/crunchy/content.js", import.meta.url)), "utf8");

function boot({ isTop = true, withRaf = true } = {}) {
  const messages = [];
  const windowHandlers = {};
  const documentHandlers = {};
  const intervals = [];
  const timeouts = [];
  const rafs = [];
  const queryCalls = { video: 0 };
  let nextId = 1;
  let video = null;

  const win = {
    addEventListener(name, fn) {
      (windowHandlers[name] ||= []).push(fn);
    },
    // Identity only: no cross-origin property is ever read by the script.
    top: null,
  };
  win.top = isTop ? win : { otherFrame: true };

  const doc = {
    readyState: "complete",
    visibilityState: "visible",
    documentElement: {},
    querySelector(selector) {
      if (selector === "video") {
        queryCalls.video += 1;
        return video;
      }
      if (selector === "#player-container") return { node: "player-container" };
      return null;
    },
    addEventListener(name, fn) {
      (documentHandlers[name] ||= []).push(fn);
    },
  };

  const chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(message, callback) {
        messages.push({ ...message }); // copy out of the vm realm for deepStrictEqual
        if (typeof callback === "function") callback();
      },
    },
    storage: {
      local: { get(keys, callback) { if (typeof callback === "function") callback({}); } },
      onChanged: { addListener() {} },
    },
  };

  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      MutationObserver.instances.push(this);
    }
    observe() { this.observed = true; }
  }
  MutationObserver.instances = [];

  const sandbox = {
    console,
    location: { href: "https://www.crunchyroll.com/watch/G6VU774M5/episode" },
    navigator: {},
    document: doc,
    window: win,
    chrome,
    MutationObserver,
    setInterval(fn, ms) {
      const entry = { id: nextId++, fn, ms, cleared: false };
      intervals.push(entry);
      return entry.id;
    },
    clearInterval(id) {
      const entry = intervals.find((item) => item.id === id);
      if (entry) entry.cleared = true;
    },
    setTimeout(fn, ms) {
      const entry = { id: nextId++, fn, ms, cleared: false };
      timeouts.push(entry);
      return entry.id;
    },
    clearTimeout(id) {
      const entry = timeouts.find((item) => item.id === id);
      if (entry) entry.cleared = true;
    },
    CrunchyrollExtract: {
      extract() {
        return { hasVideo: Boolean(video), series: "Series", episodeTitle: "Episode" };
      },
    },
  };
  if (withRaf) {
    sandbox.requestAnimationFrame = (fn) => { rafs.push(fn); return rafs.length; };
  }

  vm.runInNewContext(SOURCE, sandbox, { filename: "content.js" });

  const fireWindow = (name) => { for (const fn of windowHandlers[name] || []) fn({}); };
  const fireMedia = (name) => {
    for (const fn of documentHandlers[name] || []) fn({ target: { tagName: "VIDEO" } });
  };
  const mutate = (count = 1) => {
    for (let i = 0; i < count; i += 1) MutationObserver.instances[0].callback([], {});
  };
  const flushRafs = () => {
    const queued = rafs.splice(0);
    for (const fn of queued) fn();
    return queued.length;
  };
  const flushTimeouts = (ms = 0) => {
    const queued = timeouts.filter((entry) => entry.ms === ms && !entry.cleared);
    for (const entry of queued) entry.fn();
    return queued.length;
  };
  const setVideo = (next) => { video = next; return next; };
  const makeVideo = () => ({ tagName: "VIDEO", paused: true, playbackRate: 1, duration: 100, currentTime: 0 });

  return {
    messages, intervals, timeouts, rafs, queryCalls, MutationObserver,
    fireWindow, fireMedia, mutate, flushRafs, flushTimeouts, setVideo, makeVideo,
  };
}

// Mutation under test: restore the unconditional scope:"tab" in the pagehide
// send. A non-top frame would then delete the whole tab entry on an iframe
// unload while another frame is still playing.
test("pagehide scopes the gone message to the frame that is unloading", () => {
  const child = boot({ isTop: false });
  child.messages.length = 0;
  child.fireWindow("pagehide");
  assert.deepEqual(child.messages, [
    { t: "presence-gone", source: "crunchy", scope: "frame" },
  ]);

  const top = boot({ isTop: true });
  top.messages.length = 0;
  top.fireWindow("pagehide");
  assert.deepEqual(top.messages, [
    { t: "presence-gone", source: "crunchy", scope: "tab" },
  ]);
});

// Mutation under test: put "seeking" back in MEDIA_EVENTS. A single drag would
// then fire many full extract()+sendMessage reports instead of one at "seeked".
test("seeking is silent; seeked reports once", () => {
  const h = boot();
  h.setVideo(h.makeVideo());
  h.messages.length = 0;
  h.fireMedia("seeking");
  assert.equal(h.messages.length, 0, "seeking must not report");
  h.fireMedia("seeked");
  assert.equal(h.messages.filter((m) => m.t === "presence-state").length, 1);
});

// Mutation under test: restore stopPoll() in tick()'s no-video branch. The
// poll would die during an SPA gap and no later tick would revive it.
test("a tick without a video keeps the interval alive; a later tick reports", () => {
  const h = boot();
  assert.equal(h.intervals.length, 1);
  h.messages.length = 0;

  h.intervals[0].fn(); // tick with no <video>
  assert.equal(h.intervals[0].cleared, false, "tick must not stop the poll");
  assert.equal(h.messages.length, 0);

  h.setVideo(h.makeVideo());
  h.intervals[0].fn(); // tick after the SPA transition inserts the video
  assert.equal(h.messages.filter((m) => m.t === "presence-state").length, 1);
});

// Mutation under test: remove the dirty-flag/rAF coalescing and run checkUrl()
// plus querySelector("video") directly in the MutationObserver callback. Five
// synchronous mutations would then run five full observer bodies.
test("continuous player mutations coalesce into one observer body per frame", () => {
  const h = boot();
  const before = h.queryCalls.video;
  h.mutate(5);
  assert.equal(h.rafs.length, 1, "five mutations schedule one frame, not five");
  assert.equal(h.flushRafs(), 1);
  assert.equal(h.queryCalls.video - before, 1, "one observer body ran");

  // Existing behaviour is preserved: a video still restarts the poll and reports
  // when the element changed.
  h.fireWindow("pagehide"); // stop the poll the way a real unload does
  h.messages.length = 0;
  h.setVideo(h.makeVideo());
  h.mutate(1);
  h.flushRafs();
  assert.equal(h.intervals.filter((entry) => !entry.cleared).length, 1, "poll restarted");
  assert.equal(h.messages.filter((m) => m.t === "presence-state").length, 1, "video change reported");

  // Same coalescing on the fallback path when requestAnimationFrame is absent.
  const fallback = boot({ withRaf: false });
  const fallbackBefore = fallback.queryCalls.video;
  fallback.mutate(5);
  assert.equal(fallback.timeouts.filter((entry) => entry.ms === 0).length, 1);
  assert.equal(fallback.flushTimeouts(0), 1);
  assert.equal(fallback.queryCalls.video - fallbackBefore, 1);
});
