'use strict';

/* global require, process, __dirname */

/*
 * test/context-lifecycle.test.js - AudioContext lifecycle proof.
 *
 * A browser-initiated suspend (device switch, OS interruption, sleep/wake)
 * must recover without waiting for the 2 s watchdog, a closed context must be
 * recreated with every node/stream released, and an autoplay-policy suspended
 * context must attach as soon as it runs without burning the attach-retry
 * ladder.
 *
 * The stub deliberately models the spec: `state` flips on a LATER task and
 * `onstatechange` fires, unlike the older synchronous stubs. Plain Node only.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createEnv(startState) {
  const stats = {
    captures: 0,
    contexts: [],
    disconnects: 0,
    resumes: 0,
    addModules: 0,
    startedTracks: [],
    stoppedTracks: 0,
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
  const clock = realNow();
  Date.now = () => clock;

  let runtimeGate = null;
  let resumeGate = null;
  const mediaElements = [];
  class StubMedia extends EventTarget {
    constructor() {
      super();
      this.playbackRate = 1;
      this.preservesPitch = true;
      this._muted = false;
      this.mutedWrites = [];
      this.volume = 1;
      this.paused = false;
      this.ended = false;
      this.readyState = 4;
      this.currentSrc = 'https://music.youtube.com/stream/v1';
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
          stats.stoppedTracks += 1;
        },
      };
      stats.startedTracks.push(track);
      return { getAudioTracks: () => [track], getTracks: () => [track], addEventListener() {} };
    }
  }
  StubMedia.HAVE_CURRENT_DATA = 2;

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
      stats.contexts.push(this);
      this.state = startState || 'running';
      this.currentTime = 0;
      this.destination = {};
      this.onstatechange = null;
      this.closed = false;
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
      return { gain, connect() {}, disconnect() {} };
    }
    async resume() {
      stats.resumes += 1;
      if (resumeGate) await resumeGate;
      else await Promise.resolve();
      this.state = 'running';
      if (typeof this.onstatechange === 'function') this.onstatechange();
    }
    async suspend() {
      await Promise.resolve();
      this.state = 'suspended';
      if (typeof this.onstatechange === 'function') this.onstatechange();
    }
    async close() {
      await Promise.resolve();
      this.state = 'closed';
      this.closed = true;
      if (typeof this.onstatechange === 'function') this.onstatechange();
    }
    setState(next) {
      // Spec-shaped: a browser-initiated transition lands on a later task and
      // fires statechange. Nothing is resumed for us.
      queueMicrotask(() => {
        this.state = next;
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
          if (runtimeGate) await runtimeGate;
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
    constructor() {
      this.callback = null;
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
  async function settle(rounds = 10) {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve();
      await new Promise((resolve) => realSetTimeout(resolve, 0));
    }
  }
  function resolveContext() {
    return stats.contexts[stats.contexts.length - 1] || null;
  }
  function restoreTimers() {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    globalThis.location = realLocation;
    Date.now = realNow;
    delete globalThis.__slowedReverbAudioContent;
    delete globalThis.SlowedReverbShared;
  }

  return {
    stats,
    holdRuntime() {
      let release = null;
      runtimeGate = new Promise((resolve) => { release = resolve; });
      return () => { runtimeGate = null; release(); };
    },
    holdResume() {
      let release = null;
      resumeGate = new Promise((resolve) => { release = resolve; });
      return () => { resumeGate = null; release(); };
    },
    sendRuntime,
    queryLive,
    fireDoc,
    addMedia,
    settle,
    resolveContext,
    restoreTimers,
    pendingTimers: () => timers.size,
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

async function attach(env, media) {
  env.fireDoc('play', media);
  for (let i = 0; i < 60; i++) {
    await env.settle(2);
    if (media.muted === true && Math.abs(media.playbackRate - 0.8) < 1e-9) return true;
  }
  return false;
}

async function main() {
  // L1: a browser-initiated suspend recovers without the 2 s watchdog.
  {
    const env = createEnv('running');
    await env.settle(6);
    const media = env.addMedia();
    check('L1 setup: attached on a running context', await attach(env, media), 'muted=' + media.muted);
    const ctx = env.resolveContext();
    const resumesBefore = env.stats.resumes;
    ctx.setState('suspended');
    await env.settle(10);
    // No interval is run here on purpose: the statechange seam must recover.
    const live = env.queryLive();
    check(
      'L1 external suspend resumes without waiting for the watchdog',
      ctx.state === 'running' && media.muted === true && live.attachedCount === 1 && env.stats.resumes > resumesBefore,
      'state=' + ctx.state + ' muted=' + media.muted + ' attached=' + live.attachedCount + ' resumes +' + (env.stats.resumes - resumesBefore)
    );
    env.restoreTimers();
  }

  // L2: autoplay-policy suspended context attaches as soon as it runs, with no
  // multi-second silent window and without burning the retry ladder.
  {
    const env = createEnv('suspended');
    const releaseRuntime = env.holdRuntime();
    const releaseResume = env.holdResume();
    await env.settle(2);
    const media = env.addMedia();
    media.mutedWrites.length = 0;
    env.fireDoc('play', media);
    await env.settle(1);
    releaseRuntime();
    await env.settle(2);
    const liveBefore = env.queryLive();
    check(
      'L2 attachment waits for the context to actually run (no suspended attach)',
      liveBefore.attachedCount === 0 && media.muted === false,
      'attached=' + liveBefore.attachedCount + ' muted=' + media.muted + ' state=' + (env.resolveContext() || {}).state
    );
    check(
      'L2 a resuming context burns no attach-retry timer',
      env.pendingTimers() === 0,
      'pendingTimers=' + env.pendingTimers()
    );
    releaseResume();
    await env.settle(12);
    const live = env.queryLive();
    const ctx = env.resolveContext();
    check(
      'L2 attaches as soon as the context is running',
      ctx.state === 'running' && live.attachedCount === 1 && media.muted === true,
      'state=' + (ctx && ctx.state) + ' attached=' + live.attachedCount + ' muted=' + media.muted
    );
    check(
      'L2 the first mute lands on attach, not before (dry until the graph is live)',
      media.mutedWrites.length >= 1 && media.mutedWrites[0] === true,
      'writes=' + JSON.stringify(media.mutedWrites)
    );
    env.restoreTimers();
  }

  // L3: a closed context while attached is recreated with everything released.
  {
    const env = createEnv('running');
    await env.settle(6);
    const media = env.addMedia();
    check('L3 setup: attached', await attach(env, media), 'muted=' + media.muted);
    const first = env.resolveContext();
    const stoppedBefore = env.stats.stoppedTracks;
    const discBefore = env.stats.disconnects;
    first.setState('closed');
    for (let i = 0; i < 40; i++) {
      await env.settle(2);
      const live = env.queryLive();
      if (live.attachedCount === 1 && media.muted === true) break;
    }
    const live = env.queryLive();
    const current = env.resolveContext();
    check(
      'L3 closed context is recreated and the element re-attached (no permanent silence)',
      current && current !== first && env.stats.contexts.length === 2 && live.attachedCount === 1 && media.muted === true,
      'contexts=' + env.stats.contexts.length + ' attached=' + live.attachedCount + ' muted=' + media.muted
    );
    check(
      'L3 the dead context releases every stream and node',
      env.stats.stoppedTracks > stoppedBefore && env.stats.disconnects > discBefore && first.state === 'closed',
      'stopped +' + (env.stats.stoppedTracks - stoppedBefore) + ' disconnects +' + (env.stats.disconnects - discBefore)
    );
    env.restoreTimers();
  }

  // L4: a closed context with nothing playing releases the mute (dry audio).
  {
    const env = createEnv('running');
    await env.settle(6);
    const media = env.addMedia();
    check('L4 setup: attached', await attach(env, media), 'muted=' + media.muted);
    media.paused = true;
    env.fireDoc('pause', media);
    await env.settle(6);
    const ctx = env.resolveContext();
    ctx.setState('closed');
    await env.settle(10);
    const live = env.queryLive();
    check(
      'L4 closed context falls back to unmuted dry audio when nothing plays',
      media.muted === false && live.attachedCount === 0,
      'muted=' + media.muted + ' attached=' + live.attachedCount
    );
    check(
      'L4 no element is left muted onto a dead graph',
      !(media.muted === true && live.contextState === 'closed'),
      'muted=' + media.muted + ' contextState=' + live.contextState
    );
    env.restoreTimers();
  }

  if (failures.length > 0) {
    console.error('\nFAILED ' + failures.length + ' check(s):');
    for (const failure of failures) console.error(' - ' + failure);
    process.exitCode = 1;
    return;
  }
  console.log('\nPASS context lifecycle: suspend, resume, recreate, release');
}

main().catch((error) => {
  console.error('FAIL test crashed: ' + ((error && error.stack) || error));
  process.exitCode = 1;
});
