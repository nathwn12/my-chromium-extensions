// Proves the timeupdate gate added to content.js: a steady playhead costs no
// extractor read, a backward jump still reads and reports, and a non-media
// target is ignored. Revert the gate in content.js and test 1 goes red.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("..", import.meta.url));
const code = readFileSync(join(dir, "content.js"), "utf8");

function add(map, type, fn) {
  (map[type] = map[type] || []).push(fn);
}

function harness() {
  const listeners = Object.create(null);
  const windowListeners = Object.create(null);
  const sent = [];
  let reads = 0;
  let state = { title: "Song", paused: false, position: 10, duration: 200, playbackRate: 1 };

  const doc = {
    readyState: "complete",
    visibilityState: "visible",
    addEventListener: (type, fn) => add(listeners, type, fn),
  };
  const win = { addEventListener: (type, fn) => add(windowListeners, type, fn) };
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage: (message, cb) => {
        sent.push(message);
        if (cb) cb();
      },
    },
    storage: {
      local: { get: (_keys, cb) => cb({ enabled: { "youtube-music": true } }) },
      onChanged: { addListener: () => {} },
    },
  };

  const ctx = createContext({
    document: doc,
    window: win,
    chrome,
    navigator: {},
    location: { href: "https://music.youtube.com/watch?v=abcdefghijk" },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    console,
    Date,
    JSON,
    Math,
    String,
    Number,
    Boolean,
    Object,
    Array,
    isFinite,
    YoutubeExtract: {
      read: () => {
        reads += 1;
        return Object.assign({}, state);
      },
      sourceForLocation: () => "youtube-music",
      mediaSourceOf: () => null,
      clockAgreesOf: () => false,
    },
  });
  runInContext("globalThis.top = globalThis", ctx);
  runInContext(code, ctx);

  return {
    sent,
    reads: () => reads,
    setState: (next) => { state = next; },
    fire: (type, event) => (listeners[type] || []).forEach((fn) => fn(event)),
  };
}

test("a steady playhead costs no extractor read", () => {
  const h = harness();
  assert.equal(h.sent.length, 1, "boot report");
  const reads = h.reads();
  for (const at of [10.2, 10.6, 11.0, 11.4, 11.8, 12.2]) {
    h.fire("timeupdate", { type: "timeupdate", target: { tagName: "VIDEO", currentTime: at } });
  }
  assert.equal(h.reads(), reads, "no read on a steady or forward playhead");
  assert.equal(h.sent.length, 1, "no send on a steady playhead");
});

test("a backward jump still reads and reports", () => {
  const h = harness();
  const reads = h.reads();
  h.setState({ title: "Song", paused: false, position: 2, duration: 200, playbackRate: 1 });
  h.fire("timeupdate", { type: "timeupdate", target: { tagName: "VIDEO", currentTime: 2 } });
  assert.equal(h.reads(), reads + 1, "one read after the jump");
  assert.equal(h.sent.length, 2, "the jump is published");
});

test("a non-media target is ignored", () => {
  const h = harness();
  const reads = h.reads();
  h.fire("timeupdate", { type: "timeupdate", target: { tagName: "DIV", currentTime: 0 } });
  assert.equal(h.reads(), reads);
});
