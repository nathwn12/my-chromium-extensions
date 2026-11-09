'use strict';

/* global require, process, __dirname */

/*
 * test/tap-lifetime.test.js - YouTube Music transition matrix for the
 * captureStream tap.
 *
 * The tap is per ELEMENT, not per URL: music.youtube.com rotates googlevideo
 * URLs (quality switches, ads, next/prev, radio, search-to-play) without
 * replacing the <video>. A currentSrc change must never tear the graph down.
 * Only a genuine `emptied`/`loadedmetadata` swaps the MediaStreamSource, and
 * that swap must stay muted (hardZero -> confirm muted -> ramp) so there is no
 * dry gap.
 *
 * SAFETY (AGENTS.md ## Verification safety): plain Node only. The REAL
 * content-script.js runs against stubbed browser globals. No browser, no
 * AudioContext device, no playback.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createEnv() {
  const stats = {
    captures: 0,
    contexts: 0,
    disconnects: 0,
    resumes: 0,
    addModules: 0,
    tracks: [],
    gains: [],
  };

  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let timerId = 1;
  const timers = new Map();
  globalThis.setTimeout = (cb, ms) => {
    const id = timerId++;
    timers.set(id, { cb, ms });
    return id;
  };
  globalThis.clearTimeout = (id) => {
    timers.delete(id);
  };
  const intervals = new Map();
  let intervalId = 100000;
  globalThis.setInterval = (cb, ms) => {
    const id = intervalId++;
    intervals.set(id, { cb, ms });
    return id;
  };
  globalThis.clearInterval = (id) => {
    intervals.delete(id);
  };

  const realLocation = globalThis.location;
  globalThis.location = { origin: 'https://music.youtube.com', href: 'https://music.youtube.com/' };
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  function advance(ms) {
    clock += ms;
  }
  function runTimers(max = 1000) {
    let n = 0;
    while (timers.size > 0 && n < max) {
      const first = timers.entries().next().value;
      timers.delete(first[0]);
      n++;
      first[1].cb();
    }
    return n;
  }
  async function drainTimers(max = 1000) {
    let n = 0;
    while (timers.size > 0 && n < max) {
      const first = timers.entries().next().value;
      timers.delete(first[0]);
      n++;
      first[1].cb();
      await Promise.resolve();
    }
    return n;
  }

  const mediaElements = [];
  class StubMedia extends EventTarget {
    constructor() {
      super();
      this.playbackRate = 1;
      this.preservesPitch = true;
      this.mozPreservesPitch = true;
      this.webkitPreservesPitch = true;
      this._muted = false;
      this.mutedWrites = [];
      this.volume = 1;
      this.paused = false;
      this.pauseCalled = false;
      this.ended = false;
      this.readyState = 4;
      this.currentSrc = 'https://music.youtube.com/stream/v1';
      this.srcObject = null;
      this.isConnected = true;
      this.listeners = new Set();
    }

    get muted() {
      return this._muted;
    }

    set muted(value) {
      const next = Boolean(value);
      if (next === this._muted) return;
      this._muted = next;
      this.mutedWrites.push(next);
    }

    addEventListener(type, fn, opts) {
      this.listeners.add(type + ':' + String(fn));
      super.addEventListener(type, fn, opts);
    }

    removeEventListener(type, fn, opts) {
      this.listeners.delete(type + ':' + String(fn));
      super.removeEventListener(type, fn, opts);
    }

    pause() {
      this.paused = true;
      this.pauseCalled = true;
    }

    captureStream() {
      stats.captures += 1;
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
  StubMedia.HAVE_NOTHING = 0;
  StubMedia.HAVE_METADATA = 1;
  StubMedia.HAVE_CURRENT_DATA = 2;
  StubMedia.HAVE_FUTURE_DATA = 3;
  StubMedia.HAVE_ENOUGH_DATA = 4;

  function makeGain() {
    const holder = { current: 0 };
    return {
      get value() {
        return holder.current;
      },
      set value(v) {
        holder.current = v;
      },
      cancelScheduledValues() {},
      setValueAtTime(value) {
        holder.current = value;
      },
      setTargetAtTime(value) {
        holder.current = value;
      },
    };
  }

  class StubAudioContext {
    constructor() {
      stats.contexts += 1;
      this.state = 'running';
      this.currentTime = 0;
      this.destination = {};
      this.onstatechange = null;
      this.audioWorklet = { addModule: async () => { stats.addModules += 1; } };
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
      const gain = makeGain();
      stats.gains.push(gain);
      return { gain, connect() {}, disconnect() {} };
    }
    async resume() {
      stats.resumes += 1;
      this.state = 'running';
    }
    async suspend() {
      this.state = 'suspended';
    }
    setState(next) {
      this.state = next;
      queueMicrotask(() => {
        if (typeof this.onstatechange === 'function') this.onstatechange();
      });
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
  globalThis.chrome = {
    runtime: {
      id: 'test-extension-id',
      onMessage: {
        addListener(fn) {
          runtimeHandlers.push(fn);
        },
      },
      sendMessage: async (msg) => {
        if (msg && msg.type === 'GET_TAB_RUNTIME_STATE') {
          return { eligible: true, bypass: false, settings: { slow: 0.8, reverbIntensity: 0.5 } };
        }
        return { ok: true };
      },
      getURL: (p) => String(p),
    },
  };

  const docListeners = {};
  const winListeners = {};
  const stubObservers = [];
  globalThis.document = {
    documentElement: { dataset: {} },
    visibilityState: 'visible',
    querySelectorAll: () => {
      return mediaElements.filter((m) => m.isConnected);
    },
    addEventListener: (type, fn) => {
      (docListeners[type] = docListeners[type] || []).push(fn);
    },
  };
  globalThis.window = {
    addEventListener: (type, fn) => {
      (winListeners[type] = winListeners[type] || []).push(fn);
    },
  };
  globalThis.MutationObserver = class {
    constructor(cb) {
      this.callback = cb;
      this.targets = [];
      stubObservers.push(this);
    }
    observe(target, options) {
      this.targets.push({ target, options });
    }
    disconnect() {}
  };
  globalThis.HTMLMediaElement = StubMedia;
  globalThis.AudioContext = StubAudioContext;
  globalThis.AudioWorkletNode = StubWorkletNode;

  const root = path.join(__dirname, '..');
  for (const file of ['shared.js', 'content-script.js']) {
    const full = path.join(root, file);
    vm.runInThisContext(fs.readFileSync(full, 'utf8'), { filename: full });
  }

  function sendRuntime(msg) {
    for (const fn of runtimeHandlers) fn(msg, {}, () => {});
  }
  function queryLive() {
    let out = null;
    for (const fn of runtimeHandlers) fn({ type: 'GET_LIVE_STATUS' }, {}, (v) => { out = v; });
    return out;
  }
  function fireDoc(type, target) {
    for (const fn of docListeners[type] || []) fn({ target });
  }
  function fireWin(type, event) {
    for (const fn of winListeners[type] || []) fn(event);
  }
  function addMedia() {
    const media = new StubMedia();
    mediaElements.push(media);
    return media;
  }
  async function settle(rounds = 8) {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve();
      await new Promise((resolve) => realSetTimeout(resolve, 0));
    }
  }
  function restoreTimers() {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    globalThis.location = realLocation;
    Date.now = realNow;
  }
  function fireObserver(records) {
    for (const obs of stubObservers) obs.callback(records);
  }

  return {
    stats,
    sendRuntime,
    queryLive,
    fireDoc,
    fireWin,
    fireObserver,
    addMedia,
    settle,
    runTimers,
    drainTimers,
    advance,
    restoreTimers,
    pendingTimers: () => timers.size,
    runIntervals: async () => {
      const pending = [...intervals.values()];
      intervals.clear();
      for (const entry of pending) {
        try {
          entry.cb();
        } catch {
          // Best effort only.
        }
        await Promise.resolve();
      }
      return pending.length;
    },
    document: globalThis.document,
  };
}

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log('ok   ' + name);
    return;
  }
  const message = name + (detail ? ' (' + detail + ')' : '');
  failures.push(message);
  console.log('FAIL ' + message);
}

async function main() {
  const env = createEnv();
  await env.settle(6);
  const media = env.addMedia();

  async function drive() {
    env.sendRuntime({ type: 'SLRA_PAGE_REVIVE', reason: 'matrix' });
    await env.settle(2);
    env.runTimers(200);
    await env.settle(2);
  }

  async function attached() {
    for (let i = 0; i < 60; i++) {
      await env.settle(2);
      env.runTimers(100);
      if (media.muted === true && Math.abs(media.playbackRate - 0.8) < 1e-9) return true;
    }
    return false;
  }

  env.fireDoc('play', media);
  const firstAttach = await attached();
  check('matrix: first play attaches one tap, muted and slowed', firstAttach, 'muted=' + media.muted + ' rate=' + media.playbackRate);
  check('matrix: first play captures exactly once', env.stats.captures === 1, 'captures=' + env.stats.captures);
  check('matrix: first play has one live controller', env.queryLive().attachedCount === 1, JSON.stringify(env.queryLive()));

  // Each row is a real YouTube Music transition. The element is REUSED and its
  // currentSrc rotates; none of these may disconnect or recapture the tap.
  const rows = [
    ['next', 'https://music.youtube.com/stream/v2'],
    ['previous', 'https://music.youtube.com/stream/v1'],
    ['playlist', 'https://music.youtube.com/stream/v3'],
    ['radio', 'https://music.youtube.com/stream/v4'],
    ['search-to-play', 'https://music.youtube.com/stream/v5'],
    ['quality-switch', 'https://music.youtube.com/stream/v5&itag=251'],
    ['ad-break', 'https://music.youtube.com/stream/ad1'],
    ['seek', 'https://music.youtube.com/stream/v5&itag=251'],
  ];

  for (const [name, src] of rows) {
    const capsBefore = env.stats.captures;
    const discBefore = env.stats.disconnects;
    media.currentSrc = src;
    env.fireDoc('play', media);
    await drive();
    const live = env.queryLive();
    check(
      'matrix ' + name + ': src rotation keeps the same tap attached',
      live.attachedCount === 1 && media.muted === true && media.playbackRate === 0.8,
      'attached=' + live.attachedCount + ' muted=' + media.muted + ' rate=' + media.playbackRate
    );
    check(
      'matrix ' + name + ': src rotation records no recapture and no disconnect',
      env.stats.captures === capsBefore && env.stats.disconnects === discBefore,
      'captures +' + (env.stats.captures - capsBefore) + ' disconnects +' + (env.stats.disconnects - discBefore)
    );
  }

  // Autoplay: pause then play again without a source change.
  {
    const capsBefore = env.stats.captures;
    media.paused = true;
    env.fireDoc('pause', media);
    await env.settle(3);
    media.paused = false;
    env.fireDoc('play', media);
    await drive();
    check(
      'matrix autoplay: resume keeps exactly one tap',
      env.stats.captures === capsBefore && env.queryLive().attachedCount === 1 && media.muted === true,
      'captures +' + (env.stats.captures - capsBefore) + ' muted=' + media.muted
    );
  }

  // Tab background/foreground must not double-tap.
  {
    const capsBefore = env.stats.captures;
    const discBefore = env.stats.disconnects;
    env.document.visibilityState = 'hidden';
    env.fireWin('visibilitychange', {});
    await env.settle(2);
    env.document.visibilityState = 'visible';
    env.fireWin('visibilitychange', {});
    await drive();
    await env.runIntervals();
    await env.settle(2);
    check(
      'matrix visibility: background/foreground keeps one tap',
      env.stats.captures === capsBefore && env.stats.disconnects === discBefore && env.queryLive().attachedCount === 1,
      'captures +' + (env.stats.captures - capsBefore) + ' disconnects +' + (env.stats.disconnects - discBefore)
    );
  }

  // Repeated double-sync: play + playing + revive + watchdog + volumechange.
  {
    const capsBefore = env.stats.captures;
    const discBefore = env.stats.disconnects;
    env.fireDoc('play', media);
    env.fireDoc('playing', media);
    env.sendRuntime({ type: 'SLRA_PAGE_REVIVE', reason: 'double' });
    env.sendRuntime({ type: 'SLRA_PAGE_REVIVE', reason: 'double-again' });
    media.dispatchEvent(new Event('volumechange'));
    media.dispatchEvent(new Event('volumechange'));
    await env.drainTimers(400);
    await env.runIntervals();
    await env.settle(2);
    media.dispatchEvent(new Event('volumechange'));
    await env.settle(2);
    check(
      'matrix double-sync: no second tap and no teardown',
      env.stats.captures === capsBefore && env.stats.disconnects === discBefore && media.muted === true,
      'captures +' + (env.stats.captures - capsBefore) + ' disconnects +' + (env.stats.disconnects - discBefore) + ' muted=' + media.muted
    );
  }

  // Genuine track change: emptied -> loadedmetadata is a source-only swap.
  {
    const capsBefore = env.stats.captures;
    const gainsBefore = env.stats.gains.length;
    const writesBefore = media.mutedWrites.length;
    const lastGain = env.stats.gains[env.stats.gains.length - 1];
    lastGain.value = 0.8;
    media.currentSrc = '';
    media.paused = true;
    media.readyState = 0;
    media.dispatchEvent(new Event('emptied'));
    await env.settle(2);
    env.runTimers(2);
    await env.settle(2);
    check(
      'track change: emptied never unmutes the element (no dry gap)',
      media.mutedWrites.slice(writesBefore).indexOf(false) === -1,
      'writes=' + JSON.stringify(media.mutedWrites.slice(writesBefore))
    );
    check(
      'track change: emptied keeps the live graph attached',
      env.queryLive().attachedCount === 1 && media.muted === true,
      'attached=' + env.queryLive().attachedCount + ' muted=' + media.muted
    );
    check(
      'track change: emptied hard-zeroes the graph (zero-overlap swap)',
      lastGain.value === 0,
      'gain=' + lastGain.value
    );

    media.currentSrc = 'https://music.youtube.com/stream/track2';
    media.paused = false;
    media.readyState = 4;
    media.dispatchEvent(new Event('loadedmetadata'));
    await drive();
    const live = env.queryLive();
    check(
      'track change: source-only swap captures once, stays attached and muted',
      env.stats.captures === capsBefore + 1 && live.attachedCount === 1 && media.muted === true,
      'captures +' + (env.stats.captures - capsBefore) + ' attached=' + live.attachedCount + ' muted=' + media.muted
    );
    check(
      'track change: source-only swap does not rebuild the graph',
      env.stats.gains.length === gainsBefore && lastGain === env.stats.gains[env.stats.gains.length - 1],
      'gains +' + (env.stats.gains.length - gainsBefore)
    );
  }

  // Element replaced: the old controller must be removed and hand back audio.
  {
    const oldMedia = media;
    const capturesBefore = env.stats.captures;
    const oldListeners = oldMedia.listeners.size;
    const replacement = env.addMedia();
    replacement.currentSrc = 'https://music.youtube.com/stream/replaced';
    oldMedia.isConnected = false;
    env.fireObserver([{ addedNodes: [{ tagName: 'VIDEO' }], removedNodes: [{ tagName: 'VIDEO' }] }]);
    for (let i = 0; i < 60 && replacement.muted !== true; i++) {
      await env.settle(2);
      env.runTimers(100);
    }
    const live = env.queryLive();
    check(
      'element replaced: old controller removed and handed back unmuted',
      oldMedia.muted === false && oldMedia.pauseCalled === true && oldMedia.listeners.size === 0,
      'muted=' + oldMedia.muted + ' paused=' + oldMedia.pauseCalled + ' listeners=' + oldMedia.listeners.size
    );
    check(
      'element replaced: replacement owns the only tap',
      replacement.muted === true && live.attachedCount === 1 && live.totalCount === 1 && env.stats.captures === capturesBefore + 1,
      'muted=' + replacement.muted + ' attached=' + live.attachedCount + ' total=' + live.totalCount + ' captures +' + (env.stats.captures - capturesBefore)
    );
    void oldListeners;
  }

  // Removed element: controller is gone, no dangling interval work.
  {
    const live = env.queryLive();
    const replacement = globalThis.document.querySelectorAll('audio,video')[0];
    replacement.isConnected = false;
    env.fireObserver([{ addedNodes: [], removedNodes: [{ tagName: 'VIDEO' }] }]);
    await env.settle(3);
    env.runTimers(100);
    await env.settle(2);
    const after = env.queryLive();
    check(
      'element removed: controllers for removed elements are removed',
      after.totalCount === 0 && after.attachedCount === 0 && replacement.muted === false,
      JSON.stringify(after) + ' muted=' + replacement.muted
    );
    void live;
    void env.pendingTimers;
  }

  env.restoreTimers();

  if (failures.length > 0) {
    console.error('\nFAILED ' + failures.length + ' check(s):');
    for (const failure of failures) console.error(' - ' + failure);
    process.exitCode = 1;
    return;
  }
  console.log('\nPASS tap lifetime: one capture per element across the YTM matrix');
}

main().catch((error) => {
  console.error('FAIL test crashed: ' + ((error && error.stack) || error));
  process.exitCode = 1;
});
