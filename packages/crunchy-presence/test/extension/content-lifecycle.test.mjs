/**
 * content.js behaviour under the master switch.
 *
 * The poll is the content script's only periodic work, so it is also the only
 * thing that can be wasted: a switched-off extension must hold no timer and
 * send nothing, and switching it back on must resume at once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createContext, runInContext } from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const contentSource = readFileSync(join(here, "..", "..", "content.js"), "utf8");

/**
 * The stored master switch plus the onChanged fan-out the test drives.
 *
 * `deferred` models Chrome's real async answer: the callback is held until the
 * test releases it, so the boot-before-storage window can be observed.
 */
function fakeStorage(initial, { deferred = false } = {}) {
  const state = { ...initial };
  const listeners = [];
  const held = [];
  return {
    local: {
      get(keys, callback) {
        const out = {};
        for (const key of [].concat(keys)) if (key in state) out[key] = state[key];
        if (typeof callback !== "function") return;
        if (deferred) held.push(() => callback(out));
        else callback(out);
      }
    },
    onChanged: {
      addListener(fn) {
        listeners.push(fn);
      }
    },
    emit(changes) {
      for (const fn of listeners) fn(changes, "local");
    },
    /** Callbacks still waiting for the storage answer. */
    waiting() {
      return held.length;
    },
    /** Release the held callbacks, as the real storage API would. */
    answer() {
      const pending = held.splice(0);
      for (const fn of pending) fn();
      return pending.length;
    }
  };
}

/**
 * Boot content.js in a vm realm with a page that has one video. No
 * MutationObserver is provided, so content.js takes its documented fallback
 * (the poll plus the URL events) and the poll is the only timer to observe.
 */
function boot({ enabled = true, hasVideo = true, asyncStorage = false } = {}) {
  const messages = [];
  const intervals = new Map();
  const docListeners = new Map();
  const winListeners = new Map();
  const video = { tagName: "VIDEO", paused: false };
  const add = (bag) => (type, fn) => {
    if (!bag.has(type)) bag.set(type, []);
    bag.get(type).push(fn);
  };
  const storage = fakeStorage({ enabled }, { deferred: asyncStorage });

  const document = {
    readyState: "complete",
    visibilityState: "visible",
    documentElement: {},
    addEventListener: add(docListeners),
    querySelector(selector) {
      if (selector === "video") return hasVideo ? video : null;
      return null;
    }
  };
  const window = { addEventListener: add(winListeners) };
  const location = { href: "https://www.crunchyroll.com/watch/G6VU" };
  const chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(message, callback) {
        messages.push(JSON.parse(JSON.stringify(message)));
        if (typeof callback === "function") callback();
      }
    },
    storage
  };
  let seq = 0;
  const sandbox = {
    document,
    window,
    location,
    navigator: {},
    chrome,
    CrunchyrollExtract: {
      extract: () => ({
        hasVideo,
        series: "A Series",
        episodeTitle: "An Episode",
        artworkUrl: null,
        seasonNumber: 1,
        episodeNumber: 2
      })
    },
    setInterval(fn, ms) {
      seq += 1;
      intervals.set(seq, { fn, ms, active: true });
      return seq;
    },
    clearInterval(id) {
      const entry = intervals.get(id);
      if (entry) entry.active = false;
    },
    setTimeout: () => 0,
    clearTimeout: () => {}
  };
  const context = createContext(sandbox);
  runInContext(contentSource, context, { filename: "content.js" });

  return {
    messages,
    storage,
    /** Live interval periods, i.e. the timers that can still wake the page. */
    intervalDelays() {
      return [...intervals.values()].filter((entry) => entry.active).map((entry) => entry.ms);
    },
    fireDoc(type) {
      for (const fn of docListeners.get(type) || []) fn({ target: video });
    },
    fireWin(type) {
      for (const fn of winListeners.get(type) || []) fn({});
    }
  };
}

test("an enabled boot polls once a second and publishes the episode", () => {
  const handle = boot();
  assert.deepEqual(handle.intervalDelays(), [1000]);
  assert.equal(handle.messages.length, 1);
  assert.equal(handle.messages[0].kind, "crp-state");
  assert.equal(handle.messages[0].series, "A Series");
});

test("the switch off stops the poll and sends nothing", () => {
  const handle = boot();
  handle.storage.emit({ enabled: { newValue: false } });
  assert.deepEqual(handle.intervalDelays(), [], "no timer while switched off");
  handle.fireDoc("play");
  handle.fireDoc("visibilitychange");
  handle.fireWin("pageshow");
  assert.equal(handle.messages.length, 1, "only the pre-switch report survives");
});

test("the switch on re-arms the poll and republishes at once", () => {
  const handle = boot();
  handle.storage.emit({ enabled: { newValue: false } });
  handle.storage.emit({ enabled: { newValue: true } });
  assert.deepEqual(handle.intervalDelays(), [1000]);
  assert.equal(handle.messages.length, 2, "republished without waiting for a tick");
  assert.equal(handle.messages[1].kind, "crp-state");
});

test("a boot with the switch already off holds no timer", () => {
  const handle = boot({ enabled: false });
  assert.deepEqual(handle.intervalDelays(), []);
  assert.deepEqual(handle.messages, []);
});

test("pagehide clears the poll", () => {
  const handle = boot();
  handle.fireWin("pagehide");
  assert.deepEqual(handle.intervalDelays(), []);
});


test("a disabled boot sends nothing and holds no timer before storage answers", () => {
  const handle = boot({ enabled: false, asyncStorage: true });
  assert.equal(handle.storage.waiting(), 1, "the boot asks storage before anything else");
  assert.deepEqual(handle.messages, [], "no message while the switch is unknown");
  assert.deepEqual(handle.intervalDelays(), [], "no timer while the switch is unknown");

  assert.equal(handle.storage.answer(), 1);
  assert.deepEqual(handle.messages, [], "the stored off sends nothing");
  assert.deepEqual(handle.intervalDelays(), [], "and holds no timer");
});

test("an enabled boot reports and polls only after storage answers", () => {
  const handle = boot({ enabled: true, asyncStorage: true });
  assert.deepEqual(handle.messages, [], "nothing reports before the answer");
  assert.deepEqual(handle.intervalDelays(), [], "nothing polls before the answer");

  assert.equal(handle.storage.answer(), 1);
  assert.equal(handle.messages.length, 1, "the answer arms exactly one report");
  assert.equal(handle.messages[0].kind, "crp-state");
  assert.equal(handle.messages[0].series, "A Series");
  assert.deepEqual(handle.intervalDelays(), [1000], "and one poll");
});

test("pageshow restarts the poll pagehide stopped", () => {
  const handle = boot();
  handle.fireWin("pagehide");
  assert.deepEqual(handle.intervalDelays(), [], "pagehide stopped the poll");

  handle.fireWin("pageshow");
  assert.deepEqual(handle.intervalDelays(), [1000], "a bfcache restore resumes polling");
});
