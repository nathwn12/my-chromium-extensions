'use strict';

/* global require, process, __dirname */

/*
 * test/mute-enforce.test.js - regression test for the mute contract.
 *
 * Contract (AGENTS.md ## Architecture, "Mute semantics"): while the pipeline is
 * live, `media.muted` is `controller.attached`. The page player can write
 * `video.muted = false` during its own start sequence; the content script must
 * put the mute back in the same turn, at the `volumechange` seam.
 *
 * SAFETY (AGENTS.md ## Verification safety): plain Node only. The REAL
 * content-script.js is evaluated with browser globals stubbed (the same pattern
 * as qa/stub-env.js, which is local-only/gitignored). No browser is launched, no
 * device AudioContext is created, no audio plays.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createContentEnv() {
  const stats = { captureCalls: 0, contexts: 0, ramped: 0, rampedValues: [], disconnects: 0, audioOps: [], gains: [], cancelCalls: 0, setValueCalls: 0, pauses: 0, ensureHooksCalls: 0 };

  // Controllable timers: fake setTimeout, inert setInterval (the 2s watchdog is
  // exercised by the real-browser harness, not here).
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

  // Origin for the page-message origin check (`event.origin === location.origin`).
  const realLocation = globalThis.location;
  globalThis.location = { origin: 'https://music.youtube.com', href: 'https://music.youtube.com/' };

  // Controllable clock: the mute budget reads Date.now(), so a simulated drive
  // can span seconds of wall time in milliseconds. Frozen by default so every
  // burst in this file is deterministic.
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

  // Same as runTimers, but yields between callbacks so queued microtasks run.
  // The content script clears its internal-write flags in a microtask; a fully
  // synchronous drain would never observe a second correction.
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
      this.muted = false;
      this.volume = 1;
      this.paused = false;
      this.pauseCalled = false;
      this.ended = false;
      this.readyState = 4;
      this.currentSrc = 'https://www.youtube.com/watch?v=stub';
      this.srcObject = null;
      this.isConnected = true;
      this.mutedWrites = [];
    }

    pause() {
      this.paused = true;
      this.pauseCalled = true;
      stats.pauses++;
    }

    captureStream() {
      stats.captureCalls++;
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
  // Assigned after the class body: the repo's eslint config targets ES2020,
  // where static class fields (and their unrestricted identifiers) parse as errors.
  StubMedia.HAVE_NOTHING = 0;
  StubMedia.HAVE_METADATA = 1;
  StubMedia.HAVE_CURRENT_DATA = 2;
  StubMedia.HAVE_FUTURE_DATA = 3;
  StubMedia.HAVE_ENOUGH_DATA = 4;

  class StubAudioContext {
    constructor() {
      stats.contexts++;
      this.state = 'running';
      this.currentTime = 0;
      this.destination = {};
      this.audioWorklet = { addModule: async () => {} };
    }
    createMediaStreamSource() {
      return {
        connect() {},
        disconnect() {
          stats.disconnects++;
        },
      };
    }
    createGain() {
      const holder = { current: 0 };
      const gain = {
        get value() {
          return holder.current;
        },
        set value(v) {
          holder.current = v;
        },
        cancelScheduledValues() {
          stats.cancelCalls++;
          stats.audioOps.push({ op: 'cancel' });
        },
        setValueAtTime(value, when) {
          holder.current = value;
          stats.setValueCalls++;
          if (value === 0) stats.immediateZeros = (stats.immediateZeros || 0) + 1;
          stats.audioOps.push({ op: 'setValue', value });
          stats.rampedValues.push(value);
          void when;
        },
        setTargetAtTime(value) {
          stats.ramped++;
          stats.rampedValues.push(value);
          stats.audioOps.push({ op: 'setTarget', value });
        },
      };
      stats.gains.push(gain);
      return {
        gain,
        connect() {},
        disconnect() {},
      };
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
      onMessage: {
        addListener(fn) {
          runtimeHandlers.push(fn);
        },
      },
      sendMessage: async (msg) => {
        if (msg && msg.type === 'ENSURE_TAB_HOOKS') stats.ensureHooksCalls++;
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
  let queryCalls = 0;
  globalThis.document = {
    documentElement: { dataset: {} },
    visibilityState: 'visible',
    querySelectorAll: () => {
      queryCalls++;
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

  // Load the real sources, unmodified.
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

  function fireWin(type, event) {
    for (const fn of winListeners[type] || []) fn(event);
  }

  return {
    stats,
    sendRuntime,
    queryLive,
    fireDoc,
    fireWin,
    winListeners,
    addMedia,
    settle,
    runTimers,
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
    drainTimers,
    pendingTimers: () => timers.size,
    pendingIntervals: () => intervals.size,
    intervalDelays: () => [...intervals.values()].map((t) => t.ms),
    timerDelays: () => [...timers.values()].map((t) => t.ms),
    advance,
    now: () => clock,
    restoreTimers,
    stubObservers,
    queryCalls: () => queryCalls,
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

// Largest number of timestamps inside any half-open window of `spanMs`,
// anchored on each timestamp. Mirrors the content script's prune rule
// (`time <= now - span` is dropped), so a correct budget reports <= 8.
function maxWindowCount(times, spanMs) {
  let max = 0;
  for (let i = 0; i < times.length; i++) {
    let count = 0;
    for (let j = i; j < times.length && times[j] - times[i] < spanMs; j++) count++;
    if (count > max) max = count;
  }
  return max;
}

async function main() {
  const env = createContentEnv();
  const media = env.addMedia();

  // Enter through the real content-script seam: document capture 'play'.
  env.fireDoc('play', media);

  let attached = false;
  for (let i = 0; i < 40; i++) {
    await env.settle(2);
    env.runTimers(50);
    if (media.muted === true && media.playbackRate === 0.8) {
      attached = true;
      break;
    }
  }

  if (!attached) {
    console.error('FAIL could not attach the real content script to the stub media element');
    console.error('     diagnostics: ' + JSON.stringify({
      muted: media.muted,
      playbackRate: media.playbackRate,
      contexts: env.stats.contexts,
      ramped: env.stats.ramped,
    }));
    env.restoreTimers();
    process.exitCode = 1;
    return;
  }

  console.log('ok   attach mutes the element and slows playback');
  const rateAtAttach = media.playbackRate;

  // --- attached: the page unmutes itself, then fires volumechange ---
  media.muted = false;
  check('setup: page wrote muted=false on an attached element', media.muted === false);
  media.dispatchEvent(new Event('volumechange'));
  check(
    'attached + volumechange re-mutes synchronously',
    media.muted === true,
    'expected true right after the handler returned, got ' + media.muted
  );
  check(
    'mute enforcement leaves playbackRate alone',
    media.playbackRate === rateAtAttach,
    'expected ' + rateAtAttach + ', got ' + media.playbackRate
  );

  // --- sourceStale: mute-first source swap keeps the element muted -------
  const mediaCaptureBefore = env.stats.captureCalls;
  media.dispatchEvent(new Event('emptied'));
  check('setup: emptied hard-zeroes the graph and keeps the element muted', media.muted === true);
  media.dispatchEvent(new Event('volumechange'));
  check(
    'sourceStale + volumechange keeps the element muted (no dry gap)',
    media.muted === true,
    'expected true during the source swap, got ' + media.muted
  );

  for (let i = 0; i < 40 && env.stats.captureCalls === mediaCaptureBefore; i++) await env.settle(2);
  check(
    'rebuild swaps the source and keeps the element muted',
    env.stats.captureCalls === mediaCaptureBefore + 1 && media.muted === true,
    'captures +' + (env.stats.captureCalls - mediaCaptureBefore) + ' muted=' + media.muted
  );

  // --- bypass: detached means the page owns muted again ---
  env.sendRuntime({
    type: 'APPLY_TAB_STATE',
    eligible: true,
    bypass: true,
    settings: { slow: 0.8, reverbIntensity: 0.5 },
  });
  await env.settle(2);
  check('bypass tears the graph down and restores the element unmuted', media.muted === false);
  media.muted = false;
  media.dispatchEvent(new Event('volumechange'));
  check(
    '!attached (bypass) + volumechange stays unmuted',
    media.muted === false,
    'expected false while bypassed, got ' + media.muted
  );

  // --- regression: autoplay-muted track restores audible on bypass ---
  // YouTube starts muted; the extension's own `muted = true` must never be
  // recorded as the page's mute and written back on teardown (bypass must
  // leave `media.muted === false` with the graph detached).
  env.sendRuntime({
    type: 'APPLY_TAB_STATE',
    eligible: true,
    bypass: false,
    settings: { slow: 0.8, reverbIntensity: 0.5 },
  });
  const autoMuted = env.addMedia();
  autoMuted.muted = true;
  env.fireDoc('play', autoMuted);
  for (let i = 0; i < 40 && autoMuted.playbackRate !== 0.8; i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  check(
    'setup: autoplay-muted element attached still muted',
    autoMuted.muted === true && autoMuted.playbackRate === 0.8,
    'muted=' + autoMuted.muted + ' rate=' + autoMuted.playbackRate
  );
  autoMuted.muted = false;
  autoMuted.dispatchEvent(new Event('volumechange'));
  check(
    'autoplay-muted + page unmute re-mutes while attached',
    autoMuted.muted === true,
    'expected true while attached, got ' + autoMuted.muted
  );
  env.sendRuntime({
    type: 'APPLY_TAB_STATE',
    eligible: true,
    bypass: true,
    settings: { slow: 0.8, reverbIntensity: 0.5 },
  });
  await env.settle(2);
  check(
    'bypass restores autoplay-muted element audible',
    autoMuted.muted === false,
    'expected false after bypass, got ' + autoMuted.muted
  );
  autoMuted.dispatchEvent(new Event('volumechange'));
  check(
    'bypassed autoplay-muted element stays unmuted (graph detached)',
    autoMuted.muted === false,
    'expected false while bypassed, got ' + autoMuted.muted
  );
  autoMuted.isConnected = false;

  // --- hostile page: restore `muted = false` on every volumechange ----------
  // A page that unmutes itself from its own volumechange listener turns mute
  // enforcement into a fight. The controller must bound its corrections so the
  // event loop starves instead of spinning, while a fresh play gets a new
  // budget. This models queued media events: a real `muted` write queues a
  // `volumechange`, so the extension's own correction is what feeds the loop.
  env.sendRuntime({
    type: 'APPLY_TAB_STATE',
    eligible: true,
    bypass: false,
    settings: { slow: 0.8, reverbIntensity: 0.5 },
  });
  env.fireDoc('play', media);
  for (let i = 0; i < 40 && media.muted !== true; i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  check('setup: re-attached before the hostile loop', media.muted === true);
  check('setup: no pending timers before the hostile loop', env.runTimers(1000) === 0);

  let muteCorrections = 0;
  let hostileEvents = 0;
  let hostileActive = true;
  let mutedValue = media.muted;
  Object.defineProperty(media, 'muted', {
    configurable: true,
    get: () => mutedValue,
    set: (next) => {
      const boolean = Boolean(next);
      if (boolean === mutedValue) return;
      mutedValue = boolean;
      if (boolean === true) muteCorrections++;
      setTimeout(() => {
        hostileEvents++;
        media.dispatchEvent(new Event('volumechange'));
      }, 0);
    },
  });
  media.addEventListener('volumechange', () => {
    if (!hostileActive) return;
    // Hostile page: its own listener always restores playback.
    setTimeout(() => {
      media.muted = false;
    }, 0);
  });

  const correctionsAtStart = muteCorrections;
  for (let i = 0; i < 20; i++) {
    media.muted = false;
    media.dispatchEvent(new Event('volumechange'));
    await env.drainTimers(500);
  }
  const drivenCorrections = muteCorrections - correctionsAtStart;
  const drainedAfterDrive = await env.drainTimers(1000);
  const eventsAtStop = hostileEvents;
  const drainedAgain = await env.drainTimers(1000);
  console.log('     hostile loop: corrections=' + drivenCorrections + ', queued events=' + eventsAtStop);

  check(
    'hostile page: mute corrections stop within the 1 s budget',
    drivenCorrections > 0 && drivenCorrections <= 8,
    'expected 1..8 corrections, got ' + drivenCorrections
  );
  check(
    'hostile page: loop terminates on its own (no pending timers)',
    drainedAfterDrive === 0 && env.pendingTimers() === 0,
    'timers still queued after the drive loop: ' + env.pendingTimers()
  );
  check(
    'hostile page: total queued event count is bounded',
    eventsAtStop <= 40 && drainedAgain === 0 && env.pendingTimers() === 0,
    'events=' + eventsAtStop
  );

  const correctionsWhenPaused = muteCorrections;
  for (let i = 0; i < 5; i++) {
    media.muted = false;
    media.dispatchEvent(new Event('volumechange'));
    await env.drainTimers(500);
  }
  check(
    'hostile page: paused element is left alone (no further writes)',
    muteCorrections === correctionsWhenPaused,
    'writes continued: ' + (muteCorrections - correctionsWhenPaused)
  );

  // A fresh play is a legitimate new start: it must clear the paused budget.
  hostileActive = false;
  await env.drainTimers(1000);
  env.fireDoc('play', media);
  await env.settle(2);
  await env.drainTimers(1000);
  const correctionsBeforeFreshPlay = muteCorrections;
  media.muted = false;
  media.dispatchEvent(new Event('volumechange'));
  await env.drainTimers(1000);
  check(
    'fresh play resets the budget and correction works again',
    muteCorrections > correctionsBeforeFreshPlay,
    'expected a new muting write after play, got none'
  );

  // --- hostile page that also restores rate and fires `ratechange` ----------
  // The page can reach the mute write through `setMediaPlaybackState` from its
  // own `ratechange`, so that path must draw from the same budget. Six
  // simulated seconds of this fight must stay bounded and terminate.
  const rateMedia = env.addMedia();
  env.fireDoc('play', rateMedia);
  for (let i = 0; i < 40 && (rateMedia.muted !== true || rateMedia.playbackRate !== 0.8); i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  check(
    'setup: second element attached, muted and slowed',
    rateMedia.muted === true && rateMedia.playbackRate === 0.8,
    'muted=' + rateMedia.muted + ' rate=' + rateMedia.playbackRate
  );

  env.advance(10);
  let rateHostileActive = true;
  let rateCorrections = 0;
  let rateEvents = 0;
  const rateCorrectionTimes = [];
  let rateMuted = rateMedia.muted;
  Object.defineProperty(rateMedia, 'muted', {
    configurable: true,
    get: () => rateMuted,
    set: (next) => {
      const boolean = Boolean(next);
      if (boolean === rateMuted) return;
      rateMuted = boolean;
      if (boolean === true) {
        rateCorrections++;
        rateCorrectionTimes.push(env.now());
      }
      setTimeout(() => {
        rateEvents++;
        rateMedia.dispatchEvent(new Event('volumechange'));
      }, 0);
    },
  });
  rateMedia.addEventListener('volumechange', () => {
    if (!rateHostileActive) return;
    setTimeout(() => {
      // Hostile page: restore both halves of its own playback state, then
      // reach the rate seam too.
      rateMedia.muted = false;
      rateMedia.playbackRate = 1;
      rateMedia.dispatchEvent(new Event('ratechange'));
    }, 0);
  });

  const rateCorrectionsAtStart = rateCorrections;
  const DRIVE_MS = 20;
  const DRIVE_STEPS = 300; // 300 x 20 ms = 6 s simulated
  for (let i = 0; i < DRIVE_STEPS; i++) {
    env.advance(DRIVE_MS);
    rateMedia.muted = false;
    rateMedia.playbackRate = 1;
    rateMedia.dispatchEvent(new Event('ratechange'));
    await env.drainTimers(500);
  }
  const rateDrivenCorrections = rateCorrections - rateCorrectionsAtStart;
  const rateCorrectionLog = rateCorrectionTimes.slice(rateCorrectionsAtStart);
  const worstWindow = maxWindowCount(rateCorrectionLog, 1000);
  console.log(
    '     hostile+ratechange: corrections=' + rateDrivenCorrections +
    ', worst 1 s window=' + worstWindow +
    ', queued events=' + rateEvents
  );

  check(
    'hostile ratechange page: corrections stay within 8 per rolling 1 s',
    worstWindow > 0 && worstWindow <= 8,
    'worst 1 s window held ' + worstWindow + ' corrections (' + rateDrivenCorrections + ' over ' + (DRIVE_STEPS * DRIVE_MS) / 1000 + ' s)'
  );
  check(
    'hostile ratechange page: total corrections bounded over the 6 s drive',
    rateDrivenCorrections <= 8 * 7,
    'expected <= 56 corrections, got ' + rateDrivenCorrections
  );
  check(
    'hostile ratechange page: total queued event count is bounded',
    rateEvents <= 150,
    'events=' + rateEvents
  );

  rateHostileActive = false;
  const drainedAfterRateDrive = await env.drainTimers(2000);
  check(
    'hostile ratechange page: the run terminates',
    env.pendingTimers() === 0 && drainedAfterRateDrive < 10,
    'drained ' + drainedAfterRateDrive + ', timers still queued: ' + env.pendingTimers()
  );

  // --- finite burst -> cool-down -> recovery --------------------------------
  // Nine unmute attempts inside one second exhaust the budget: the controller
  // fails OPEN to a dry bypass (audible, graph out of the way) and stays there
  // through the cool-down; a fresh play after the deadline re-attaches.
  const burst = env.addMedia();
  env.fireDoc('play', burst);
  for (let i = 0; i < 40 && burst.muted !== true; i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  check('setup: third element attached and muted', burst.muted === true);

  let burstCorrections = 0;
  let burstMuted = burst.muted;
  Object.defineProperty(burst, 'muted', {
    configurable: true,
    get: () => burstMuted,
    set: (next) => {
      const boolean = Boolean(next);
      if (boolean === burstMuted) return;
      burstMuted = boolean;
      if (boolean === true) burstCorrections++;
    },
  });

  env.fireDoc('play', burst);
  await env.settle(2);
  env.runTimers(50);
  const burstStart = burstCorrections;
  for (let i = 0; i < 9; i++) {
    burst.muted = false;
    burst.dispatchEvent(new Event('volumechange'));
    await Promise.resolve();
  }
  check(
    'finite burst: 8 corrections land and the 9th unmute is refused',
    burstCorrections - burstStart === 8,
    'expected 8 corrections from 9 unmutes, got ' + (burstCorrections - burstStart)
  );

  burst.muted = false;
  burst.dispatchEvent(new Event('volumechange'));
  await Promise.resolve();
  check(
    'finite burst: bypass holds once the budget is spent (audible dry)',
    burstCorrections - burstStart === 8 && burstMuted === false,
    'writes continued while bypassed: ' + (burstCorrections - burstStart) + ' muted=' + burstMuted
  );

  env.advance(999);
  burst.muted = false;
  burst.dispatchEvent(new Event('volumechange'));
  await Promise.resolve();
  check(
    'cool-down: still bypassed 1 ms before the deadline',
    burstCorrections - burstStart === 8,
    'expected the bypass to hold, got ' + (burstCorrections - burstStart) + ' corrections'
  );

  env.advance(2);
  env.fireDoc('play', burst);
  for (let i = 0; i < 40 && burstMuted !== true; i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  const burstAfterReattach = burstCorrections - burstStart;
  check(
    'cool-down expires: fresh play re-attaches after bypass',
    burstMuted === true && burstAfterReattach >= 8,
    'expected re-attach muted=true, got muted=' + burstMuted + ' corrections=' + burstAfterReattach
  );
  burst.muted = false;
  burst.dispatchEvent(new Event('volumechange'));
  await Promise.resolve();
  check(
    'cool-down expires: the next unmute is corrected again',
    burstCorrections - burstStart === burstAfterReattach + 1,
    'expected ' + (burstAfterReattach + 1) + ' after the 1000 ms cool-down + play, got ' + (burstCorrections - burstStart)
  );

  // --- regression: track-change doubling + YouTube Music scope ---------------
  const src = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
  const manifestText = fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8');
  const sharedText = fs.readFileSync(path.join(__dirname, '..', 'shared.js'), 'utf8');
  const popupText = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  const backgroundText = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  const privacyText = fs.readFileSync(path.join(__dirname, '..', 'PRIVACY_POLICY.md'), 'utf8');
  const storeText = fs.readFileSync(path.join(__dirname, '..', 'STORE_SUBMISSION.md'), 'utf8');
  const manifest = JSON.parse(manifestText);

  // A. sourceStale volumechange keeps the graph silent and the mute held.
  const staleM = env.addMedia();
  env.fireDoc('play', staleM);
  for (let i = 0; i < 40 && staleM.muted !== true; i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  check('setup: stale-track element attached and muted', staleM.muted === true);
  let staleCaps = env.stats.captureCalls;
  staleM.dispatchEvent(new Event('emptied'));
  check('setup: emptied keeps the stale-track element muted', staleM.muted === true);
  let mark = env.stats.rampedValues.length;
  staleM.dispatchEvent(new Event('volumechange'));
  check(
    'sourceStale + volumechange keeps masterGain at 0 (no doubled track)',
    env.stats.rampedValues.length > mark && env.stats.rampedValues[env.stats.rampedValues.length - 1] === 0,
    'last ramped gain=' + env.stats.rampedValues[env.stats.rampedValues.length - 1]
  );
  check(
    'sourceStale + volumechange leaves the element muted (mute-first swap)',
    staleM.muted === true,
    'expected true, got ' + staleM.muted
  );
  for (let i = 0; i < 40 && env.stats.captureCalls === staleCaps; i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  check(
    'setup: source-only rebuild completed and stayed muted',
    env.stats.captureCalls === staleCaps + 1 && staleM.muted === true,
    'captures +' + (env.stats.captureCalls - staleCaps) + ' muted=' + staleM.muted
  );

  // B. the contract mute must NOT silence the graph: while attached the
  // element stays muted and the graph plays at media.volume.
  mark = env.stats.rampedValues.length;
  staleM.dispatchEvent(new Event('volumechange'));
  check(
    'attached + muted + volumechange keeps masterGain at media.volume (graph plays while attached)',
    env.stats.rampedValues.length > mark && env.stats.rampedValues[env.stats.rampedValues.length - 1] === staleM.volume,
    'last ramped gain=' + env.stats.rampedValues[env.stats.rampedValues.length - 1]
  );
  check(
    'attached + muted + volumechange leaves the element muted (contract holds)',
    staleM.muted === true,
    'expected true, got ' + staleM.muted
  );

  // B2. regression: the attach-time contract mute queues a volumechange that
  // must not ramp the graph to 0 (fails on pre-fix bytes where
  // volumeHandler mapped media.muted to masterGain 0).
  const contractM = env.addMedia();
  contractM.volume = 0.7;
  env.fireDoc('play', contractM);
  for (let i = 0; i < 40 && contractM.muted !== true; i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  check('setup: contract element attached, muted, non-neutral', contractM.muted === true && contractM.playbackRate === 0.8);
  mark = env.stats.rampedValues.length;
  contractM.dispatchEvent(new Event('volumechange'));
  check(
    'contract mute + volumechange keeps masterGain at media.volume (not 0)',
    env.stats.rampedValues.length > mark && env.stats.rampedValues[env.stats.rampedValues.length - 1] === contractM.volume,
    'last ramped gain=' + env.stats.rampedValues[env.stats.rampedValues.length - 1]
  );
  check(
    'contract mute + volumechange leaves the element muted',
    contractM.muted === true,
    'expected true, got ' + contractM.muted
  );
  contractM.dispatchEvent(new Event('emptied'));
  check('setup: emptied keeps the contract element muted across the swap', contractM.muted === true);
  mark = env.stats.rampedValues.length;
  contractM.dispatchEvent(new Event('volumechange'));
  check(
    'contract element stale + volumechange ramps masterGain to 0',
    env.stats.rampedValues.length > mark && env.stats.rampedValues[env.stats.rampedValues.length - 1] === 0,
    'last ramped gain=' + env.stats.rampedValues[env.stats.rampedValues.length - 1]
  );
  staleCaps = env.stats.captureCalls;
  for (let i = 0; i < 40 && env.stats.captureCalls === staleCaps; i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  check(
    'setup: contract element rebuilt and still muted',
    env.stats.captureCalls === staleCaps + 1 && contractM.muted === true,
    'captures +' + (env.stats.captureCalls - staleCaps) + ' muted=' + contractM.muted
  );
  mark = env.stats.rampedValues.length;
  contractM.dispatchEvent(new Event('volumechange'));
  check(
    'rebuilt contract element + volumechange ramps masterGain back to media.volume',
    env.stats.rampedValues.length > mark && env.stats.rampedValues[env.stats.rampedValues.length - 1] === contractM.volume,
    'last ramped gain=' + env.stats.rampedValues[env.stats.rampedValues.length - 1]
  );
  check(
    'rebuilt contract element stays muted after volumechange',
    contractM.muted === true,
    'expected true, got ' + contractM.muted
  );

  // C. rebuild resets the mute budget.
  const budgetM = env.addMedia();
  env.fireDoc('play', budgetM);
  for (let i = 0; i < 40 && budgetM.muted !== true; i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  check('setup: budget element attached and muted', budgetM.muted === true);
  env.fireDoc('play', budgetM);
  await env.settle(2);
  env.runTimers(50);
  for (let i = 0; i < 8; i++) {
    budgetM.muted = false;
    budgetM.dispatchEvent(new Event('volumechange'));
    await Promise.resolve();
  }
  await Promise.resolve();
  budgetM.muted = false;
  budgetM.dispatchEvent(new Event('volumechange'));
  await Promise.resolve();
  check('setup: budget spent (9th unmute refused)', budgetM.muted === false);
  // A spent budget bypasses to dry path through the cool-down; a track change
  // after the deadline gets a fresh budget and rebuilds.
  env.advance(1001);
  budgetM.dispatchEvent(new Event('loadedmetadata'));
  for (let i = 0; i < 40 && budgetM.muted !== true; i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  check('rebuild after a spent budget re-mutes (loadedmetadata path)', budgetM.muted === true);
  budgetM.muted = false;
  budgetM.dispatchEvent(new Event('volumechange'));
  await Promise.resolve();
  check(
    'rebuild resets the mute budget (post-track-change unmute is corrected)',
    budgetM.muted === true,
    'element left unmuted on a live graph, got ' + budgetM.muted
  );

  // D. failed rebuild disconnects the stale tap.
  const failM = env.addMedia();
  env.fireDoc('play', failM);
  for (let i = 0; i < 40 && failM.muted !== true; i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  check('setup: fail-path element attached and muted', failM.muted === true);
  const disconnectsBefore = env.stats.disconnects;
  failM.captureStream = () => null;
  failM.dispatchEvent(new Event('emptied'));
  // Settle only: microtasks run the failed rebuild, but no fake timer fires,
  // so the retry chain cannot advance to mask the catch path.
  await env.settle(6);
  check(
    'failed rebuild disconnects the stale source tap',
    env.stats.disconnects > disconnectsBefore,
    'no disconnect after failed rebuild'
  );
  check(
    'failed rebuild leaves the element unmuted (never muted without a path)',
    failM.muted === false,
    'expected false, got ' + failM.muted
  );

  // E. attach-attempt lockout resets at the cap.
  const capM = env.addMedia();
  capM.paused = true;
  env.fireDoc('play', capM);
  for (let i = 0; i < 80; i++) {
    env.runTimers(20);
    await env.settle(1);
  }
  // One more not-ready sync after the cap: a reset counter schedules a fresh
  // retry, while a stuck counter hits the cap again and goes quiet.
  env.fireDoc('play', capM);
  await env.settle(1);
  const pendingAfterCap = env.pendingTimers();
  check(
    'attach retries continue after the cap (no 5-minute lockout)',
    pendingAfterCap > 0,
    'no retry scheduled after the cap, pending=' + pendingAfterCap
  );
  capM.paused = false;
  env.fireDoc('play', capM);
  let capped = false;
  for (let i = 0; i < 40; i++) {
    await env.settle(2);
    env.runTimers(50);
    if (capM.muted === true && capM.playbackRate === 0.8) {
      capped = true;
      break;
    }
  }
  check('attach lockout resets at the cap (element attaches after 20 failures)', capped);

  // F. live status is not Active with zero attached.
  const lonely = env.addMedia();
  lonely.paused = true;
  env.fireDoc('play', lonely);
  await env.settle(2);
  for (const m of [media, rateMedia, burst, staleM, contractM, budgetM, failM, capM]) {
    m.isConnected = false;
  }
  env.sendRuntime({ type: 'SLRA_PAGE_REVIVE', reason: 'test' });
  for (let i = 0; i < 40; i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  const live = env.queryLive();
  check('setup: live status readable', Boolean(live && live.ok));
  check(
    'live status is not Active with zero attached',
    Boolean(live) && live.attachedCount === 0 && live.text !== 'Active.',
    'got attachedCount=' + (live && live.attachedCount) + ' text=' + JSON.stringify(live && live.text)
  );

  // G. scope is YouTube Music only.
  const granted = manifest.host_permissions || [];
  const injected = (manifest.content_scripts && manifest.content_scripts[0] && manifest.content_scripts[0].matches) || [];
  const warMatches = (((manifest.web_accessible_resources || [])[0] || {}).matches) || [];
  const scopeUrls = granted.concat(injected, warMatches);
  check(
    'only music.youtube.com is granted/injected/exposed',
    scopeUrls.length > 0 && scopeUrls.every((u) => u === 'https://music.youtube.com/*'),
    'matches=' + JSON.stringify(scopeUrls)
  );
  check(
    'SUPPORTED_HOSTS is music.youtube.com only',
    sharedText.indexOf("new Set(['music.youtube.com'])") !== -1,
    'SUPPORTED_HOSTS still names another host'
  );
  check(
    'popup is YouTube Music only and shows friendly copy',
    popupText.indexOf('Waiting for tab') !== -1 &&
      popupText.replace(/music\.youtube\.com/g, '').indexOf('youtube.com') === -1,
    'popup names YouTube or lost the friendly status'
  );

  // H. static guards for the remaining fixes (each fails on the pre-fix bytes).
  const volumeBlock = (src.match(/controller\.volumeHandler = \(\) => \{[\s\S]*?enforceElementMute\(controller\);\s*\};/) || [])[0] || '';
  check(
    'volumeHandler ramps on sourceStale only, never on media.muted (static)',
    volumeBlock.indexOf('controller.sourceStale') !== -1 && volumeBlock.indexOf('controller.media.muted') === -1,
    'volumeHandler still maps media.muted to masterGain 0'
  );
  check(
    'rebuild resets the mute budget and ramps only after the mute (static)',
    /resetMuteDampener\(controller\);\s+if \(controller\.dryGain\)/.test(src) &&
      /controller\.media\.muted = true;/.test(src),
    'no resetMuteDampener + mute-before-ramp in rebuild'
  );
  check(
    'failed rebuild disconnects the stale tap (static)',
    /disconnectNode\(controller\.source\);[\s\S]{0,800}if \(capturedStream\)/.test(src),
    'no disconnectNode(controller.source) in the rebuild catch path'
  );
  check(
    'attachAttempts resets at the cap (static)',
    /controller\.attachAttempts = 0;\s+if \(!controller\.attached\) \{\s+teardownController\(controller, false/.test(src) ||
      /controller\.attachAttempts = 0;\s+teardownController\(controller, false/.test(src),
    'no attachAttempts reset before the cap teardown'
  );
  check(
    'TOGGLE_CHANGED preserves eligibility (static)',
    /TOGGLE_CHANGED[\s\S]{0,160}eligible: state\.eligible/.test(src),
    'site-toggle broadcast can resurrect eligibility'
  );
  check(
    'failed popup toggle restores the real state (static)',
    popupText.indexOf('!bypass;') === -1,
    'catch still checks the attempted value back'
  );
  check(
    'bootstrap recovers on runtime failure (static)',
    src.indexOf("queueRecovery('bootstrap')") !== -1,
    'no queueRecovery in the bootstrap catch'
  );
  check(
    'worklet retries while the context runs (static)',
    /!state\.workletLoaded && context\.state === 'running'/.test(src),
    'no addModule retry'
  );
  check(
    'teardown restores unmuted unconditionally (static)',
    src.indexOf('lastObservedMuted') === -1 &&
      /restoreMediaPlaybackState[\s\S]*?media\.muted = false;/.test(src),
    'teardown still restores observed mute'
  );

  // I. adversarial repair lane (each fails on the pre-fix bytes).
  // --- I1 mute-budget doubling: refusal keeps the live graph at 0 ---------
  const dbl = env.addMedia();
  env.fireDoc('play', dbl);
  for (let i = 0; i < 40 && dbl.muted !== true; i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  check('setup: doubling element attached and muted', dbl.muted === true);
  env.fireDoc('play', dbl);
  await env.settle(2);
  env.runTimers(50);
  const dblDisconnectsBefore = env.stats.disconnects;
  const dblAttachedBefore = env.queryLive().attachedCount;
  const dblCapsBefore = env.stats.captureCalls;
  for (let i = 0; i < 8; i++) {
    dbl.muted = false;
    dbl.dispatchEvent(new Event('volumechange'));
    await Promise.resolve();
  }
  await Promise.resolve();
  dbl.muted = false;
  dbl.dispatchEvent(new Event('volumechange'));
  await Promise.resolve();
  check('setup: doubling budget spent (9th unmute refused)', dbl.muted === false);
  const dblLive = env.queryLive();
  const dblMaster = env.stats.gains[env.stats.gains.length - 1];
  check(
    'mute-budget refusal keeps the live graph attached (no teardown to dry)',
    dblLive.attachedCount === dblAttachedBefore &&
      env.stats.disconnects === dblDisconnectsBefore &&
      env.stats.captureCalls === dblCapsBefore,
    'attached=' + dblLive.attachedCount + ' disconnects +' + (env.stats.disconnects - dblDisconnectsBefore) +
      ' captures +' + (env.stats.captureCalls - dblCapsBefore)
  );
  check(
    'mute-budget refusal parks the live graph at 0 (no doubled audio)',
    dblMaster.value === 0,
    'gain=' + dblMaster.value
  );
  env.advance(1001);
  dbl.muted = false;
  dbl.dispatchEvent(new Event('volumechange'));
  await Promise.resolve();
  check(
    'mute-budget recovery re-mutes the same graph after cool-down',
    dbl.muted === true && env.stats.captureCalls === dblCapsBefore,
    'muted=' + dbl.muted + ' captures +' + (env.stats.captureCalls - dblCapsBefore)
  );
  dbl.muted = false;
  dbl.dispatchEvent(new Event('volumechange'));
  await Promise.resolve();
  check(
    'mute-budget recovery corrects again after the cool-down',
    dbl.muted === true,
    'muted=' + dbl.muted
  );

  // --- I2 storage outage: {ok:false} must not become state ---
  const outageM = env.addMedia();
  env.fireDoc('play', outageM);
  for (let i = 0; i < 40 && outageM.muted !== true; i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  check('setup: outage element attached and muted', outageM.muted === true);
  env.sendRuntime({
    type: 'APPLY_TAB_STATE',
    ok: false,
    eligible: false,
    bypass: true,
    settings: { slow: 0.8, reverbIntensity: 0.5 },
  });
  await env.settle(2);
  check(
    'storage outage {ok:false} is ignored (element stays muted)',
    outageM.muted === true,
    'expected true, got ' + outageM.muted
  );
  check(
    'storage outage {ok:false} is ignored (static)',
    src.indexOf('runtime && runtime.ok === false') !== -1,
    'no ok:false guard in applyRuntimeState'
  );

  // --- I3 neutral with zero attached is not Active ---
  env.sendRuntime({
    type: 'APPLY_TAB_STATE',
    eligible: true,
    bypass: false,
    settings: { slow: 1, reverbIntensity: 0 },
  });
  await env.settle(2);
  for (const m of [media, rateMedia, burst, staleM, contractM, budgetM, failM, capM, dbl, outageM]) {
    m.isConnected = false;
  }
  lonely.isConnected = true;
  env.sendRuntime({ type: 'SLRA_PAGE_REVIVE', reason: 'test' });
  for (let i = 0; i < 40; i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  const neutralLive = env.queryLive();
  check('setup: neutral live status readable', Boolean(neutralLive && neutralLive.ok));
  check(
    'neutral + zero attached is not "Active, neutral."',
    Boolean(neutralLive) && neutralLive.attachedCount === 0 && neutralLive.text !== 'Active, neutral.',
    'got attachedCount=' + (neutralLive && neutralLive.attachedCount) + ' text=' + JSON.stringify(neutralLive && neutralLive.text)
  );
  check(
    'neutral + zero attached reports neutral:false',
    Boolean(neutralLive) && neutralLive.attachedCount === 0 && neutralLive.neutral === false,
    'got neutral=' + (neutralLive && neutralLive.neutral)
  );

  // --- I static guards ---
  check(
    'context race: watchdog resumes a non-running context (static)',
    src.indexOf("state.context && state.context.state !== 'running'") !== -1 &&
      /if \(state\.context && state\.context\.state !== 'running'\)[\s\S]{0,120}resumeContext\(\)/.test(src),
    'no watchdog resume'
  );
  check(
    'closed context is recreated (static)',
    src.indexOf("state.context.state === 'closed'") !== -1 &&
      src.indexOf('state.context = null') !== -1 &&
      /state\.context = null;\s+state\.workletLoaded = false;/.test(src),
    'no closed-context recreate'
  );
  const enforceBlock = (src.match(/function enforceElementMute\(controller\) \{[\s\S]*?\n  \}/) || [])[0] || '';
  check(
    'mute-budget refusal keeps the graph and parks it at 0 (static)',
    enforceBlock.indexOf('budgetBypassed = true') !== -1 &&
      enforceBlock.indexOf('hardZero(controller.masterGain.gain)') !== -1 &&
      enforceBlock.indexOf('teardownController') === -1,
    'budget refusal still tears the graph down'
  );
  check(
    'mute-budget recovery restores the graph (static)',
    src.indexOf('controller.masterGain && !controller.sourceStale') !== -1,
    'no masterGain restore on correction'
  );
  check(
    'dead worklet reloads from the watchdog (static)',
    src.indexOf('state.workletRetryCount < 3') !== -1 &&
      src.indexOf('state.workletLastRetry') !== -1 &&
      src.indexOf('>= 5000') !== -1 &&
      src.indexOf('state.workletRetryCount = 0') !== -1,
    'no bounded 3x5s watchdog reload'
  );
  check(
    'failed rebuild stops the old stream and clears taps (static)',
    /if \(controller\.stream\)[\s\S]{0,200}track\.stop\(\)[\s\S]{0,200}controller\.stream = null;\s+controller\.source = null;\s+controller\.sourceStale = true;/.test(src),
    'no old-stream stop/null/sourceStale in rebuild catch'
  );
  check(
    'false status gated on attachedCount (static)',
    src.indexOf("attachedCount > 0 && isNeutral(state.settings)") !== -1 &&
      src.indexOf('active && attachedCount > 0 && isNeutral(state.settings)') !== -1,
    'neutral status not gated on attachedCount'
  );
  check(
    'stored site settings beat a stale tab session (static)',
    /if \(session && !siteKey\)/.test(backgroundText),
    'tab session still overrides stored site settings'
  );
  check(
    'popup does not race the background siteToggles write (static)',
    popupText.indexOf('await saveSiteState') === -1,
    'popup still writes siteToggles after SET_TAB_BYPASS'
  );
  check(
    'manifest permissions include scripting, storage, tabs (static)',
    Array.isArray(manifest.permissions) &&
      manifest.permissions.indexOf('scripting') !== -1 &&
      manifest.permissions.indexOf('storage') !== -1 &&
      manifest.permissions.indexOf('tabs') !== -1,
    'permissions=' + JSON.stringify(manifest.permissions)
  );
  check(
    'manifest description names YouTube Music, not any tab (static)',
    typeof manifest.description === 'string' &&
      manifest.description.indexOf('YouTube Music') !== -1 &&
      manifest.description.indexOf('any tab') === -1,
    'description=' + JSON.stringify(manifest.description)
  );
  check(
    'manifest host_permissions is exactly music.youtube.com (static)',
    JSON.stringify(manifest.host_permissions) === JSON.stringify(['https://music.youtube.com/*']),
    'host_permissions=' + JSON.stringify(manifest.host_permissions)
  );
  check(
    'manifest content_scripts.matches is music.youtube.com only (static)',
    Array.isArray(manifest.content_scripts) &&
      manifest.content_scripts.length > 0 &&
      manifest.content_scripts.every((entry) =>
        Array.isArray(entry.matches) &&
        entry.matches.length > 0 &&
        entry.matches.every((u) => u === 'https://music.youtube.com/*')),
    'content_scripts=' + JSON.stringify((manifest.content_scripts || []).map((e) => e.matches))
  );
  check(
    'manifest WAR matches music.youtube.com only and resources exactly dattorro-worklet.js (static)',
    Array.isArray(manifest.web_accessible_resources) &&
      manifest.web_accessible_resources.length > 0 &&
      manifest.web_accessible_resources.every((entry) =>
        Array.isArray(entry.matches) &&
        entry.matches.length > 0 &&
        entry.matches.every((u) => u === 'https://music.youtube.com/*') &&
        Array.isArray(entry.resources) &&
        JSON.stringify(entry.resources) === JSON.stringify(['dattorro-worklet.js'])),
    'war=' + JSON.stringify(manifest.web_accessible_resources)
  );
  const throttleBlock = (popupText.match(/function throttledApply[\s\S]*?\n\}/) || [])[0] || '';
  const liveBlock = (popupText.match(/function applyLiveSettings[\s\S]*?\n\}/) || [])[0] || '';
  check(
    'live drag sends APPLY_LIVE_SETTINGS only, never applySettings/persist (static)',
    throttleBlock.indexOf('applyLiveSettings(') !== -1 &&
      throttleBlock.indexOf('void applySettings(') === -1 &&
      throttleBlock.indexOf('SET_SITE_SETTINGS') === -1 &&
      liveBlock.indexOf('APPLY_LIVE_SETTINGS') !== -1 &&
      liveBlock.indexOf('SET_SITE_SETTINGS') === -1 &&
      liveBlock.indexOf('void applySettings(') === -1,
    'input path still persists via applySettings'
  );
  check(
    'persist happens on pointerup/change only (static)',
    popupText.indexOf("addEventListener('pointerup'") !== -1 &&
      popupText.indexOf("addEventListener('change'") !== -1 &&
      popupText.indexOf('SET_SITE_SETTINGS') !== -1,
    'missing pointerup/change persist'
  );
  check(
    'ensureAttached hoists stream/source and cleans up on failure (static)',
    src.indexOf('let stream = null;') !== -1 &&
      src.indexOf('let source = null;') !== -1 &&
      src.indexOf('stream = captureMediaStream') !== -1 &&
      src.indexOf('source = context.createMediaStreamSource(stream);') !== -1,
    'stream/source not hoisted above try'
  );
  check(
    'import-time rehydrate is gated by a session flag (static)',
    backgroundText.indexOf('chrome.storage.session') !== -1 &&
      backgroundText.indexOf('slowedReverbRehydrated') !== -1,
    'no session gate on import-time rehydrate'
  );
  check(
    'waiting pill uses idle, off stays for bypass (static)',
    popupText.indexOf("dataset.state = 'idle'") !== -1 &&
      /power off\|off for[\s\S]{0,120}dataset\.state = 'off'/.test(popupText),
    'waiting pill still shares off grey'
  );
  check(
    'privacy policy is YouTube Music only (static)',
    privacyText.indexOf('YouTube Music only') !== -1 &&
      privacyText.indexOf('YouTube and YouTube Music') === -1,
    'privacy still names YouTube + Music'
  );
  check(
    'store submission is YouTube Music only (static)',
    storeText.indexOf('YouTube Music') !== -1 &&
      storeText.indexOf('YouTube and YouTube Music') === -1,
    'store submission still names YouTube + Music'
  );
  const pageMsgBlock = (src.match(/window\.addEventListener\('message',[\s\S]*?\n    \}\);/) || [])[0] || '';
  check(
    'page messages never clear lastError (static)',
    pageMsgBlock.indexOf('lastError') === -1,
    'page-message handler still clears lastError'
  );
  check(
    'page-message recovery is rate-limited to 1 s (static)',
    pageMsgBlock.indexOf('lastPageMessageRecovery') !== -1 && pageMsgBlock.indexOf('>= 1000') !== -1,
    'no 1 s rate limit on page-message recovery'
  );

  // --- J. zero-overlap: hardZero before every unmute ---
  // The stub models the exponential ramp: setTargetAtTime never touches
  // .value immediately, while hardZero (cancel + setValueAtTime(0)) does.
  // Each site first simulates a settled audible graph (gain.value = 1),
  // then fires the handler synchronously and asserts the immediate gain is
  // exactly 0 at the unmuted instant with no setTarget(0) ramp.
  env.sendRuntime({
    type: 'APPLY_TAB_STATE',
    eligible: true,
    bypass: false,
    settings: { slow: 0.8, reverbIntensity: 0.5 },
  });
  await env.settle(2);

  async function attachZeroProbe() {
    const m = env.addMedia();
    m.volume = 1;
    env.fireDoc('play', m);
    for (let i = 0; i < 40 && m.muted !== true; i++) {
      await env.settle(2);
      env.runTimers(50);
    }
    return m;
  }
  function lastMaster() {
    return env.stats.gains[env.stats.gains.length - 1];
  }
  function opsSince(mark) {
    return env.stats.audioOps.slice(mark);
  }
  function hasRampToZero(ops) {
    return ops.some((o) => o.op === 'setTarget' && o.value === 0);
  }
  function hasHardZero(ops) {
    return ops.some((o) => o.op === 'setValue' && o.value === 0);
  }

  // J1 emptied: hard-zero, mute held, no unmute write at all.
  const jEmptied = await attachZeroProbe();
  check('setup: zero-overlap emptied probe attached muted', jEmptied.muted === true);
  const jEmptiedGain = lastMaster();
  jEmptiedGain.value = 1;
  let jEmptiedMuted = jEmptied.muted;
  Object.defineProperty(jEmptied, 'muted', {
    configurable: true,
    get: () => jEmptiedMuted,
    set: (next) => {
      const b = Boolean(next);
      if (b === jEmptiedMuted) return;
      jEmptiedMuted = b;
      env.stats.audioOps.push({ op: 'muted', value: b });
    },
  });
  let jMark = env.stats.audioOps.length;
  const jCancelBefore = env.stats.cancelCalls;
  const jEmptiedCaps = env.stats.captureCalls;
  jEmptied.dispatchEvent(new Event('emptied'));
  check('emptied keeps the element muted (no dry gap)', jEmptiedMuted === true, 'muted=' + jEmptiedMuted);
  check('emptied hard-zeroes the graph immediately', jEmptiedGain.value === 0, 'gain=' + jEmptiedGain.value);
  check(
    'emptied schedules cancel + setValue(0) and no setTarget(0)',
    hasHardZero(opsSince(jMark)) && env.stats.cancelCalls > jCancelBefore && !hasRampToZero(opsSince(jMark)),
    'ops=' + JSON.stringify(opsSince(jMark))
  );
  for (let i = 0; i < 40 && env.stats.captureCalls === jEmptiedCaps; i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  check('emptied source swap completed', env.stats.captureCalls === jEmptiedCaps + 1);

  // J2 loadedmetadata: same ordering (mute held, hardZero, no ramp).
  const jLoad = await attachZeroProbe();
  check('setup: zero-overlap load probe attached muted', jLoad.muted === true);
  const jLoadGain = lastMaster();
  jLoadGain.value = 1;
  let jLoadMuted = jLoad.muted;
  Object.defineProperty(jLoad, 'muted', {
    configurable: true,
    get: () => jLoadMuted,
    set: (next) => {
      const b = Boolean(next);
      if (b === jLoadMuted) return;
      jLoadMuted = b;
      env.stats.audioOps.push({ op: 'muted', value: b });
    },
  });
  jMark = env.stats.audioOps.length;
  const jLoadCancelBefore = env.stats.cancelCalls;
  const jLoadCaps = env.stats.captureCalls;
  jLoad.dispatchEvent(new Event('loadedmetadata'));
  check('loadedmetadata keeps the element muted (no dry gap)', jLoadMuted === true, 'muted=' + jLoadMuted);
  check('loadedmetadata hard-zeroes the graph immediately', jLoadGain.value === 0, 'gain=' + jLoadGain.value);
  check(
    'loadedmetadata schedules cancel + setValue(0) and no setTarget(0)',
    hasHardZero(opsSince(jMark)) && env.stats.cancelCalls > jLoadCancelBefore && !hasRampToZero(opsSince(jMark)),
    'ops=' + JSON.stringify(opsSince(jMark))
  );
  for (let i = 0; i < 40 && env.stats.captureCalls === jLoadCaps; i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  check('loadedmetadata source swap completed', env.stats.captureCalls === jLoadCaps + 1);

  // J3 sourceStale volumechange: graph stays at exactly 0, mute held.
  const jStale = await attachZeroProbe();
  check('setup: zero-overlap stale probe attached muted', jStale.muted === true);
  const jStaleGain = lastMaster();
  jStaleGain.value = 1;
  const jStaleCaps = env.stats.captureCalls;
  jStale.dispatchEvent(new Event('emptied'));
  check('setup: stale probe stays muted', jStale.muted === true);
  jStaleGain.value = 1;
  jMark = env.stats.audioOps.length;
  const jStaleCancelBefore = env.stats.cancelCalls;
  jStale.dispatchEvent(new Event('volumechange'));
  check(
    'sourceStale volumechange hard-zeros: gain exactly 0 while muted',
    jStaleGain.value === 0 && jStale.muted === true,
    'gain=' + jStaleGain.value + ' muted=' + jStale.muted
  );
  check(
    'sourceStale volumechange: no setTarget ramp, hardZero scheduled',
    hasHardZero(opsSince(jMark)) && !hasRampToZero(opsSince(jMark)) && env.stats.cancelCalls > jStaleCancelBefore,
    'ops=' + JSON.stringify(opsSince(jMark))
  );
  for (let i = 0; i < 40 && env.stats.captureCalls === jStaleCaps; i++) {
    await env.settle(2);
    env.runTimers(50);
  }

  // J4 mute-budget refusal: keep the graph, park it at 0, retry later.
  const jRefuse = await attachZeroProbe();
  check('setup: zero-overlap refusal probe attached muted', jRefuse.muted === true);
  env.fireDoc('play', jRefuse);
  await env.settle(2);
  env.runTimers(50);
  for (let i = 0; i < 8; i++) {
    jRefuse.muted = false;
    jRefuse.dispatchEvent(new Event('volumechange'));
    await Promise.resolve();
  }
  check('setup: refusal probe budget spent (still corrects)', jRefuse.muted === true);
  const jRefuseDisconnectsBefore = env.stats.disconnects;
  const jRefuseCapsBefore = env.stats.captureCalls;
  const jRefuseAttachedBefore = env.queryLive().attachedCount;
  jMark = env.stats.audioOps.length;
  jRefuse.muted = false;
  jRefuse.dispatchEvent(new Event('volumechange'));
  await Promise.resolve();
  check(
    'refusal keeps the live graph (no teardown)',
    env.stats.disconnects === jRefuseDisconnectsBefore &&
      env.stats.captureCalls === jRefuseCapsBefore &&
      env.queryLive().attachedCount === jRefuseAttachedBefore,
    'disconnects +' + (env.stats.disconnects - jRefuseDisconnectsBefore) + ' captures +' + (env.stats.captureCalls - jRefuseCapsBefore)
  );
  check(
    'refusal parks the graph at exactly 0',
    lastMaster().value === 0 && jRefuse.muted === false,
    'gain=' + lastMaster().value + ' muted=' + jRefuse.muted
  );

  // J5 swap: a disconnected element pauses before its state restores.
  const jSwap = await attachZeroProbe();
  check('setup: zero-overlap swap probe attached muted', jSwap.muted === true);
  jSwap.isConnected = false;
  env.sendRuntime({ type: 'SLRA_PAGE_REVIVE', reason: 'test' });
  for (let i = 0; i < 40; i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  check(
    'swap pauses a disconnected element before restoring state',
    jSwap.pauseCalled === true && jSwap.paused === true,
    'pauseCalled=' + jSwap.pauseCalled + ' paused=' + jSwap.paused
  );

  // --- K. track-switch doubling: mute-first rebuild, zeroed no-audio unmute,
  // generation-guarded async attach. Each fails on the pre-fix bytes.
  // Invariant under test: audible(controller) === (attached && !sourceStale).

  // K1 rebuild path: the element stays muted end to end and the gain only
  // rises after the new tap is connected.
  const kRe = await attachZeroProbe();
  check('setup: rebuild-order probe attached muted', kRe.muted === true);
  const kReCaps = env.stats.captureCalls;
  const kReGain = lastMaster();
  const kReMark = env.stats.audioOps.length;
  const kReRampedMark = env.stats.rampedValues.length;
  let kReOwnCaps = 0;
  const kReOriginalCapture = kRe.captureStream.bind(kRe);
  kRe.captureStream = () => {
    kReOwnCaps += 1;
    return kReOriginalCapture();
  };
  kRe.dispatchEvent(new Event('emptied'));
  check(
    'setup: rebuild-order probe stays muted through the swap',
    kRe.muted === true && kReGain.value === 0,
    'muted=' + kRe.muted + ' gain=' + kReGain.value
  );
  let kReMuted = kRe.muted;
  Object.defineProperty(kRe, 'muted', {
    configurable: true,
    get: () => kReMuted,
    set: (next) => {
      const b = Boolean(next);
      if (b === kReMuted) return;
      kReMuted = b;
      env.stats.audioOps.push({ op: 'muted', value: b });
    },
  });
  for (let i = 0; i < 40 && kReOwnCaps === 0; i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  check(
    'setup: rebuild-order probe rebuilt',
    kReOwnCaps === 1 && env.stats.captureCalls === kReCaps + 1,
    'own captures=' + kReOwnCaps + ' total +' + (env.stats.captureCalls - kReCaps)
  );
  const kReOps = env.stats.audioOps.slice(kReMark);
  check(
    'rebuild never unmutes during the swap',
    kReMuted === true && !kReOps.some((o) => o.op === 'muted' && o.value === false),
    'ops=' + JSON.stringify(kReOps)
  );
  check(
    'rebuild returns the graph to media.volume after the mute',
    env.stats.rampedValues.slice(kReRampedMark).indexOf(kRe.volume) !== -1,
    'ramps after swap=' + JSON.stringify(env.stats.rampedValues.slice(kReRampedMark)) + ' volume=' + kRe.volume
  );

  // K2 no-audio-track path: mute held, graph at 0, old tap retained.
  const kNo = await attachZeroProbe();
  check('setup: no-audio probe attached muted', kNo.muted === true);
  const kNoGain = lastMaster();
  kNo.captureStream = () => {
    const t = { kind: 'video', stopped: false, stop() { this.stopped = true; } };
    return { getAudioTracks: () => [], getTracks: () => [t], addEventListener() {} };
  };
  kNo.dispatchEvent(new Event('emptied'));
  check('setup: no-audio probe stays muted into the swap', kNo.muted === true);
  for (let i = 0; i < 20; i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  check(
    'no-audio rebuild keeps the element muted with the graph at 0',
    kNo.muted === true && kNoGain.value === 0,
    'muted=' + kNo.muted + ' gain=' + kNoGain.value
  );
  check(
    'no-audio rebuild keeps the live graph (never muted without a graph)',
    env.queryLive().attachedCount >= 1,
    'attached=' + env.queryLive().attachedCount
  );

  // K3 stale generation: an async continuation that resolves after its
  // generation was bumped must not write muted or gain.
  const kGen = await attachZeroProbe();
  check('setup: stale-generation probe attached muted', kGen.muted === true);
  kGen.paused = true;
  kGen.dispatchEvent(new Event('emptied'));
  await env.settle(2);
  check('setup: stale retry parked while not ready', env.pendingTimers() > 0);
  kGen.dispatchEvent(new Event('loadedmetadata'));
  await env.settle(2);
  kGen.paused = false;
  const kGenOpsMark = env.stats.audioOps.length;
  const kGenMutedBefore = kGen.muted;
  check('setup: probe still muted before the stale timer fires', kGenMutedBefore === true);
  await env.drainTimers(500);
  await env.settle(2);
  check(
    'stale generation leaves muted alone',
    kGen.muted === kGenMutedBefore && kGen.muted === true,
    'muted=' + kGen.muted
  );
  check(
    'stale generation writes no audible gain',
    env.stats.audioOps.slice(kGenOpsMark).every((o) => !(o.value > 0)),
    'ops=' + JSON.stringify(env.stats.audioOps.slice(kGenOpsMark))
  );

  // --- S. swap fast path: media-filtered observer, no 50 ms debounce -------
  // Each fails on the pre-fix bytes (debounced 50 ms scan on every mutation).
  await env.drainTimers(2000);
  check(
    'observer watches documentElement with childList+subtree',
    env.stubObservers.length > 0 &&
      env.stubObservers[0].targets.length > 0 &&
      env.stubObservers[0].targets[0].options.childList === true &&
      env.stubObservers[0].targets[0].options.subtree === true,
    'targets=' + JSON.stringify(env.stubObservers.length > 0 ? env.stubObservers[0].targets : [])
  );
  const fireObserver = (records) => {
    for (const obs of env.stubObservers) obs.callback(records);
  };
  const mediaRecord = (tag) => [{ addedNodes: [{ tagName: tag }], removedNodes: [] }];

  // S1: a media add scans within one frame, with no 50 ms timer.
  const sFast = env.addMedia();
  sFast.muted = false;
  const qBeforeFast = env.queryCalls();
  const debounceBeforeFast = env.timerDelays().filter((ms) => ms === 50).length;
  fireObserver(mediaRecord('VIDEO'));
  await env.settle(2);
  check(
    'swap scan runs within one frame (no 50 ms wait)',
    env.queryCalls() > qBeforeFast,
    'no scan after one frame'
  );
  check(
    'swap fast path schedules no 50 ms timer',
    env.timerDelays().filter((ms) => ms === 50).length === debounceBeforeFast,
    'pending50=' + env.timerDelays().filter((ms) => ms === 50).length
  );
  for (let i = 0; i < 40 && sFast.muted !== true; i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  check('setup: fast-path probe attached muted', sFast.muted === true);

  // S2: a storm of 50 media records coalesces to exactly one scan.
  await env.drainTimers(2000);
  const qBeforeStorm = env.queryCalls();
  for (let i = 0; i < 50; i++) fireObserver(mediaRecord('VIDEO'));
  await env.settle(2);
  check(
    'DOM storm of 50 mutations produces exactly one scan',
    env.queryCalls() - qBeforeStorm === 1,
    'scans=' + (env.queryCalls() - qBeforeStorm)
  );
  await env.drainTimers(2000);
  // S2b: 50 unrelated (DIV) mutations schedule no scan and no timer.
  const qBeforeDiv = env.queryCalls();
  const debounceBeforeDiv = env.timerDelays().filter((ms) => ms === 50).length;
  for (let i = 0; i < 50; i++) {
    fireObserver([{ addedNodes: [{ tagName: 'DIV' }], removedNodes: [] }]);
  }
  await env.settle(2);
  check(
    'unrelated mutations schedule no scan',
    env.queryCalls() === qBeforeDiv &&
      env.timerDelays().filter((ms) => ms === 50).length === debounceBeforeDiv,
    'scans=' + (env.queryCalls() - qBeforeDiv) +
      ' pending50=' + env.timerDelays().filter((ms) => ms === 50).length
  );

  // S3: swap pauses/mutes the old element before the new one attaches.
  const sOld = env.addMedia();
  env.fireDoc('play', sOld);
  for (let i = 0; i < 40 && sOld.muted !== true; i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  check('setup: swap-old attached muted', sOld.muted === true);
  sOld.paused = false;
  sOld.pauseCalled = false;
  const swapOrder = [];
  const origPause = sOld.pause.bind(sOld);
  sOld.pause = () => {
    swapOrder.push('old-pause');
    origPause();
  };
  const sNew = env.addMedia();
  let sNewMuted = false;
  sNew.muted = false;
  Object.defineProperty(sNew, 'muted', {
    configurable: true,
    get: () => sNewMuted,
    set: (next) => {
      const boolean = Boolean(next);
      if (boolean === sNewMuted) return;
      sNewMuted = boolean;
      if (boolean === true) swapOrder.push('new-mute');
    },
  });
  sOld.isConnected = false;
  fireObserver([{ addedNodes: [{ tagName: 'VIDEO' }], removedNodes: [{ tagName: 'VIDEO' }] }]);
  for (let i = 0; i < 40 && !(sNewMuted === true && sOld.pauseCalled === true); i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  check(
    'swap pauses a disconnected element before restoring state',
    sOld.pauseCalled === true && sOld.paused === true,
    'pauseCalled=' + sOld.pauseCalled + ' paused=' + sOld.paused
  );
  check(
    'swap mutes/pauses old before new attaches',
    swapOrder.indexOf('old-pause') !== -1 &&
      swapOrder.indexOf('new-mute') !== -1 &&
      swapOrder.indexOf('old-pause') < swapOrder.indexOf('new-mute'),
    'order=' + JSON.stringify(swapOrder)
  );

  // S static guards (each fails on the pre-fix bytes).
  const observerBlock = (src.match(/function ensureObserver\(\) \{[\s\S]*?\n  \}/) || [])[0] || '';
  check(
    'observer filters to media adds/removes (static)',
    src.indexOf('isMediaMutation') !== -1 &&
      src.indexOf("'VIDEO'") !== -1 &&
      src.indexOf("'AUDIO'") !== -1,
    'no VIDEO/AUDIO media filter'
  );
  check(
    'observer fast path uses a microtask, not a 50 ms debounce (static)',
    observerBlock.indexOf('queueScan()') !== -1 && observerBlock.indexOf('setTimeout') === -1,
    'observer still debounces with setTimeout'
  );
  check(
    'slow safety poll retained (static)',
    /setInterval\([\s\S]{0,120}, 5000\)/.test(src) || /setInterval\([\s\S]{0,120}, 2000\)/.test(src),
    'no 2 s+ safety poll'
  );
  const scanBlock = (src.match(/function scanMediaElements\(\) \{[\s\S]*?\n  \}/) || [])[0] || '';
  check(
    'swap tears down disconnected controllers before tracking new media (static)',
    scanBlock.indexOf('teardownController') !== -1 &&
      scanBlock.indexOf('querySelectorAll') !== -1 &&
      scanBlock.indexOf('teardownController') < scanBlock.indexOf('querySelectorAll'),
    'scan still tracks before teardown'
  );

  // --- Z. repair lane items 1-10 (each fails on the pre-fix bytes) ---
  const workletText = fs.readFileSync(path.join(__dirname, '..', 'dattorro-worklet.js'), 'utf8');

  // Z1: page postMessage requires origin + source.
  const hooksBeforeForeign = env.stats.ensureHooksCalls;
  env.fireWin('message', {
    source: {},
    origin: 'https://music.youtube.com',
    data: { __slra: true, type: 'SLRA_PAGE_REVIVE', reason: 'missing-hook' },
  });
  await env.settle(3);
  await env.drainTimers(200);
  check(
    'Z1 wrong-source page message ignored (no hook refresh)',
    env.stats.ensureHooksCalls === hooksBeforeForeign,
    'calls=' + env.stats.ensureHooksCalls + ' before=' + hooksBeforeForeign
  );
  env.fireWin('message', {
    source: globalThis.window,
    origin: 'https://evil.com',
    data: { __slra: true, type: 'SLRA_PAGE_REVIVE', reason: 'missing-hook' },
  });
  await env.settle(3);
  await env.drainTimers(200);
  check(
    'Z1 foreign-origin page REVIVE ignored (no hook refresh)',
    env.stats.ensureHooksCalls === hooksBeforeForeign,
    'calls=' + env.stats.ensureHooksCalls + ' before=' + hooksBeforeForeign
  );
  env.fireWin('message', {
    source: globalThis.window,
    origin: 'https://music.youtube.com',
    data: { __slra: true, type: 'SLRA_PAGE_REVIVE', reason: 'missing-hook' },
  });
  await env.settle(3);
  await env.drainTimers(200);
  check(
    'Z1 same-origin page REVIVE triggers hook refresh',
    env.stats.ensureHooksCalls > hooksBeforeForeign,
    'calls=' + env.stats.ensureHooksCalls + ' before=' + hooksBeforeForeign
  );
  check(
    'Z1 origin gate is origin + source (static)',
    src.indexOf('event.origin !== location.origin') !== -1 &&
      src.indexOf('event.source !== window') !== -1,
    'no origin+source gate in message handler'
  );

  // Z2: hook-ready token (forged READY ignored, correct accepted).
  const hookApi = globalThis.__slowedReverbAudioContent;
  check(
    'Z2 hook token helper exists (static)',
    hookApi && typeof hookApi.__testGetHookToken === 'function',
    'no token helper'
  );
  const currentToken = hookApi.__testGetHookToken();
  check(
    'Z2 hook token minted to DOM (static)',
    typeof currentToken === 'string' && currentToken.length > 0 &&
      globalThis.document.documentElement.dataset.slraToken === currentToken,
    'token=' + currentToken
  );
  hookApi.__testSetHookReady(false);
  check('setup: hook ready reset to false', hookApi.__testIsHookReady() === false);
  env.fireWin('message', {
    source: globalThis.window,
    origin: 'https://music.youtube.com',
    data: { __slra: true, type: 'SLRA_PAGE_HOOK_READY' },
  });
  await env.settle(2);
  check(
    'Z2 forged READY without token ignored',
    hookApi.__testIsHookReady() === false,
    'ready=' + hookApi.__testIsHookReady()
  );
  env.fireWin('message', {
    source: globalThis.window,
    origin: 'https://music.youtube.com',
    data: { __slra: true, type: 'SLRA_PAGE_HOOK_READY', token: 'wrong-token' },
  });
  await env.settle(2);
  check(
    'Z2 forged READY with wrong token ignored',
    hookApi.__testIsHookReady() === false,
    'ready=' + hookApi.__testIsHookReady()
  );
  env.fireWin('message', {
    source: globalThis.window,
    origin: 'https://evil.com',
    data: { __slra: true, type: 'SLRA_PAGE_HOOK_READY', token: currentToken },
  });
  await env.settle(2);
  check(
    'Z2 correct token from foreign origin ignored',
    hookApi.__testIsHookReady() === false,
    'ready=' + hookApi.__testIsHookReady()
  );
  env.fireWin('message', {
    source: globalThis.window,
    origin: 'https://music.youtube.com',
    data: { __slra: true, type: 'SLRA_PAGE_HOOK_READY', token: currentToken },
  });
  await env.settle(2);
  check(
    'Z2 correct token from same origin accepted',
    hookApi.__testIsHookReady() === true,
    'ready=' + hookApi.__testIsHookReady()
  );
  check(
    'Z2 READY requires token match (static)',
    src.indexOf('data.token !== state.pageHookToken') !== -1,
    'no token match in READY handler'
  );

  // Z3: budget exhaustion keeps the live graph at 0 and recovers.
  const z3 = env.addMedia();
  z3.volume = 0.9;
  env.fireDoc('play', z3);
  for (let i = 0; i < 40 && z3.muted !== true; i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  check('setup: Z3 element attached muted', z3.muted === true);
  const z3DiscBefore = env.stats.disconnects;
  const z3CapsBefore = env.stats.captureCalls;
  const z3AttachedBefore = env.queryLive().attachedCount;
  for (let i = 0; i < 9; i++) {
    z3.muted = false;
    z3.dispatchEvent(new Event('volumechange'));
    await Promise.resolve();
  }
  check(
    'Z3 budget exhaustion keeps the graph live (no teardown)',
    z3.muted === false &&
      env.stats.disconnects === z3DiscBefore &&
      env.stats.captureCalls === z3CapsBefore &&
      env.queryLive().attachedCount === z3AttachedBefore,
    'muted=' + z3.muted + ' disconnects +' + (env.stats.disconnects - z3DiscBefore) +
      ' captures +' + (env.stats.captureCalls - z3CapsBefore)
  );
  check(
    'Z3 refusal parks the live graph at 0',
    lastMaster().value === 0,
    'gain=' + lastMaster().value
  );
  check(
    'Z3 status is friendly copy, never the old bypass error (static)',
    src.indexOf('Bypassed (mute fight).') === -1 && src.indexOf("text = 'Active.'") !== -1,
    'status still exposes an internal error string'
  );
  env.advance(1001);
  z3.muted = false;
  z3.dispatchEvent(new Event('volumechange'));
  await Promise.resolve();
  check('Z3 fresh unmute after cool-down re-mutes the same graph', z3.muted === true, 'muted=' + z3.muted);

  // Z4: corrupt stored settings fall back to documented defaults.
  const Shared = globalThis.SlowedReverbShared;
  check(
    'Z4 non-finite slow falls back to 1.00x',
    Shared.normalizeSettings({ slow: NaN }).slow === 1,
    'got ' + Shared.normalizeSettings({ slow: NaN }).slow
  );
  check(
    'Z4 out-of-range slow falls back to 1.00x',
    Shared.normalizeSettings({ slow: 10 }).slow === 1 &&
      Shared.normalizeSettings({ slow: -5 }).slow === 1,
    'got ' + Shared.normalizeSettings({ slow: 10 }).slow
  );
  check(
    'Z4 out-of-range intensity falls back to 0%',
    Shared.normalizeSettings({ reverbIntensity: 5 }).reverbIntensity === 0,
    'got ' + Shared.normalizeSettings({ reverbIntensity: 5 }).reverbIntensity
  );
  check(
    'Z4 non-finite intensity falls back to 0%',
    Shared.normalizeSettings({ reverbIntensity: Infinity }).reverbIntensity === 0,
    'got ' + Shared.normalizeSettings({ reverbIntensity: Infinity }).reverbIntensity
  );

  // Z5: storage failure falls back to defaults, page stays eligible.
  check(
    'Z5 storage failure falls back to defaults (static)',
    /async function getStoredSiteSettings\(\) \{\s+try/.test(backgroundText) &&
      backgroundText.indexOf('return {};') !== -1,
    'no try/catch fallback in getStoredSiteSettings'
  );

  // Z6: rehydrate flag set only after successful rehydrate.
  check(
    'Z6 rehydrate flag set only after success (static)',
    backgroundText.indexOf('await scheduleRehydrate') !== -1 &&
      backgroundText.indexOf('slowedReverbRehydrated: true') !== -1 &&
      backgroundText.indexOf('await scheduleRehydrate') <
        backgroundText.indexOf('slowedReverbRehydrated: true'),
    'flag still set before rehydrate'
  );

  // Z7: suspend when idle, resume on play.
  const allForSuspend = globalThis.document.querySelectorAll('audio,video');
  for (const m of allForSuspend) m.paused = true;
  env.fireDoc('pause', allForSuspend[0] || z3);
  await env.settle(3);
  const suspendedLive = env.queryLive();
  check(
    'Z7 idle suspends the context (no attached playing)',
    suspendedLive && suspendedLive.contextState === 'suspended',
    'contextState=' + (suspendedLive && suspendedLive.contextState)
  );
  check(
    'Z7 suspend helper exists (static)',
    src.indexOf('maybeSuspendContext') !== -1 &&
      src.indexOf("document.addEventListener('pause'") !== -1,
    'no pause suspend'
  );
  if (allForSuspend[0]) {
    allForSuspend[0].paused = false;
    env.fireDoc('play', allForSuspend[0]);
    await env.settle(3);
    await env.drainTimers(200);
  }
  const resumedLive = env.queryLive();
  check(
    'Z7 play resumes the context',
    resumedLive && resumedLive.contextState === 'running',
    'contextState=' + (resumedLive && resumedLive.contextState)
  );

  // Z8: worklet skips the tank when dry, invariants hoisted.
  check(
    'Z8 dry fast path skips the tank (static)',
    workletText.indexOf('this.wetGain === 0 && this.wetTarget === 0') !== -1,
    'no dry fast path'
  );
  check(
    'Z8 per-sample invariants hoisted above the loop (static)',
    /const pdFloat = Math\.min\(/.test(workletText) &&
      workletText.indexOf('const lpfCoeff = this.lpfCoeff;') !== -1 &&
      workletText.indexOf('const pdFloat') < workletText.indexOf('for (let i = 0; i < n; i++)'),
    'invariants still inside loop'
  );

  // Z9: 5 s safety poll cleared on pagehide and teardown.
  check(
    'Z9 safety poll has a clear path (static)',
    src.indexOf('function clearSafetyPoll()') !== -1 &&
      src.indexOf("window.addEventListener('pagehide'") !== -1 &&
      src.indexOf('clearSafetyPoll()') !== -1,
    'no clearSafetyPoll/pagehide'
  );
  env.fireWin('pagehide', {});
  await env.settle(2);
  check(
    'Z9 pagehide clears polling timers',
    env.pendingIntervals() === 0,
    'pendingIntervals=' + env.pendingIntervals()
  );

  // Z10: 2 s watchdog gated on visibility + playing.
  check(
    'Z10 watchdog gated on visibility + playing (static)',
    src.indexOf("document.visibilityState === 'hidden'") !== -1 &&
      src.indexOf('anyPlaying') !== -1,
    'no visibility/playing gate in watchdog'
  );

  // --- M. remaster cluster proofs -----------------------------------------
  // M1 attach establishes the contract mute itself (mutation: drop the direct
  // write and rely on the later volumechange correction).
  const attachBlock = (src.match(/function ensureAttached\(controller\) \{[\s\S]*?\n  \}/) || [])[0] || '';
  const directMute = attachBlock.indexOf('controller.media.muted = true;');
  const attachedFlag = attachBlock.indexOf('controller.attached = true;');
  check(
    'M1 attach writes the contract mute before attached=true (static)',
    directMute !== -1 && attachedFlag !== -1 && directMute < attachedFlag,
    'no direct mute write before attached=true'
  );

  // M2 media.volume is tracked continuously, with the mute held and no recapture.
  const mv = env.addMedia();
  mv.volume = 0.35;
  env.fireDoc('play', mv);
  for (let i = 0; i < 40 && mv.muted !== true; i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  check('setup: volume-tracking probe attached muted', mv.muted === true);
  const mvCaps = env.stats.captureCalls;
  const mvDisc = env.stats.disconnects;
  const volumeTrace = [];
  for (const v of [0.35, 0.6, 0, 1]) {
    mv.volume = v;
    mark = env.stats.rampedValues.length;
    mv.dispatchEvent(new Event('volumechange'));
    await Promise.resolve();
    volumeTrace.push(env.stats.rampedValues[env.stats.rampedValues.length - 1]);
  }
  check(
    'M2 volume slider tracks media.volume continuously (no lag/double)',
    JSON.stringify(volumeTrace) === JSON.stringify([0.35, 0.6, 0, 1]),
    'trace=' + JSON.stringify(volumeTrace)
  );
  check(
    'M2 volume tracking keeps the mute and the same tap',
    mv.muted === true && env.stats.captureCalls === mvCaps && env.stats.disconnects === mvDisc,
    'muted=' + mv.muted + ' captures +' + (env.stats.captureCalls - mvCaps)
  );

  // M3 prod copy: internal errors never reach the popup, neutral is Active.
  const StatusShared = globalThis.SlowedReverbShared;
  const friendlyStatus = StatusShared && typeof StatusShared.friendlyStatus === 'function'
    ? StatusShared.friendlyStatus
    : () => 'MISSING';
  const statuses = [
    ['Active', friendlyStatus({ eligible: true, attachedCount: 1, error: 'Runtime unavailable.' })],
    ['Active', friendlyStatus({ eligible: true, attachedCount: 1, error: 'Worklet: addModule failed' })],
    ['Waiting for media', friendlyStatus({ eligible: true, attachedCount: 0, error: 'Could not attach audio effect.' })],
    ['Waiting for tab', friendlyStatus({ eligible: false, attachedCount: 0 })],
    ['Off', friendlyStatus({ eligible: true, bypass: true, attachedCount: 0, error: 'Worklet: x' })],
  ];
  check(
    'M3 internal errors map to friendly status copy',
    statuses.every(([want, got]) => want === got) &&
      statuses.every(([, got]) => got.indexOf(':') === -1 && got.indexOf('Error') === -1 && got.indexOf('Runtime') === -1),
    'statuses=' + JSON.stringify(statuses)
  );
  check(
    'M3 neutral settings with a live graph are Active, not an error',
    friendlyStatus({ eligible: true, attachedCount: 1, neutral: true, error: 'Worklet: x' }) === 'Active',
    'neutral status was not Active'
  );
  check(
    'M3 popup renders only friendly status copy (static)',
    popupText.indexOf('friendlyStatus') !== -1 &&
      popupText.indexOf('Could not attach') === -1 &&
      popupText.indexOf('Status unavailable') === -1 &&
      popupText.indexOf('Runtime unavailable') === -1,
    'popup still surfaces internal error text'
  );

  env.restoreTimers();

  if (failures.length > 0) {
    console.error('\nFAILED ' + failures.length + ' check(s):');
    for (const failure of failures) console.error(' - ' + failure);
    process.exitCode = 1;
    return;
  }
  console.log('\nPASS mute enforcement: attached mutes, stale and bypass do not');
}

main().catch((error) => {
  console.error('FAIL test crashed: ' + ((error && error.stack) || error));
  process.exitCode = 1;
});
