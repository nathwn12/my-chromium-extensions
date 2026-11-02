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
  const stats = { captureCalls: 0, contexts: 0, ramped: 0, rampedValues: [], disconnects: 0 };

  // Controllable timers: fake setTimeout, inert setInterval (the 2s watchdog is
  // exercised by the real-browser harness, not here).
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
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
  globalThis.setInterval = () => 0;
  globalThis.clearInterval = () => {};

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
      this.ended = false;
      this.readyState = 4;
      this.currentSrc = 'https://www.youtube.com/watch?v=stub';
      this.srcObject = null;
      this.isConnected = true;
      this.mutedWrites = [];
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
      return {
        gain: {
          value: 0,
          setTargetAtTime(value) {
            stats.ramped++;
            stats.rampedValues.push(value);
          },
        },
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
  globalThis.document = {
    documentElement: {},
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
    observe() {}
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
    Date.now = realNow;
  }

  return {
    stats,
    sendRuntime,
    queryLive,
    fireDoc,
    addMedia,
    settle,
    runTimers,
    drainTimers,
    pendingTimers: () => timers.size,
    advance,
    now: () => clock,
    restoreTimers,
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

  // --- sourceStale: the deliberate unmute window must survive volumechange ---
  media.dispatchEvent(new Event('emptied'));
  check('setup: emptied marks the source stale and unmutes the element', media.muted === false);
  media.dispatchEvent(new Event('volumechange'));
  check(
    'sourceStale + volumechange leaves the element unmuted',
    media.muted === false,
    'expected false (stale source has no audio path), got ' + media.muted
  );

  for (let i = 0; i < 20 && media.muted !== true; i++) await env.settle(2);
  check('rebuild re-mutes once a fresh source is connected', media.muted === true);

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
  // Nine unmute attempts inside one second must not kill enforcement for the
  // rest of the track: the budget pauses, then the next unmute after the
  // cool-down is corrected again.
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
    'finite burst: enforcement pauses once the budget is spent',
    burstCorrections - burstStart === 8,
    'writes continued while paused: ' + (burstCorrections - burstStart)
  );

  env.advance(999);
  burst.muted = false;
  burst.dispatchEvent(new Event('volumechange'));
  await Promise.resolve();
  check(
    'cool-down: still paused 1 ms before the deadline',
    burstCorrections - burstStart === 8,
    'expected the pause to hold, got ' + (burstCorrections - burstStart) + ' corrections'
  );

  env.advance(2);
  burst.muted = false;
  burst.dispatchEvent(new Event('volumechange'));
  await Promise.resolve();
  check(
    'cool-down expires: the next unmute is corrected again',
    burstCorrections - burstStart === 9,
    'expected 9 after the 1000 ms cool-down, got ' + (burstCorrections - burstStart)
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

  // A. sourceStale volumechange keeps the graph silent (no doubled track).
  const staleM = env.addMedia();
  env.fireDoc('play', staleM);
  for (let i = 0; i < 40 && staleM.muted !== true; i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  check('setup: stale-track element attached and muted', staleM.muted === true);
  staleM.dispatchEvent(new Event('emptied'));
  check('setup: emptied unmutes into the stale window', staleM.muted === false);
  let mark = env.stats.rampedValues.length;
  staleM.dispatchEvent(new Event('volumechange'));
  check(
    'sourceStale + volumechange keeps masterGain at 0 (no doubled track)',
    env.stats.rampedValues.length > mark && env.stats.rampedValues[env.stats.rampedValues.length - 1] === 0,
    'last ramped gain=' + env.stats.rampedValues[env.stats.rampedValues.length - 1]
  );
  check(
    'sourceStale + volumechange leaves the element unmuted (stale window holds)',
    staleM.muted === false,
    'expected false, got ' + staleM.muted
  );
  for (let i = 0; i < 40 && staleM.muted !== true; i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  check('setup: rebuild re-mutes the stale-track element', staleM.muted === true);

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
  check('setup: emptied marks the contract element stale and unmutes', contractM.muted === false);
  mark = env.stats.rampedValues.length;
  contractM.dispatchEvent(new Event('volumechange'));
  check(
    'contract element stale + volumechange ramps masterGain to 0',
    env.stats.rampedValues.length > mark && env.stats.rampedValues[env.stats.rampedValues.length - 1] === 0,
    'last ramped gain=' + env.stats.rampedValues[env.stats.rampedValues.length - 1]
  );
  for (let i = 0; i < 40 && contractM.muted !== true; i++) {
    await env.settle(2);
    env.runTimers(50);
  }
  check('setup: contract element rebuilt and re-muted', contractM.muted === true);
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
  // loadedmetadata enters the stale window WITHOUT resetting the dampener
  // (unlike emptied), so a spent budget is still spent when the rebuild runs.
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
    'popup is YouTube Music only',
    popupText.indexOf('Only works on YouTube Music.') !== -1 &&
      popupText.replace(/music\.youtube\.com/g, '').indexOf('youtube.com') === -1,
    'popup still names YouTube'
  );

  // H. static guards for the remaining fixes (each fails on the pre-fix bytes).
  const volumeBlock = (src.match(/controller\.volumeHandler = \(\) => \{[\s\S]*?enforceElementMute\(controller\);\s*\};/) || [])[0] || '';
  check(
    'volumeHandler ramps on sourceStale only, never on media.muted (static)',
    volumeBlock.indexOf('controller.sourceStale') !== -1 && volumeBlock.indexOf('controller.media.muted') === -1,
    'volumeHandler still maps media.muted to masterGain 0'
  );
  check(
    'rebuild resets the mute budget (static)',
    /resetMuteDampener\(controller\);\s+enforceElementMute\(controller\);/.test(src),
    'no resetMuteDampener before the rebuild re-mute'
  );
  check(
    'failed rebuild disconnects the stale tap (static)',
    /disconnectNode\(controller\.source\);[\s\S]{0,800}if \(capturedStream\)/.test(src),
    'no disconnectNode(controller.source) in the rebuild catch path'
  );
  check(
    'attachAttempts resets at the cap (static)',
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
  // --- I1 mute-budget doubling: refusal must silence the graph ---
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
  check(
    'mute-budget refusal ramps masterGain to 0 (no doubled track)',
    env.stats.rampedValues.length > 0 && env.stats.rampedValues[env.stats.rampedValues.length - 1] === 0,
    'last ramped gain=' + env.stats.rampedValues[env.stats.rampedValues.length - 1]
  );
  env.advance(1001);
  dbl.muted = false;
  dbl.dispatchEvent(new Event('volumechange'));
  await Promise.resolve();
  check(
    'mute-budget recovery ramps masterGain back to media.volume',
    dbl.muted === true && env.stats.rampedValues[env.stats.rampedValues.length - 1] === dbl.volume,
    'muted=' + dbl.muted + ' last=' + env.stats.rampedValues[env.stats.rampedValues.length - 1]
  );

  // --- I2 storage outage: {ok:false} must not become state ---
  const outageM = dbl;
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
  for (const m of [media, rateMedia, burst, staleM, contractM, budgetM, failM, capM, dbl]) {
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
  check(
    'mute-budget refusal silences the graph (static)',
    /if \(!claimMuteCorrection\(controller\)\) \{\s+if \(controller\.masterGain\)/.test(src),
    'no masterGain ramp on refusal'
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
