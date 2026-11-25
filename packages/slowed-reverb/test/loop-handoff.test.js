'use strict';

/* global require, __dirname */

// Offline envelope proof for the accelerated looping handoff. No playback,
// no browser, no device: a fake wall clock drives numeric gain and mute state.
// Oracle: while the processed graph is hard-zeroed, the raw element path must
// be closed. An unmuted element with master gain 0 is an audible raw window.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const RATE = 1.2;
const SONG_QUERY_TIMEOUT_MS = 1000;

function createContentEnv() {
  const gains = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let timerId = 1;
  const timers = new Map();
  const intervals = new Map();
  globalThis.setTimeout = (cb, ms) => {
    const id = timerId++;
    timers.set(id, { cb, ms });
    return id;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  globalThis.setInterval = (cb, ms) => {
    const id = timerId++;
    intervals.set(id, { cb, ms });
    return id;
  };
  globalThis.clearInterval = (id) => intervals.delete(id);

  const realLocation = globalThis.location;
  globalThis.location = { origin: 'https://music.youtube.com', href: 'https://music.youtube.com/watch?v=song-a' };
  const realNow = Date.now;
  let clock = 1000;
  Date.now = () => clock;

  class StubGain {
    constructor() {
      this._v = 0;
      gains.push(this);
    }
    get value() { return this._v; }
    set value(v) { this._v = v; }
    cancelScheduledValues() {}
    setValueAtTime(v) { this._v = v; }
    setTargetAtTime(v) { this._v = v; }
    linearRampToValueAtTime(v) { this._v = v; }
  }

  class StubMedia extends EventTarget {
    constructor() {
      super();
      this.playbackRate = 1;
      this.preservesPitch = true;
      this.mozPreservesPitch = true;
      this.webkitPreservesPitch = true;
      this.muted = false;
      this.volume = 1;
      this.paused = false;
      this.ended = false;
      this.currentTime = 0;
      this.duration = 300;
      this.currentSrc = 'https://music.youtube.com/stream/song-a';
      this.readyState = 4;
      this.isConnected = true;
    }
    captureStream() {
      const track = { kind: 'audio', stop() {} };
      return { getAudioTracks: () => [track], getTracks: () => [track], addEventListener() {} };
    }
    play() { return Promise.resolve(); }
    pause() { this.paused = true; }
  }
  StubMedia.HAVE_NOTHING = 0;
  StubMedia.HAVE_METADATA = 1;
  StubMedia.HAVE_CURRENT_DATA = 2;
  StubMedia.HAVE_FUTURE_DATA = 3;
  StubMedia.HAVE_ENOUGH_DATA = 4;

  class StubContext {
    constructor() {
      this.state = 'running';
      this.currentTime = 0;
      this.destination = {};
      this.audioWorklet = { addModule: async () => {} };
    }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { const g = new StubGain(); return { gain: g, connect() {}, disconnect() {} }; }
    async resume() { this.state = 'running'; }
    async suspend() { this.state = 'suspended'; }
  }
  class StubWorklet {
    constructor() { this.port = { postMessage() {} }; }
    connect() {}
    disconnect() {}
  }

  const runtimeHandlers = [];
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener(fn) { runtimeHandlers.push(fn); } },
      sendMessage: async (msg) => {
        if (msg && msg.type === 'GET_TAB_RUNTIME_STATE') {
          return { eligible: true, bypass: false, settings: { slow: RATE, reverbIntensity: 0.5 } };
        }
        return { ok: true };
      },
      getURL: (p) => String(p),
    },
  };

  const mediaElements = [];
  const docListeners = {};
  globalThis.document = {
    documentElement: { dataset: {} },
    visibilityState: 'visible',
    querySelectorAll: () => mediaElements.filter((m) => m.isConnected),
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
  };
  globalThis.window = { addEventListener() {} };
  globalThis.MutationObserver = class { constructor(cb) {} observe() {} disconnect() {} };
  globalThis.HTMLMediaElement = StubMedia;
  globalThis.AudioContext = StubContext;
  globalThis.AudioWorkletNode = StubWorklet;

  for (const file of ['shared.js', 'content-script.js']) {
    const full = path.join(ROOT, file);
    vm.runInThisContext(fs.readFileSync(full, 'utf8'), { filename: full });
  }

  return {
    gains,
    addMedia() { const m = new StubMedia(); mediaElements.push(m); return m; },
    sendRuntime(msg) { for (const fn of runtimeHandlers) fn(msg, {}, () => {}); },
    fireDoc(type, target) { for (const fn of docListeners[type] || []) fn({ target }); },
    live() {
      let out = null;
      for (const fn of runtimeHandlers) fn({ type: 'GET_LIVE_STATUS' }, {}, (v) => { out = v; });
      return out;
    },
    async settle(rounds = 8) {
      for (let i = 0; i < rounds; i++) {
        await Promise.resolve();
        await new Promise((resolve) => realSetTimeout(resolve, 0));
      }
    },
    runTimers(max = 1000) {
      let n = 0;
      while (timers.size > 0 && n < max) {
        const [id, t] = timers.entries().next().value;
        timers.delete(id);
        n++;
        t.cb();
      }
      return n;
    },
    async runIntervals() {
      const pending = [...intervals.values()];
      intervals.clear();
      for (const t of pending) { t.cb(); await Promise.resolve(); }
      return pending.length;
    },
    advance(ms) { clock += ms; },
    now: () => clock,
    restore() {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
      globalThis.location = realLocation;
      Date.now = realNow;
    },
  };
}

function masterGain(env) {
  const gain = env.gains[env.gains.length - 1];
  return gain ? gain.value : 0;
}

async function attachAtRate(env, media) {
  env.sendRuntime({ type: 'GET_TAB_RUNTIME_STATE' });
  env.fireDoc('play', media);
  for (let i = 0; i < 40 && !(media.muted === true && media.playbackRate === RATE); i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  await env.runIntervals();
}

test('loop handoff: budget exhaustion never opens the raw next-song path', async () => {
  const env = createContentEnv();
  try {
    const media = env.addMedia();
    await attachAtRate(env, media);

    assert.equal(media.muted, true, 'ATTACH: the processed graph owns the audio');
    assert.equal(media.playbackRate, RATE, 'ATTACH: the intended rate is written');
    assert.ok(masterGain(env) > 0.1, 'ATTACH: master gain is audible');

    // BURST9: nine external unmutes inside one rolling second. The eighth is
    // corrected; the ninth exhausts the budget and enters the cooldown.
    for (let i = 0; i < 9; i++) {
      media.muted = false;
      media.dispatchEvent(new Event('volumechange'));
      await Promise.resolve();
    }
    const burst = { muted: media.muted, master: masterGain(env), rate: media.playbackRate };
    assert.ok(env.live().budgetBypassedCount >= 1, 'BURST9: the budget bypass engaged');

    // LOAD_IN_COOLDOWN: the next song's source signal lands inside the same
    // second. syncMediaController returns while budgetBypassed holds, so the
    // tap cannot rebuild and master gain stays hard-zeroed.
    media.currentTime = 0;
    media.currentSrc = 'https://music.youtube.com/stream/song-b';
    env.fireDoc('loadedmetadata', media);
    media.dispatchEvent(new Event('loadedmetadata'));
    await env.settle();
    env.runTimers(50);
    await env.runIntervals();
    const load = { muted: media.muted, master: masterGain(env), rate: media.playbackRate };

    // LEAK: YTM unmutes the element for the next song while the cooldown is
    // still active. The oracle: a hard-zeroed graph with an unmuted element is
    // an audible raw window, not a silent handoff.
    media.muted = false;
    media.dispatchEvent(new Event('volumechange'));
    await Promise.resolve();
    const leak = { muted: media.muted, master: masterGain(env), rate: media.playbackRate };

    assert.equal(
      leak.muted === false && leak.master <= 0.001,
      false,
      'LEAK: expected the raw element path closed while master gain is 0; '
        + 'observed muted=' + leak.muted + '/master=' + leak.master
        + ' (burst muted=' + burst.muted + '/master=' + burst.master
        + ', load muted=' + load.muted + '/master=' + load.master + ')'
    );

    // RECOVER: a fresh play after the cooldown rebuilds the tap and restores
    // the processed path. The safety guard must not block recovery.
    env.advance(SONG_QUERY_TIMEOUT_MS + 2);
    env.fireDoc('play', media);
    await env.settle();
    env.runTimers(50);
    await env.runIntervals();
    assert.equal(media.muted, true, 'RECOVER: the element is muted again');
    assert.ok(masterGain(env) > 0.1, 'RECOVER: master gain is audible again');
  } finally {
    env.restore();
  }
});
