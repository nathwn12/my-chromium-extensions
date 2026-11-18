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

function loadPageHook(opts) {
  opts = opts || {};
  const posted = [];
  const listeners = [];
  const timers = [];
  let timerId = 1;
  const sandbox = {
    console,
    Uint8Array,
    Date,
    Math,
    JSON,
    String,
    // A real MAIN world always has timers; the hook polls player volume on one.
    setTimeout(fn, ms) {
      const id = timerId++;
      timers.push({ id, fn, ms, repeat: false });
      return id;
    },
    clearTimeout(id) {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
    setInterval(fn, ms) {
      const id = timerId++;
      timers.push({ id, fn, ms, repeat: true });
      return id;
    },
    clearInterval(id) {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
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
    querySelector: () => opts.player || null,
    querySelectorAll: () => (opts.players ? opts.players : opts.player ? [opts.player] : []),
  };
  sandbox.location = { href: 'https://music.youtube.com/watch?v=x', origin: 'https://music.youtube.com' };
  vm.createContext(sandbox);
  vm.runInContext(read('page-hook.js'), sandbox, { filename: 'page-hook.js' });
  const fireWindow = (type, event) => {
    for (const entry of listeners) if (entry.type === type) entry.fn(event);
  };
  return { posted, listeners, sandbox, fireWindow };
}

test('A3: a song query replies with the id the player reports now', () => {
  const player = {
    getVideoData: () => ({ video_id: 'song-read-now', title: 'Read now' }),
  };
  const { posted, sandbox, fireWindow } = loadPageHook({ player });
  fireWindow('message', {
    source: sandbox.window,
    data: { __slra: true, type: 'SLRA_QUERY_SONG', id: 7, token: 'token-minted-by-content-script' },
  });
  const reply = posted.find((m) => m && m.type === 'SLRA_SONG_STATE');
  assert.ok(reply, 'the hook must answer a query');
  assert.equal(reply.id, 7, 'the reply carries the correlation id');
  assert.equal(reply.videoId, 'song-read-now', 'and the id the player reports');
});

test('A4: a song query with a wrong token, or an unreadable player, replies null', () => {
  const player = { getVideoData: () => ({ video_id: 'song-read-now' }) };
  const wrong = loadPageHook({ player });
  wrong.fireWindow('message', {
    source: wrong.sandbox.window,
    data: { __slra: true, type: 'SLRA_QUERY_SONG', id: 8, token: 'not-the-token' },
  });
  assert.equal(wrong.posted.filter((m) => m && m.type === 'SLRA_SONG_STATE').length, 0, 'a wrong token is ignored');

  const empty = loadPageHook();
  empty.fireWindow('message', {
    source: empty.sandbox.window,
    data: { __slra: true, type: 'SLRA_QUERY_SONG', id: 9, token: 'token-minted-by-content-script' },
  });
  const reply = empty.posted.find((m) => m && m.type === 'SLRA_SONG_STATE');
  assert.ok(reply, 'an unreadable player still answers');
  assert.equal(reply.videoId, null, 'with no id, never with a guess');
});

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
    URL,
    queueMicrotask,
  };

  // A test can hold timeouts to model "no answer yet" for an async request.
  const heldTimeouts = [];
  sandbox.setTimeout = (cb) => {
    if (env.holdTimeouts) {
      heldTimeouts.push(cb);
      return -heldTimeouts.length;
    }
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
          return {
            eligible: true,
            bypass: false,
            settings: env.runtimeSettings || { slow: 0.8, reverbIntensity: 0.5 },
          };
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
  const posted = [];
  sandbox.window = {
    addEventListener: (type, fn) => {
      (winListeners[type] = winListeners[type] || []).push(fn);
    },
    postMessage: (msg) => {
      posted.push(msg);
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
    posted,
    heldTimeouts,
    holdTimeouts: false,
    flushHeldTimeouts() {
      const list = heldTimeouts.splice(0);
      for (const cb of list) cb();
    },
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
    fireDoc(type, target, props) {
      for (const fn of docListeners[type] || []) fn({ target, ...(props || {}) });
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

  // The content script reads the facade off globalThis. A test that needs to
  // observe the hand-off swaps in a recorder instead of the real UI module.
  if (env.playerActions) sandbox.SlowedReverbPlayerActions = env.playerActions;

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

/*
 * The volume hand-off: the content script owns the stored wheel volume, the
 * player controller is the only thing that can apply it. These tests record the
 * facade the content script actually calls, so a wiring regression shows up as
 * a missing or duplicated call instead of as a green static pattern.
 */
function createPlayerActionsRecorder() {
  const instances = [];
  const api = {
    createPlayerActions() {
      const instance = {
        restoreCalls: [],
        playerVolumeCalls: [],
        songIds: [],
        invalidations: 0,
        suspends: 0,
        started: 0,
        stopped: 0,
        syncs: 0,
        restoreVolume(percent) {
          instance.restoreCalls.push(percent);
        },
        setPlayerVolume(percent, options) {
          instance.playerVolumeCalls.push({ percent: percent, user: Boolean(options && options.user) });
        },
        setSongId(id, href) {
          instance.songIds.push({ id: id, href: href });
        },
        invalidateSongIdentity() {
          instance.invalidations += 1;
        },
        suspendSongIdentity() {
          instance.suspends += 1;
        },
        start() {
          instance.started += 1;
        },
        stop() {
          instance.stopped += 1;
        },
        sync() {
          instance.syncs += 1;
        },
      };
      instances.push(instance);
      return instance;
    },
  };
  return { api, instances };
}

function pushPageVolume(env, payload) {
  env.fireWin('message', {
    source: env.sandbox.window,
    origin: 'https://music.youtube.com',
    data: {
      __slra: true,
      type: 'SLRA_VOLUME_STATE',
      token: env.sandbox.__slowedReverbAudioContent.__testGetHookToken(),
      applied: false,
      source: 'player',
      ...payload,
    },
  });
}

test('A5: an ambiguous player DOM answers null, never a guess', () => {
  const first = { getVideoData: () => ({ video_id: 'song-a' }) };
  const second = { getVideoData: () => ({ video_id: 'song-b' }) };
  const { posted, sandbox, fireWindow } = loadPageHook({ players: [first, second] });
  fireWindow('message', {
    source: sandbox.window,
    data: { __slra: true, type: 'SLRA_QUERY_SONG', id: 11, token: 'token-minted-by-content-script' },
  });
  const reply = posted.find((m) => m && m.type === 'SLRA_SONG_STATE');
  assert.ok(reply, 'an ambiguous DOM still answers');
  assert.equal(reply.videoId, null, 'two player nodes are not an identity');
});

function pushHookReady(env) {
  env.fireWin('message', {
    source: env.sandbox.window,
    origin: 'https://music.youtube.com',
    data: { __slra: true, type: 'SLRA_PAGE_HOOK_READY', token: env.sandbox.__slowedReverbAudioContent.__testGetHookToken() },
  });
}

function replyPageSongState(env, payload) {
  env.fireWin('message', {
    source: env.sandbox.window,
    origin: 'https://music.youtube.com',
    data: {
      __slra: true,
      type: 'SLRA_SONG_STATE',
      token: env.sandbox.__slowedReverbAudioContent.__testGetHookToken(),
      ...payload,
    },
  });
}

function songQueries(env) {
  return env.posted.filter((message) => message && message.type === 'SLRA_QUERY_SONG');
}

test('M: a source change asks the player for its id instead of guessing', async () => {
  const recorder = createPlayerActionsRecorder();
  const env = createContentEnv({
    playerActions: recorder.api,
    runtimeSettings: { slow: 0.8, reverbIntensity: 0.5, volume: 20 },
  });
  const media = env.addMedia(false);
  env.fireDoc('play', media);
  await env.settle(6);
  env.holdTimeouts = true;
  pushHookReady(env);
  pushPageSong(env, { videoId: 'song-a', href: 'https://music.youtube.com/' });
  await env.settle(2);
  assert.equal(songQueries(env).length, 0, 'no read before the source changes');

  // The element loads a new source: the event is a trigger, never an identity.
  env.fireDoc('loadedmetadata', media);
  await env.settle(2);
  const query = songQueries(env)[0];
  assert.ok(query, 'a source change must ask the player what it holds');
  assert.equal(query.token, env.sandbox.__slowedReverbAudioContent.__testGetHookToken());

  replyPageSongState(env, { id: query.id, videoId: 'song-b', href: 'https://music.youtube.com/' });
  await env.settle(2);
  assert.deepEqual(
    recorder.instances[0].songIds.at(-1),
    { id: 'song-b', href: 'https://music.youtube.com/' },
    'the id the player reported is adopted'
  );
  assert.equal(recorder.instances[0].invalidations, 0, 'a readable id is not an invalidation');
});

test('P: a read that never answers invalidates, never keeps the old id', async () => {
  const recorder = createPlayerActionsRecorder();
  const env = createContentEnv({
    playerActions: recorder.api,
    runtimeSettings: { slow: 0.8, reverbIntensity: 0.5, volume: 20 },
  });
  const media = env.addMedia(false);
  env.fireDoc('play', media);
  await env.settle(6);
  env.holdTimeouts = true;
  pushHookReady(env);
  pushPageSong(env, { videoId: 'song-a', href: 'https://music.youtube.com/' });
  await env.settle(2);

  env.fireDoc('loadedmetadata', media);
  await env.settle(2);
  assert.equal(songQueries(env).length, 1, 'the read was asked for');
  env.flushHeldTimeouts();
  await env.settle(2);
  assert.equal(recorder.instances[0].invalidations, 1, 'no answer is no identity');
});

test('S: a source change after playback voids a same-id push', async () => {
  const recorder = createPlayerActionsRecorder();
  const env = createContentEnv({
    playerActions: recorder.api,
    runtimeSettings: { slow: 0.8, reverbIntensity: 0.5, volume: 20 },
  });
  const media = env.addMedia(false);
  env.fireDoc('play', media);
  await env.settle(6);
  env.holdTimeouts = true;
  pushHookReady(env);
  const href = 'https://music.youtube.com/';
  pushPageSong(env, { videoId: 'song-a', href });
  await env.settle(2);

  // The song has played, then the element reports a new source.
  media.currentTime = 45;
  env.fireDoc('timeupdate', media);
  env.fireDoc('loadedmetadata', media);
  await env.settle(2);

  // The player still reports the old song: that is not evidence the new source
  // is that song, so the section must not be re-applied.
  pushPageSong(env, { videoId: 'song-a', href });
  await env.settle(2);
  assert.equal(recorder.instances[0].invalidations, 1, 'a same-id read after a source change invalidates');
  assert.equal(recorder.instances[0].songIds.length, 1, 'and is not delivered as a confirmation');
});

test('T: a source change after playback voids a same-id pull too', async () => {
  const recorder = createPlayerActionsRecorder();
  const env = createContentEnv({
    playerActions: recorder.api,
    runtimeSettings: { slow: 0.8, reverbIntensity: 0.5, volume: 20 },
  });
  const media = env.addMedia(false);
  env.fireDoc('play', media);
  await env.settle(6);
  env.holdTimeouts = true;
  pushHookReady(env);
  const href = 'https://music.youtube.com/';
  pushPageSong(env, { videoId: 'song-a', href });
  await env.settle(2);

  media.currentTime = 45;
  env.fireDoc('timeupdate', media);
  env.fireDoc('emptied', media);
  await env.settle(2);
  replyPageSongState(env, { id: songQueries(env)[0].id, videoId: 'song-a', href });
  await env.settle(2);
  assert.equal(recorder.instances[0].invalidations, 1, 'the same id is not a confirmation');
});

test('S2: a same-id query after a source change confirms the visit when URL, href and element agree', async () => {
  const recorder = createPlayerActionsRecorder();
  const env = createContentEnv({
    playerActions: recorder.api,
    runtimeSettings: { slow: 0.8, reverbIntensity: 0.5, volume: 20 },
  });
  const href = 'https://music.youtube.com/watch?v=song-a';
  env.sandbox.location.href = href;
  const media = env.addMedia(false);
  env.fireDoc('play', media);
  await env.settle(6);
  env.holdTimeouts = true;
  pushHookReady(env);
  pushPageSong(env, { videoId: 'song-a', href });
  await env.settle(2);

  media.currentTime = 45;
  env.fireDoc('timeupdate', media);
  env.fireDoc('loadedmetadata', media);
  await env.settle(2);
  assert.ok(recorder.instances[0].suspends >= 1, 'the source change suspends the section while the read is in flight');
  replyPageSongState(env, { id: songQueries(env)[0].id, videoId: 'song-a', href });
  await env.settle(2);

  // A same song reloaded on its own element is a confirmation, not a swap: the
  // visit survives, the id is re-delivered with its own provenance, and the
  // armed section keeps its From/To (it still loops back to From at the To mark
  // instead of running on to the end of the song).
  assert.equal(recorder.instances[0].invalidations, 0, 'the armed section is not dropped');
  assert.deepEqual(
    recorder.instances[0].songIds.at(-1),
    { id: 'song-a', href },
    'the id is re-confirmed with the navigation it was read in'
  );
});

test('S3: a same-id push after a source change confirms the visit under the same provenance', async () => {
  const recorder = createPlayerActionsRecorder();
  const env = createContentEnv({
    playerActions: recorder.api,
    runtimeSettings: { slow: 0.8, reverbIntensity: 0.5, volume: 20 },
  });
  const href = 'https://music.youtube.com/watch?v=song-a';
  env.sandbox.location.href = href;
  const media = env.addMedia(false);
  env.fireDoc('play', media);
  await env.settle(6);
  env.holdTimeouts = true;
  pushHookReady(env);
  pushPageSong(env, { videoId: 'song-a', href });
  await env.settle(2);

  media.currentTime = 45;
  env.fireDoc('timeupdate', media);
  env.fireDoc('emptied', media);
  await env.settle(2);
  pushPageSong(env, { videoId: 'song-a', href });
  await env.settle(2);

  assert.equal(recorder.instances[0].invalidations, 0, 'the push is a confirmation, not a stale id');
  assert.deepEqual(
    recorder.instances[0].songIds.at(-1),
    { id: 'song-a', href },
    'the same song is re-adopted with its own provenance'
  );
});

test('S4: a same-id answer still invalidates when the reloaded element is not the tracked one', async () => {
  const recorder = createPlayerActionsRecorder();
  const env = createContentEnv({
    playerActions: recorder.api,
    runtimeSettings: { slow: 0.8, reverbIntensity: 0.5, volume: 20 },
  });
  const href = 'https://music.youtube.com/watch?v=song-a';
  env.sandbox.location.href = href;
  const media = env.addMedia(false);
  env.fireDoc('play', media);
  await env.settle(6);
  env.holdTimeouts = true;
  pushHookReady(env);
  pushPageSong(env, { videoId: 'song-a', href });
  await env.settle(2);

  media.currentTime = 45;
  env.fireDoc('timeupdate', media);
  const other = env.addMedia(false);
  env.fireDoc('loadedmetadata', other);
  await env.settle(2);
  replyPageSongState(env, { id: songQueries(env)[0].id, videoId: 'song-a', href });
  await env.settle(2);

  assert.equal(recorder.instances[0].invalidations, 1, 'an element other than the tracked one is not a confirmation');
});

test('U: a different id after a source change is adopted, and recovery works', async () => {
  const recorder = createPlayerActionsRecorder();
  const env = createContentEnv({
    playerActions: recorder.api,
    runtimeSettings: { slow: 0.8, reverbIntensity: 0.5, volume: 20 },
  });
  const media = env.addMedia(false);
  env.fireDoc('play', media);
  await env.settle(6);
  env.holdTimeouts = true;
  pushHookReady(env);
  const href = 'https://music.youtube.com/';
  pushPageSong(env, { videoId: 'song-a', href });
  await env.settle(2);

  media.currentTime = 45;
  env.fireDoc('timeupdate', media);
  env.fireDoc('loadedmetadata', media);
  await env.settle(2);
  pushPageSong(env, { videoId: 'song-b', href });
  await env.settle(2);
  assert.deepEqual(recorder.instances[0].songIds.at(-1), { id: 'song-b', href }, 'the new song is adopted');
  assert.equal(recorder.instances[0].invalidations, 0, 'a differing id is evidence');
});

test('V: a first load is not a change of song', async () => {
  const recorder = createPlayerActionsRecorder();
  const env = createContentEnv({
    playerActions: recorder.api,
    runtimeSettings: { slow: 0.8, reverbIntensity: 0.5, volume: 20 },
  });
  const media = env.addMedia(false);
  env.fireDoc('play', media);
  await env.settle(6);
  env.holdTimeouts = true;
  pushHookReady(env);
  const href = 'https://music.youtube.com/';
  pushPageSong(env, { videoId: 'song-a', href });
  await env.settle(2);

  // Nothing has played yet: metadata for this same song is not a source change
  // under a live identity.
  env.fireDoc('loadedmetadata', media);
  await env.settle(2);
  pushPageSong(env, { videoId: 'song-a', href });
  await env.settle(2);
  assert.equal(recorder.instances[0].invalidations, 0, 'a fresh load must not void the section');
  assert.equal(recorder.instances[0].songIds.length, 2, 'the id is delivered as before');
});

test('Q: a stale read cannot move the cached provenance of an unchanged id', async () => {
  const recorder = createPlayerActionsRecorder();
  const env = createContentEnv({
    playerActions: recorder.api,
    runtimeSettings: { slow: 0.8, reverbIntensity: 0.5, volume: 20 },
  });
  const media = env.addMedia(false);
  env.fireDoc('play', media);
  await env.settle(6);
  env.holdTimeouts = true;
  pushHookReady(env);

  const hrefA = 'https://music.youtube.com/watch?v=song-a';
  pushPageSong(env, { videoId: 'song-a', href: hrefA });
  await env.settle(2);

  // The URL moves to B; a source event triggers a read while the player still
  // reports A. The hook's own href is the URL it is in now (B).
  env.sandbox.location.href = 'https://music.youtube.com/watch?v=song-b';
  env.fireDoc('loadedmetadata', media);
  await env.settle(2);
  replyPageSongState(env, {
    id: songQueries(env)[0].id,
    videoId: 'song-a',
    href: 'https://music.youtube.com/watch?v=song-b',
  });
  await env.settle(2);

  // A recreated controller replays the cached push.
  env.sendRuntime({ type: 'APPLY_TAB_STATE', bypass: true, settings: { slow: 0.8, reverbIntensity: 0.5 } });
  await env.settle(2);
  env.sendRuntime({ type: 'APPLY_TAB_STATE', bypass: false, settings: { slow: 0.8, reverbIntensity: 0.5 } });
  await env.settle(6);

  assert.deepEqual(
    recorder.instances[1].songIds.at(-1),
    { id: 'song-a', href: hrefA },
    'an unchanged id keeps the navigation it was read in'
  );
});

test('R: a read in flight suspends the armed section', async () => {
  const recorder = createPlayerActionsRecorder();
  const env = createContentEnv({
    playerActions: recorder.api,
    runtimeSettings: { slow: 0.8, reverbIntensity: 0.5, volume: 20 },
  });
  const media = env.addMedia(false);
  env.fireDoc('play', media);
  await env.settle(6);
  env.holdTimeouts = true;
  pushHookReady(env);
  pushPageSong(env, { videoId: 'song-a', href: 'https://music.youtube.com/' });
  await env.settle(2);

  env.fireDoc('loadedmetadata', media);
  await env.settle(2);
  assert.equal(songQueries(env).length, 1, 'the read was asked for');
  assert.equal(recorder.instances[0].suspends, 1, 'nothing may seek while the id is being re-read');
});

test('M2: a player/navigation signal asks the player too', async () => {
  const recorder = createPlayerActionsRecorder();
  const env = createContentEnv({
    playerActions: recorder.api,
    runtimeSettings: { slow: 0.8, reverbIntensity: 0.5, volume: 20 },
  });
  const media = env.addMedia(false);
  env.fireDoc('play', media);
  await env.settle(6);
  env.holdTimeouts = true;
  pushHookReady(env);
  pushPageSong(env, { videoId: 'song-a', href: 'https://music.youtube.com/' });
  await env.settle(2);

  env.fireWin('yt-player-updated', {});
  await env.settle(2);
  assert.equal(songQueries(env).length, 1, 'a player update asks for the id');
  replyPageSongState(env, { id: songQueries(env)[0].id, videoId: 'song-b', href: 'https://music.youtube.com/' });
  await env.settle(2);
  assert.equal(recorder.instances[0].songIds.at(-1).id, 'song-b', 'and adopts what it reads');
});

test('N: an unreadable player invalidates instead of keeping the old id', async () => {
  const recorder = createPlayerActionsRecorder();
  const env = createContentEnv({
    playerActions: recorder.api,
    runtimeSettings: { slow: 0.8, reverbIntensity: 0.5, volume: 20 },
  });
  const media = env.addMedia(false);
  env.fireDoc('play', media);
  await env.settle(6);
  env.holdTimeouts = true;
  pushHookReady(env);
  pushPageSong(env, { videoId: 'song-a', href: 'https://music.youtube.com/' });
  await env.settle(2);

  env.fireDoc('loadedmetadata', media);
  await env.settle(2);
  replyPageSongState(env, { id: songQueries(env)[0].id, videoId: null });
  await env.settle(2);
  assert.equal(recorder.instances[0].invalidations, 1, 'no readable id means the visit is dropped');
});

test('O: a push that lands before the reply wins, and a stale reply is discarded', async () => {
  const recorder = createPlayerActionsRecorder();
  const env = createContentEnv({
    playerActions: recorder.api,
    runtimeSettings: { slow: 0.8, reverbIntensity: 0.5, volume: 20 },
  });
  const media = env.addMedia(false);
  env.fireDoc('play', media);
  await env.settle(6);
  env.holdTimeouts = true;
  pushHookReady(env);
  pushPageSong(env, { videoId: 'song-a', href: 'https://music.youtube.com/' });
  await env.settle(2);

  env.fireDoc('emptied', media);
  await env.settle(2);
  const first = songQueries(env)[0];
  // The player pushes the real id while the read is in flight.
  pushPageSong(env, { videoId: 'song-b', href: 'https://music.youtube.com/' });
  await env.settle(2);
  // The read comes back for the old song: it is older than the push.
  replyPageSongState(env, { id: first.id, videoId: 'song-a', href: 'https://music.youtube.com/' });
  await env.settle(2);
  assert.deepEqual(
    recorder.instances[0].songIds.at(-1),
    { id: 'song-b', href: 'https://music.youtube.com/' },
    'the push is preserved'
  );
  assert.equal(
    recorder.instances[0].songIds.filter((entry) => entry.id === 'song-a').length,
    1,
    'the stale read never re-adopts the old song'
  );
});

test('H: the stored wheel volume reaches the live player controller, once', async () => {
  const recorder = createPlayerActionsRecorder();
  const env = createContentEnv({
    playerActions: recorder.api,
    runtimeSettings: { slow: 0.8, reverbIntensity: 0.5, volume: 20 },
  });
  const media = env.addMedia(false);
  env.fireDoc('play', media);
  for (let i = 0; i < 20 && recorder.instances.length === 0; i++) await env.settle(2);
  await env.settle(6);

  assert.equal(recorder.instances.length, 1, 'one player controller owns the tab');
  assert.deepEqual(
    recorder.instances[0].restoreCalls,
    [20],
    'the stored volume must be handed to the controller that can apply it'
  );

  // A later state push carries the last saved settings; re-arming the hand-off
  // is what wrote an older volume over a fresh wheel step.
  env.sendRuntime({
    type: 'APPLY_TAB_STATE',
    eligible: true,
    bypass: false,
    settings: { slow: 0.8, reverbIntensity: 0.5, volume: 35 },
  });
  await env.settle(6);
  assert.deepEqual(recorder.instances[0].restoreCalls, [20], 'a push must never re-arm the hand-off');
});

function pushPageSong(env, payload) {
  env.fireWin('message', {
    source: env.sandbox.window,
    origin: 'https://music.youtube.com',
    data: {
      __slra: true,
      type: 'SLRA_SONG',
      token: env.sandbox.__slowedReverbAudioContent.__testGetHookToken(),
      href: 'https://music.youtube.com/watch?v=song-a',
      ...payload,
    },
  });
}

test('J: a recreated controller replays the push with the href it was taken in', async () => {
  const recorder = createPlayerActionsRecorder();
  const env = createContentEnv({
    playerActions: recorder.api,
    runtimeSettings: { slow: 0.8, reverbIntensity: 0.5, volume: 20 },
  });
  const media = env.addMedia(false);
  env.fireDoc('play', media);
  await env.settle(6);

  const hrefA = 'https://music.youtube.com/watch?v=song-a';
  pushPageSong(env, { videoId: 'song-a', href: hrefA });
  await env.settle(2);
  assert.deepEqual(
    recorder.instances[0].songIds,
    [{ id: 'song-a', href: hrefA }],
    'the first delivery carries the href the push was taken in'
  );

  // Bypass off and on tears the controller down and builds a new one, which
  // replays the cached push. The href must travel with it: anchoring a stale id
  // to the current URL is what let song A's section run on song B.
  env.sendRuntime({ type: 'APPLY_TAB_STATE', bypass: true, settings: { slow: 0.8, reverbIntensity: 0.5 } });
  await env.settle(2);
  env.sendRuntime({ type: 'APPLY_TAB_STATE', bypass: false, settings: { slow: 0.8, reverbIntensity: 0.5 } });
  await env.settle(6);

  assert.equal(recorder.instances.length, 2, 'a second controller was created');
  assert.deepEqual(
    recorder.instances[1].songIds,
    [{ id: 'song-a', href: hrefA }],
    'the replay must carry the push href, never the URL current at replay time'
  );
});

function volumeSliderTarget() {
  return {
    closest(selector) {
      return String(selector).includes('#volume-slider') ? {} : null;
    },
  };
}

test('K: only a trusted move of the volume slider is a user change', async () => {
  const recorder = createPlayerActionsRecorder();
  const env = createContentEnv({
    playerActions: recorder.api,
    runtimeSettings: { slow: 0.8, reverbIntensity: 0.5, volume: 20 },
  });
  const media = env.addMedia(false);
  env.fireDoc('play', media);
  await env.settle(6);
  const calls = recorder.instances[0].playerVolumeCalls;

  // A page script can post this message with a correct token.
  pushPageVolume(env, { volume: 65, reason: 'slider' });
  await env.settle(4);
  assert.deepEqual(calls[0], { percent: 65, user: false }, 'a forged push may adopt the value, never the intent');

  // A trusted gesture that is not the volume slider is not this control.
  env.fireDoc('input', { closest: () => null }, { isTrusted: true });
  pushPageVolume(env, { volume: 66, reason: 'slider' });
  await env.settle(4);
  assert.deepEqual(calls[1], { percent: 66, user: false }, 'a click elsewhere must not authorise the push');

  // An untrusted event on the slider is synthetic, not the user.
  env.fireDoc('input', volumeSliderTarget());
  pushPageVolume(env, { volume: 67, reason: 'slider' });
  await env.settle(4);
  assert.deepEqual(calls[2], { percent: 67, user: false }, 'an untrusted slider event is not a gesture');

  // A trusted slider input is the user.
  env.fireDoc('input', volumeSliderTarget(), { isTrusted: true });
  pushPageVolume(env, { volume: 70, reason: 'slider' });
  await env.settle(4);
  assert.deepEqual(calls[3], { percent: 70, user: true }, 'a real slider move makes the push a user change');
});

test('L: a slow drag keeps its trust alive and an old one expires', async () => {
  const recorder = createPlayerActionsRecorder();
  const env = createContentEnv({
    playerActions: recorder.api,
    runtimeSettings: { slow: 0.8, reverbIntensity: 0.5, volume: 20 },
  });
  const media = env.addMedia(false);
  env.fireDoc('play', media);
  await env.settle(6);
  const calls = recorder.instances[0].playerVolumeCalls;

  // A drag lasting several seconds emits input events the whole way; the final
  // value is pushed at the end, far from the first event.
  env.fireDoc('input', volumeSliderTarget(), { isTrusted: true });
  env.advance(2000);
  env.fireDoc('input', volumeSliderTarget(), { isTrusted: true });
  env.advance(2000);
  pushPageVolume(env, { volume: 40, reason: 'slider' });
  await env.settle(4);
  assert.deepEqual(calls[0], { percent: 40, user: true }, 'the drag end is still the user');

  // Long after any input, trust is gone.
  env.advance(3500);
  pushPageVolume(env, { volume: 80, reason: 'slider' });
  await env.settle(4);
  assert.deepEqual(calls[1], { percent: 80, user: false }, 'an expired trust is not a user change');
});

test('I: only a native slider drag outranks a pending restore', async () => {
  const recorder = createPlayerActionsRecorder();
  const env = createContentEnv({
    playerActions: recorder.api,
    runtimeSettings: { slow: 0.8, reverbIntensity: 0.5, volume: 20 },
  });
  const media = env.addMedia(false);
  env.fireDoc('play', media);
  await env.settle(6);

  // A real drag is a trusted input on the volume slider itself.
  env.fireDoc('input', volumeSliderTarget(), { isTrusted: true });
  pushPageVolume(env, { volume: 65, reason: 'slider' });
  pushPageVolume(env, { volume: 40, reason: 'poll' });
  await env.settle(4);

  const calls = recorder.instances[0].playerVolumeCalls;
  assert.deepEqual(
    calls,
    [
      { percent: 65, user: true },
      { percent: 40, user: false },
    ],
    'a slider drag is a user change; a poll is only a reading'
  );
});
