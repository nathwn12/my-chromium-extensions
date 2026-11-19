'use strict';

/* global require, process, __dirname */

/*
 * test/track-alignment.test.js - ordering regression for a track change.
 *
 * Two ordering defects made the first moment of a new song audible at the page's
 * own rate and then corrected it in real time:
 *
 *   1. `syncMediaController` returned without writing the intended rate while
 *      the tap was stale, so the element kept whatever `playbackRate` the page
 *      wrote (usually 1.0) through the whole swap window.
 *   2. `rebuildStreamSource` cleared `sourceStale` and ramped the master gain
 *      back BEFORE writing the intended rate, so the fresh tap became audible at
 *      the page's rate and was slowed afterwards.
 *
 * Contract asserted here: the graph may carry audio only once the element
 * already carries the intended rate, and a live page rate write is covered by a
 * short fade before the rate is restored.
 *
 * SAFETY (AGENTS.md ## Verification safety): plain Node only. The REAL
 * content-script.js runs against stubbed browser globals. No browser is
 * launched, no AudioContext device is created, no audio plays.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SLOW = 0.8;
const PAGE_VOLUME = 1;
const FADE_S = 0.005;

function createEnv() {
  const stats = {
    captures: 0,
    contexts: 0,
    gains: [],
    ops: [],
    unmutes: [],
  };
  // The element the op log samples: every gain command records the rate and
  // mute state it was issued under, which is the ordering evidence.
  let probe = null;

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

  function masterParam() {
    for (let i = stats.gains.length - 1; i >= 0; i--) {
      if (stats.gains[i].label === 'master') return stats.gains[i];
    }
    return null;
  }

  function record(gain, op, value, when) {
    stats.ops.push({
      op,
      label: gain.label,
      value,
      when,
      rate: probe ? probe.playbackRate : null,
      muted: probe ? probe.muted : null,
    });
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
      this.volume = PAGE_VOLUME;
      this.paused = false;
      this.ended = false;
      this.readyState = 4;
      this.currentSrc = 'https://music.youtube.com/stream/track1';
      this.srcObject = null;
      this.isConnected = true;
    }

    get muted() {
      return this._muted;
    }

    set muted(value) {
      const next = Boolean(value);
      if (next === this._muted) return;
      this._muted = next;
      this.mutedWrites.push(next);
      if (!next) {
        // An unmute is only legal while the graph carries zero.
        const master = masterParam();
        stats.unmutes.push({ master: master ? master.value : 0, rate: this.playbackRate });
      }
    }

    pause() {
      this.paused = true;
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
      return { getAudioTracks: () => [track], getTracks: () => [track], addEventListener() {} };
    }
  }
  StubMedia.HAVE_NOTHING = 0;
  StubMedia.HAVE_METADATA = 1;
  StubMedia.HAVE_CURRENT_DATA = 2;
  StubMedia.HAVE_FUTURE_DATA = 3;
  StubMedia.HAVE_ENOUGH_DATA = 4;

  let context = null;
  class StubAudioContext {
    constructor() {
      stats.contexts += 1;
      this.state = 'running';
      this.currentTime = 0;
      this.destination = { name: 'destination' };
      this.onstatechange = null;
      this.audioWorklet = { addModule: async () => {} };
      context = this;
    }
    createMediaStreamSource() {
      return {
        connect() {},
        disconnect() {},
      };
    }
    createGain() {
      const gain = {
        label: '',
        current: 0,
        get value() {
          return this.current;
        },
        set value(v) {
          this.current = v;
        },
        cancelScheduledValues(when) {
          record(gain, 'cancel', null, when);
        },
        setValueAtTime(value, when) {
          record(gain, 'setValue', value, when);
          gain.current = value;
        },
        setTargetAtTime(value, when) {
          record(gain, 'setTarget', value, when);
          gain.current = value;
        },
        linearRampToValueAtTime(value, when) {
          record(gain, 'linearRamp', value, when);
          gain.current = value;
        },
      };
      const node = {
        gain,
        connect(target) {
          // dryGain -> masterGain node, masterGain -> destination.
          if (target && target === context.destination) gain.label = 'master';
          else if (!gain.label) gain.label = 'dry';
        },
        disconnect() {},
      };
      stats.gains.push(gain);
      return node;
    }
    async resume() {
      this.state = 'running';
    }
    async suspend() {
      this.state = 'suspended';
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
          return { eligible: true, bypass: false, settings: { slow: SLOW, reverbIntensity: 0.5 } };
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
    querySelectorAll: () => mediaElements.filter((m) => m.isConnected),
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
      stubObservers.push(this);
    }
    observe() {}
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

  function addMedia() {
    const media = new StubMedia();
    mediaElements.push(media);
    return media;
  }
  function fireDoc(type, target) {
    for (const fn of docListeners[type] || []) fn({ target });
  }
  function sendRuntime(msg) {
    for (const fn of runtimeHandlers) fn(msg, {}, () => {});
  }
  function queryLive() {
    let out = null;
    for (const fn of runtimeHandlers) fn({ type: 'GET_LIVE_STATUS' }, {}, (v) => { out = v; });
    return out;
  }
  function probeMedia(media) {
    probe = media;
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
  function fmt(ops) {
    return ops.map((op) => op.op + '(' + op.value + ')@rate=' + op.rate + ',muted=' + op.muted).join(' | ');
  }

  return {
    stats,
    addMedia,
    fireDoc,
    sendRuntime,
    queryLive,
    probeMedia,
    masterParam,
    fmt,
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
        entry.cb();
        await Promise.resolve();
      }
    },
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
  env.probeMedia(media);

  env.fireDoc('play', media);
  for (let i = 0; i < 60 && !(media.muted === true && Math.abs(media.playbackRate - SLOW) < 1e-9); i++) {
    await env.settle(2);
    env.runTimers(100);
  }
  const master = env.masterParam();
  check(
    'setup: the element is attached, muted and slowed',
    media.muted === true && media.playbackRate === SLOW && Boolean(master),
    'muted=' + media.muted + ' rate=' + media.playbackRate + ' master=' + (master ? master.value : 'none')
  );
  check(
    'setup: the graph carries the page volume',
    Boolean(master) && master.value === PAGE_VOLUME,
    'master=' + (master ? master.value : 'none')
  );

  // The player parks the element for the new track and writes its own rate;
  // Chromium queues the `ratechange` event, so a sync can run while the element
  // is still at 1.0. That ordering is the reported bug.
  media.currentSrc = '';
  media.paused = true;
  media.readyState = 0;
  media.dispatchEvent(new Event('emptied'));
  await env.settle(2);
  await env.drainTimers(50);
  await env.settle(2);

  check(
    'track change: the graph is hard-zeroed as the tap goes stale',
    master.value === 0,
    'master=' + master.value
  );
  check(
    'track change: the element stays muted while the tap is stale',
    media.muted === true,
    'muted=' + media.muted
  );

  media.paused = false;
  media.playbackRate = 1; // the page's own rate for the new source, event not delivered yet
  const playFrom = env.stats.ops.length;
  env.fireDoc('play', media);
  await env.settle(3);
  await env.drainTimers(50);
  await env.settle(2);

  check(
    'stale window: the element carries the slow rate before the new tap exists',
    media.playbackRate === SLOW,
    'rate=' + media.playbackRate
  );
  const staleOps = env.stats.ops.slice(playFrom).filter((op) => op.label === 'master');
  check(
    'stale window: no ramp to volume while the tap is stale',
    master.value === 0 && staleOps.every((op) => (op.value || 0) <= 0),
    'master=' + master.value + ' ops=' + env.fmt(staleOps)
  );

  const loadFrom = env.stats.ops.length;
  media.currentSrc = 'https://music.youtube.com/stream/track2';
  media.readyState = 4;
  media.dispatchEvent(new Event('loadedmetadata'));
  await env.settle(3);
  await env.drainTimers(200);
  await env.settle(3);

  const swapOps = env.stats.ops.slice(loadFrom).filter((op) => op.label === 'master');
  const firstAudible = swapOps.find((op) => op.op !== 'cancel' && (op.value || 0) > 0);
  check(
    'track change: the graph reaches volume only after the slow rate is on the element',
    Boolean(firstAudible) && firstAudible.rate === SLOW,
    firstAudible ? 'first audible op at rate=' + firstAudible.rate : 'no audible op; ops=' + env.fmt(swapOps)
  );
  check(
    'track change: the element is slowed and muted again after the swap',
    media.playbackRate === SLOW && media.muted === true,
    'rate=' + media.playbackRate + ' muted=' + media.muted
  );
  check(
    'track change: the swap captures the new source once and keeps one graph',
    env.stats.captures === 2 && env.queryLive().attachedCount === 1 && env.stats.contexts === 1,
    'captures=' + env.stats.captures + ' attached=' + env.queryLive().attachedCount + ' contexts=' + env.stats.contexts
  );

  const rateFrom = env.stats.ops.length;
  media.playbackRate = 1;
  media.dispatchEvent(new Event('ratechange'));
  await env.settle(4);
  await env.drainTimers(50);

  const rateOps = env.stats.ops.slice(rateFrom).filter((op) => op.label === 'master');
  const fade = rateOps.find((op) => op.op === 'linearRamp' && op.value === 0);
  check(
    'live rate write: a ~5 ms fade to zero is scheduled before the correction',
    Boolean(fade) && Math.abs((fade.when || 0) - FADE_S) < 1e-9,
    fade ? 'when=' + fade.when : 'no fade scheduled; ops=' + env.fmt(rateOps)
  );
  check(
    'live rate write: the slowed rate is restored',
    media.playbackRate === SLOW,
    'rate=' + media.playbackRate
  );
  const fadeIndex = fade ? rateOps.indexOf(fade) : -1;
  const rampBack = fadeIndex === -1
    ? null
    : rateOps.slice(fadeIndex + 1).find((op) => op.op === 'setTarget' && op.value === PAGE_VOLUME);
  check(
    'live rate write: the graph ramps back to volume after the slow rate lands',
    Boolean(rampBack) && rampBack.rate === SLOW,
    rampBack ? 'rate at ramp=' + rampBack.rate : 'no ramp back; ops=' + env.fmt(rateOps)
  );
  check(
    'live rate write: the element stays muted through the correction',
    media.muted === true,
    'muted=' + media.muted
  );

  const audibleWhileUnmuted = env.stats.ops.filter(
    (op) => op.label === 'master' && (op.value || 0) > 0 && op.muted === false
  );
  check(
    'invariant: the graph is never ramped while the element is unmuted',
    audibleWhileUnmuted.length === 0,
    env.fmt(audibleWhileUnmuted)
  );
  check(
    'invariant: the extension never unmutes while it owns the graph',
    env.stats.unmutes.length === 0,
    JSON.stringify(env.stats.unmutes)
  );
  check(
    'final: attached, muted, slowed, graph at the page volume',
    media.muted === true && media.playbackRate === SLOW && master.value === PAGE_VOLUME && env.queryLive().attachedCount === 1,
    'muted=' + media.muted + ' rate=' + media.playbackRate + ' master=' + master.value
  );

  env.restoreTimers();

  if (failures.length > 0) {
    console.error('\nFAILED ' + failures.length + ' check(s):');
    for (const failure of failures) console.error(' - ' + failure);
    process.exitCode = 1;
    return;
  }
  console.log('\nPASS track alignment: rate lands before the graph is audible');
}

main().catch((error) => {
  console.error('FAIL test crashed: ' + ((error && error.stack) || error));
  process.exitCode = 1;
});
