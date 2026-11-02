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
  const stats = { captureCalls: 0, contexts: 0, ramped: 0 };

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
      return { connect() {}, disconnect() {} };
    }
    createGain() {
      return {
        gain: {
          value: 0,
          setTargetAtTime() {
            stats.ramped++;
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
