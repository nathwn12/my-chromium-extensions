'use strict';

/* global require, __dirname */

/*
 * test/injection-lifecycle.test.js - extension reload / injection lifecycle.
 *
 * After a Chrome extension reload or update, the old ISOLATED content script is
 * an orphan: its chrome.runtime is dead and a new service worker cannot message
 * it. Re-injection must retire the orphan instead of adopting it, re-install the
 * ISOLATED script path, and never throw out of the watchdog. Main-world READY
 * must authenticate itself.
 *
 * Plain Node + vm stubs only. No browser, no audio.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PKG = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(PKG, f), 'utf8');

function loadPageHook() {
  const posted = [];
  const listeners = [];
  const sandbox = {
    console,
    Uint8Array,
    Date,
    Math,
    JSON,
    String,
  };
  sandbox.window = {
    postMessage(msg) {
      posted.push(msg);
    },
    addEventListener(type, fn, opts) {
      listeners.push({ type, fn, opts });
    },
  };
  sandbox.document = {
    documentElement: { dataset: { slraToken: 'token-minted-by-content-script' } },
    visibilityState: 'visible',
    // The hook binds song events on document; keep them off the window count.
    addEventListener() {},
    removeEventListener() {},
  };
  sandbox.location = { href: 'https://music.youtube.com/watch?v=x', origin: 'https://music.youtube.com' };
  vm.createContext(sandbox);
  vm.runInContext(read('page-hook.js'), sandbox, { filename: 'page-hook.js' });
  return { posted, listeners, sandbox };
}

test('A: page-hook READY carries the token the content script demands', () => {
  const { posted } = loadPageHook();
  const ready = posted.find((m) => m && m.type === 'SLRA_PAGE_HOOK_READY');
  assert.ok(ready, 'hook must post SLRA_PAGE_HOOK_READY on install');
  assert.strictEqual(typeof ready.token, 'string', 'READY must carry a token');
  assert.ok(ready.token.length > 0, 'READY token must be non-empty');
  assert.strictEqual(ready.token, 'token-minted-by-content-script', 'READY token must match data-slra-token');
});

test('A2: re-injecting page-hook.js does not duplicate listeners', () => {
  const env = loadPageHook();
  const before = env.listeners.length;
  vm.runInContext(read('page-hook.js'), env.sandbox, { filename: 'page-hook.js' });
  assert.strictEqual(env.listeners.length, before, 'sentinel guard must prevent a second listener set');
  const reinjects = env.posted.filter((m) => m && m.reason === 'reinject');
  assert.ok(reinjects.length >= 1, 'second run must emit SLRA_PAGE_REVIVE(reinject)');
});

test('B: background re-injects content-script.js when the tab is unreachable', () => {
  const src = read('background.js');
  assert.ok(
    /files:\s*\[[^\]]*'content-script\.js'/.test(src),
    'pushTabState catch must re-install the ISOLATED content script'
  );
});

function createContentEnv(opts = {}) {
  const stats = { ensureHooksCalls: 0, addModuleCalls: 0, contexts: 0, disconnects: 0, tracks: [] };

  const realSetTimeout = globalThis.setTimeout;
  const intervals = new Map();
  let intervalId = 100000;

  let clock = Date.now();
  function FakeDate(...args) {
    return args.length ? new Date(...args) : new Date(clock);
  }
  FakeDate.now = () => clock;

  const sandbox = {
    console,
    Date: FakeDate,
    Math,
    JSON,
    Object,
    Promise,
    Array,
    Uint8Array,
    Number,
    Error,
    String,
    Boolean,
    queueMicrotask,
  };

  sandbox.setTimeout = (cb) => {
    queueMicrotask(cb);
    return 1;
  };
  sandbox.clearTimeout = () => {};
  sandbox.setInterval = (cb, ms) => {
    const id = intervalId++;
    intervals.set(id, { cb, ms });
    return id;
  };
  sandbox.clearInterval = (id) => intervals.delete(id);

  sandbox.location = { origin: 'https://music.youtube.com', href: 'https://music.youtube.com/' };
  sandbox.crypto = globalThis.crypto;

  class StubMedia extends EventTarget {
    constructor(muted) {
      super();
      this.playbackRate = 1;
      this.preservesPitch = true;
      this.mozPreservesPitch = true;
      this.webkitPreservesPitch = true;
      this.muted = Boolean(muted);
      this.volume = 1;
      this.paused = false;
      this.ended = false;
      this.readyState = 4;
      this.currentSrc = 'https://music.youtube.com/stream';
      this.srcObject = null;
      this.isConnected = true;
    }
    pause() {
      this.paused = true;
    }
    captureStream() {
      const track = {
        kind: 'audio',
        stopped: false,
        stop() {
          this.stopped = true;
        },
      };
      stats.tracks.push(track);
      return { getAudioTracks: () => [track], getTracks: () => [track], addEventListener() {} };
    }
  }
  StubMedia.HAVE_CURRENT_DATA = 2;

  class StubAudioContext {
    constructor() {
      stats.contexts += 1;
      this.state = 'running';
      this.currentTime = 0;
      this.destination = {};
      this.onstatechange = null;
      this.audioWorklet = {
        addModule: async () => {
          stats.addModuleCalls += 1;
          if (env.workletFails) throw new Error('blocked by CSP');
        },
      };
    }
    createMediaStreamSource() {
      return {
        connect() {},
        disconnect() {
          stats.disconnects += 1;
        },
      };
    }
    createGain() {
      const gain = {
        value: 0,
        cancelScheduledValues() {},
        setValueAtTime(v) {
          gain.value = v;
        },
        setTargetAtTime(v) {
          gain.value = v;
        },
      };
      return { gain, connect() {}, disconnect() {} };
    }
    async resume() {
      this.state = 'running';
    }
    async suspend() {
      this.state = 'suspended';
    }
    async close() {
      this.state = 'closed';
    }
  }
  class StubWorkletNode {
    constructor() {
      this.port = { postMessage() {} };
    }
    connect() {}
    disconnect() {}
  }

  const runtimeHandlers = [];
  sandbox.chrome = {
    runtime: {
      id: 'test-extension-id',
      onMessage: {
        addListener(fn) {
          runtimeHandlers.push(fn);
        },
      },
      sendMessage: async (msg) => {
        if (env.invalidated) throw new Error('Extension context invalidated.');
        if (msg && msg.type === 'ENSURE_TAB_HOOKS') {
          stats.ensureHooksCalls += 1;
          return { ok: true };
        }
        if (msg && msg.type === 'GET_TAB_RUNTIME_STATE') {
          if (env.runtimeFails) throw new Error('Could not establish connection. Receiving end does not exist.');
          return { eligible: true, bypass: false, settings: { slow: 0.8, reverbIntensity: 0.5 } };
        }
        return { ok: true };
      },
      getURL: (p) => {
        stats.getURLCalls = (stats.getURLCalls || 0) + 1;
        if (env.getUrlInvalidated) throw new Error('Extension context invalidated.');
        return p;
      },
    },
  };

  const docListeners = {};
  const winListeners = {};
  const mediaElements = [];
  sandbox.document = {
    documentElement: { dataset: {} },
    visibilityState: 'visible',
    querySelectorAll: () => mediaElements.filter((m) => m.isConnected),
    addEventListener: (type, fn) => {
      (docListeners[type] = docListeners[type] || []).push(fn);
    },
  };
  sandbox.window = {
    addEventListener: (type, fn) => {
      (winListeners[type] = winListeners[type] || []).push(fn);
    },
  };
  sandbox.MutationObserver = class {
    constructor() {
      stats.observers = (stats.observers || 0) + 1;
    }
    observe() {}
    disconnect() {}
  };
  sandbox.HTMLMediaElement = StubMedia;
  sandbox.AudioContext = StubAudioContext;
  sandbox.AudioWorkletNode = StubWorkletNode;

  const env = {
    sandbox,
    stats,
    invalidated: false,
    workletFails: false,
    runtimeFails: false,
    docListeners,
    winListeners,
    addMedia(muted) {
      const media = new StubMedia(muted);
      mediaElements.push(media);
      return media;
    },
    fireDoc(type, target) {
      for (const fn of docListeners[type] || []) fn({ target });
    },
    fireWin(type, event) {
      for (const fn of winListeners[type] || []) fn(event);
    },
    sendRuntime(msg) {
      for (const fn of runtimeHandlers) fn(msg, {}, () => {});
    },
    counts: () => ({
      runtimeHandlers: runtimeHandlers.length,
      docListeners: Object.values(docListeners).reduce((n, a) => n + a.length, 0),
      winListeners: Object.values(winListeners).reduce((n, a) => n + a.length, 0),
      observers: stats.observers || 0,
    }),
    async settle(rounds = 8) {
      for (let i = 0; i < rounds; i++) {
        await Promise.resolve();
        await new Promise((r) => realSetTimeout(r, 0));
      }
    },
    advance(ms) {
      clock += ms;
    },
    intervalDelays: () => [...intervals.values()].map((t) => t.ms),
    runIntervalByDelay(ms) {
      const entry = [...intervals.values()].find((t) => t.ms === ms);
      if (!entry) throw new Error('no interval with delay ' + ms + '; have ' + JSON.stringify([...intervals.values()].map((t) => t.ms)));
      return { entry };
    },
  };

  Object.assign(env, opts);

  vm.createContext(sandbox);
  for (const file of ['shared.js', 'content-script.js']) {
    vm.runInContext(read(file), sandbox, { filename: file });
  }
  return env;
}

test('C (contract): bypass overrides the page mute and hands audio back', async () => {
  const env = createContentEnv();
  const media = env.addMedia(true);
  env.fireDoc('play', media);
  for (let i = 0; i < 40 && media.playbackRate !== 0.8; i++) await env.settle(2);
  assert.strictEqual(media.playbackRate, 0.8, 'precondition: effect attached and slowed');
  assert.strictEqual(media.muted, true, 'precondition: attached element is muted');

  env.sendRuntime({ type: 'APPLY_TAB_STATE', bypass: true, settings: { slow: 0.8, reverbIntensity: 0.5 } });
  await env.settle(4);

  assert.strictEqual(media.playbackRate, 1, 'bypass restores the original rate');
  assert.strictEqual(media.muted, false, 'bypass unmutes, even if the page had muted itself');
});

test('D: the 2 s watchdog survives an invalidated extension context', async () => {
  const env = createContentEnv();
  env.getUrlInvalidated = true;
  env.workletFails = true;

  const media = env.addMedia(false);
  env.fireDoc('play', media);
  await env.settle(10);
  env.advance(6000);
  const before = env.stats.getURLCalls || 0;

  const entry = env.runIntervalByDelay(2000).entry;
  assert.doesNotThrow(() => entry.cb(), 'watchdog tick must not throw when chrome.runtime.getURL throws');
  assert.ok((env.stats.getURLCalls || 0) > before, 'watchdog tick must actually reach chrome.runtime.getURL');
});

test('E: re-injecting the ISOLATED content script adds no listeners or observers', async () => {
  const env = createContentEnv();
  await env.settle(4);
  const before = env.counts();
  assert.ok(before.runtimeHandlers >= 1, 'precondition: one runtime.onMessage listener');
  assert.ok(before.docListeners >= 3, 'precondition: document listeners registered');

  vm.runInContext(read('shared.js'), env.sandbox, { filename: 'shared.js' });
  vm.runInContext(read('content-script.js'), env.sandbox, { filename: 'content-script.js' });
  await env.settle(4);

  const after = env.counts();
  assert.deepStrictEqual(after, before, 'guard + refresh() must not double-register (was ' + JSON.stringify(before) + ')');
});

test('F: a dead service worker leaves the page inert but self-heals on the next lifecycle event', async () => {
  const env = createContentEnv({ runtimeFails: true });
  const media = env.addMedia(false);
  env.fireDoc('play', media);
  await env.settle(10);
  assert.strictEqual(media.playbackRate, 1, 'no runtime state => eligible stays false => nothing attaches');

  env.runtimeFails = false;
  env.fireWin('focus', {});
  for (let i = 0; i < 40 && media.playbackRate !== 0.8; i++) await env.settle(2);
  assert.strictEqual(media.playbackRate, 0.8, 'a later focus must retry and attach once the SW answers');
  assert.strictEqual(media.muted, true, 'recovered attach keeps the mute contract');
});

test('G: after a reload the re-injected script retires the orphan instead of adopting it', async () => {
  const env = createContentEnv();
  const media = env.addMedia(false);
  env.fireDoc('play', media);
  for (let i = 0; i < 40 && media.playbackRate !== 0.8; i++) await env.settle(2);
  assert.strictEqual(media.playbackRate, 0.8, 'precondition: old instance attached');
  assert.strictEqual(media.muted, true, 'precondition: old instance holds the mute');

  const oldApi = env.sandbox.__slowedReverbAudioContent;
  env.sandbox.chrome.runtime.id = undefined;
  env.invalidated = true;
  env.getUrlInvalidated = true;

  vm.runInContext(read('shared.js'), env.sandbox, { filename: 'shared.js' });
  vm.runInContext(read('content-script.js'), env.sandbox, { filename: 'content-script.js' });
  await env.settle(4);

  const newApi = env.sandbox.__slowedReverbAudioContent;
  assert.notStrictEqual(newApi, oldApi, 'a dead instance must not be adopted via refresh()');
  assert.strictEqual(typeof oldApi.__testIsRetired, 'function', 'instance API must expose retire()');
  assert.strictEqual(oldApi.__testIsRetired(), true, 'the orphan must be retired');
  assert.strictEqual(media.muted, false, 'retire must hand the element back unmuted (no dead-graph silence)');
  assert.strictEqual(media.playbackRate, 1, 'retire must restore the original rate');

  const delays = env.intervalDelays();
  assert.ok(delays.filter((d) => d === 2000).length <= 1, 'at most one 2 s watchdog: ' + JSON.stringify(delays));
  assert.ok(delays.filter((d) => d === 5000).length <= 1, 'at most one 5 s safety poll: ' + JSON.stringify(delays));
});
