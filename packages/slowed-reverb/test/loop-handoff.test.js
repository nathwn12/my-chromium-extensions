'use strict';

/* global require, __dirname, setImmediate */

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

// ---------------------------------------------------------------------------
// Track handoff: the outgoing A-B loop's settle correction must not seek a
// reused incoming element while the incoming identity read is in flight.
// No browser, no audio, no device: an injected clock, media and DOM only.
// ---------------------------------------------------------------------------

const ACTIONS_SOURCE = fs.readFileSync(path.join(ROOT, 'player-actions.js'), 'utf8');
function loadActions() {
  const sandbox = { module: { exports: {} }, URL };
  vm.runInNewContext(ACTIONS_SOURCE, sandbox, { filename: 'player-actions.js' });
  return sandbox.module.exports;
}
const actions = loadActions();
const PAGE_A = 'https://music.youtube.com/watch?v=song-a';
const PAGE_B = 'https://music.youtube.com/watch?v=song-b';
const PAGE_C = 'https://music.youtube.com/watch?v=song-c';
const SECTION_A = { videoId: 'song-a', startSeconds: 30, endSeconds: 60 };
const SETTLE_MS = 1200;

function handoffElement(tagName) {
  const listeners = new Map();
  return {
    tagName: String(tagName).toUpperCase(),
    children: [], parentElement: null, attributes: new Map(), style: {}, dataset: {},
    isConnected: true, textContent: '', value: '', checked: false, type: '',
    isContentEditable: false, scrollHeight: 0, clientHeight: 0,
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
    append(...nodes) { for (const node of nodes) this.appendChild(node); },
    remove() {},
    setAttribute(name, value) { this.attributes.set(String(name), String(value)); },
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; },
    removeAttribute(name) { this.attributes.delete(name); },
    hasAttribute(name) { return this.attributes.has(name); },
    addEventListener(type, fn) { const list = listeners.get(type) || []; list.push(fn); listeners.set(type, list); },
    removeEventListener(type, fn) {
      const list = listeners.get(type);
      if (!list) return;
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
    dispatchEvent(type) { for (const fn of [...(listeners.get(type) || [])]) fn({ type, target: this }); },
    attachShadow() { this.shadowRoot = handoffElement('shadow'); return this.shadowRoot; },
    play() { return Promise.resolve(); },
  };
}

function handoffTimers() {
  let nextId = 1;
  const timeouts = new Map();
  const intervals = new Map();
  return {
    setTimeout(fn, ms) { const id = nextId++; timeouts.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn, ms) { const id = nextId++; intervals.set(id, { fn, ms }); return id; },
    clearInterval(id) { intervals.delete(id); },
    pending() { return [...timeouts.values()].map((timer) => timer.ms).sort((a, b) => a - b); },
    fireTimeout(ms) {
      const due = [...timeouts.entries()].filter(([, timer]) => timer.ms === ms);
      for (const [id, timer] of due) if (timeouts.has(id)) { timeouts.delete(id); timer.fn(); }
      return due.length;
    },
    tickIntervals() { for (const timer of [...intervals.values()]) timer.fn(); },
  };
}

function handoffBoot(sections, href) {
  const doc = {
    documentElement: handoffElement('html'), visibilityState: 'visible', createElement: handoffElement,
    querySelector: () => null, addEventListener() {}, removeEventListener() {},
  };
  const win = {
    document: doc, location: { href: href || PAGE_A }, getComputedStyle: () => ({}),
    addEventListener() {}, removeEventListener() {},
  };
  const timers = handoffTimers();
  const data = { playerActions: { sections: sections || [] } };
  const storage = {
    async get(key) { return { [key]: data[key] }; },
    async set(items) { Object.assign(data, items); },
    subscribe() { return () => {}; },
  };
  let clock = 1000;
  const makeMedia = (id) => {
    const node = handoffElement('video');
    let value = 0;
    node.currentTimeWrites = [];
    Object.defineProperty(node, 'currentTime', {
      configurable: true, get() { return value; },
      set(next) { value = next; node.currentTimeWrites.push(next); },
    });
    node.currentSrc = 'https://music.youtube.com/stream/' + id;
    node.duration = 300;
    node.paused = false;
    node.seeking = false;
    return node;
  };
  let media = makeMedia('song-a');
  const controller = actions.createPlayerActions({
    window: win, document: doc, mediaProvider: () => media,
    pageHook: { setVolume: async (percent) => ({ volume: percent, applied: true, source: 'player' }), syncVolumeUi() {} },
    storage, timers, now: () => clock,
  });
  return {
    controller, timers, media: () => media,
    advance(ms) { clock += ms; },
    setHref(next) { win.location.href = next; },
    replaceMedia(id) { media = makeMedia(id); return media; },
  };
}

const handoffSettle = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function armedA() {
  const harness = handoffBoot([SECTION_A], PAGE_A);
  harness.controller.setSongId('song-a', PAGE_A);
  await harness.controller.start();
  await handoffSettle();
  assert.deepEqual(harness.media().currentTimeWrites, [30], 'A section restore seek landed');
  assert.ok(harness.timers.pending().includes(SETTLE_MS), 'A settle check is armed');
  return harness;
}

test('handoff: outgoing settle does not seek a reused element during identity read', async () => {
  const harness = await armedA();
  const media = harness.media();

  // Natural Next: the same element is reused for B, B is at its top, and the
  // URL still names A while the identity read is in flight.
  media.currentSrc = 'https://music.youtube.com/stream/song-b';
  media.duration = 200;
  media.currentTime = 0;
  harness.controller.suspendSongIdentity();
  media.dispatchEvent('timeupdate');
  media.dispatchEvent('seeked');
  assert.equal(media.currentTime, 0, 'stale media handlers wrote nothing');

  harness.advance(900);
  harness.timers.fireTimeout(SETTLE_MS);
  assert.equal(
    media.currentTime,
    0,
    'B stays at its own top; writes=' + JSON.stringify(media.currentTimeWrites)
  );
});

test('handoff control: same-track settle still re-applies the saved start', async () => {
  const harness = await armedA();
  const media = harness.media();
  media.currentTime = 0;
  harness.advance(SETTLE_MS);
  harness.timers.fireTimeout(SETTLE_MS);
  assert.equal(media.currentTime, 30, 'same-track late correction restored the section');
});

test('handoff control: stale settle after identity resolution does not seek B', async () => {
  const harness = await armedA();
  const media = harness.media();
  media.currentSrc = 'https://music.youtube.com/stream/song-b';
  media.duration = 200;
  media.currentTime = 0;
  harness.controller.suspendSongIdentity();

  // The push answers the suspension, but the URL has not caught up: the stale
  // key still names A. The cancelled A-era settle must not fire into B.
  harness.controller.setSongId('song-b', PAGE_B);
  harness.advance(SETTLE_MS);
  harness.timers.fireTimeout(SETTLE_MS);
  assert.equal(
    media.currentTime,
    0,
    'resolved B stays at its own top; writes=' + JSON.stringify(media.currentTimeWrites)
  );
});

test('handoff control: invalidation closes the outgoing settle window', async () => {
  const harness = await armedA();
  const media = harness.media();
  media.currentSrc = 'https://music.youtube.com/stream/song-b';
  media.currentTime = 0;
  harness.controller.suspendSongIdentity();
  harness.controller.invalidateSongIdentity();
  harness.timers.fireTimeout(SETTLE_MS);
  assert.equal(media.currentTime, 0, 'invalidate clears the settle check');
});

test('handoff control: explicit Next with a replaced element and a confirmed URL stays isolated', async () => {
  const harness = await armedA();
  const media = harness.replaceMedia('song-b');
  harness.setHref(PAGE_B);
  harness.controller.setSongId('song-b', PAGE_B);
  await handoffSettle();
  harness.advance(SETTLE_MS);
  harness.timers.fireTimeout(SETTLE_MS);
  assert.equal(media.currentTime, 0, 'A loop never seeks B');
  media.currentTime = 12;
  media.dispatchEvent('timeupdate');
  harness.timers.tickIntervals();
  assert.equal(media.currentTime, 12, 'B playback control survives');
});

test('handoff control: rapid A to B to C leaves C controllable', async () => {
  const harness = await armedA();
  harness.replaceMedia('song-b');
  harness.setHref(PAGE_B);
  harness.controller.setSongId('song-b', PAGE_B);
  await handoffSettle();
  const media = harness.replaceMedia('song-c');
  harness.setHref(PAGE_C);
  harness.controller.setSongId('song-c', PAGE_C);
  await handoffSettle();
  harness.advance(SETTLE_MS);
  harness.timers.fireTimeout(SETTLE_MS);
  assert.equal(media.currentTime, 0, 'no A or B seek landed on C');
  media.currentTime = 7;
  media.dispatchEvent('seeked');
  harness.timers.tickIntervals();
  assert.equal(media.currentTime, 7, 'C playback control survives');
});
