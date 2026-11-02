'use strict';

/*
 * qa/stub-env.js - shared pure-Node stub environment for content-script proofs.
 *
 * SAFETY (repo AGENTS.md ## Verification safety): plain Node only. No browser is
 * launched, no AudioContext with a device is created, no audio plays. The REAL
 * content-script.js is evaluated with browser globals stubbed (HTMLMediaElement,
 * document/window listeners, chrome.runtime, MutationObserver, AudioContext,
 * AudioWorkletNode) and driven through its real seams (chrome runtime messages,
 * DOM listeners, media events). Timers are fake/controllable; intervals are inert
 * so the process always exits.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createContentEnv(opts = {}) {
  const {
    runtimeState = { eligible: true, bypass: false, settings: { slow: 0.8, reverbIntensity: 0.5 } },
    capture = 'ok',
  } = opts;

  const stats = { captureCalls: 0, executedScripts: 0, ramped: 0, contexts: [] };

  // ---------- controllable timers (fake setTimeout, inert setInterval) ----------
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
  function runTimers(max = 10000) {
    let n = 0;
    while (timers.size > 0 && n < max) {
      const first = timers.entries().next().value;
      timers.delete(first[0]);
      n++;
      first[1].cb();
    }
    return n;
  }
  function pendingTimerCount() {
    return timers.size;
  }

  // ---------- stub media element ----------
  const mediaElements = [];
  class StubMedia extends EventTarget {
    static HAVE_NOTHING = 0;
    static HAVE_METADATA = 1;
    static HAVE_CURRENT_DATA = 2;
    static HAVE_FUTURE_DATA = 3;
    static HAVE_ENOUGH_DATA = 4;

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
      this.captureMode = capture;
      this.tracks = [];
    }
    captureStream() {
      stats.captureCalls++;
      if (this.captureMode === 'fail') throw new Error('capture unavailable (stub)');
      const track = {
        kind: 'audio',
        stopped: false,
        stop() {
          this.stopped = true;
        },
      };
      this.tracks.push(track);
      if (this.captureMode === 'noaudio') {
        return { getAudioTracks: () => [], getTracks: () => [track], addEventListener() {} };
      }
      return { getAudioTracks: () => [track], getTracks: () => [track], addEventListener() {} };
    }
  }

  // ---------- stub audio graph ----------
  function makeGain() {
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
  class StubAudioContext {
    constructor() {
      this.state = 'running';
      this.currentTime = 0;
      this.destination = {};
      this.audioWorklet = { addModule: async () => {} };
      stats.contexts.push(this);
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createGain() {
      return makeGain();
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

  // ---------- stub chrome ----------
  const runtimeHandlers = [];
  const chromeStub = {
    runtime: {
      onMessage: {
        addListener(fn) {
          runtimeHandlers.push(fn);
        },
      },
      sendMessage: async (msg) => {
        if (msg && msg.type === 'GET_TAB_RUNTIME_STATE') return JSON.parse(JSON.stringify(runtimeState));
        if (msg && msg.type === 'ENSURE_TAB_HOOKS') return { ok: true };
        return {};
      },
      getURL: (p) => String(p),
    },
  };

  // ---------- stub document / window ----------
  const docListeners = {};
  const winListeners = {};
  const documentStub = {
    documentElement: {},
    querySelectorAll: () => mediaElements.filter((m) => m.isConnected),
    addEventListener: (type, fn) => {
      (docListeners[type] = docListeners[type] || []).push(fn);
    },
  };
  const windowStub = {
    addEventListener: (type, fn) => {
      (winListeners[type] = winListeners[type] || []).push(fn);
    },
  };
  class StubMutationObserver {
    constructor(cb) {
      this.cb = cb;
    }
    observe() {}
    disconnect() {}
  }

  globalThis.HTMLMediaElement = StubMedia;
  globalThis.window = windowStub;
  globalThis.document = documentStub;
  globalThis.chrome = chromeStub;
  globalThis.MutationObserver = StubMutationObserver;
  globalThis.AudioContext = StubAudioContext;
  globalThis.AudioWorkletNode = StubWorkletNode;

  // ---------- load the REAL sources, unmodified ----------
  const root = path.join(__dirname, '..');
  const sharedPath = path.join(root, 'shared.js');
  const csPath = path.join(root, 'content-script.js');
  vm.runInThisContext(fs.readFileSync(sharedPath, 'utf8'), { filename: sharedPath });
  vm.runInThisContext(fs.readFileSync(csPath, 'utf8'), { filename: csPath });

  // ---------- drivers ----------
  function sendRuntime(msg) {
    const responses = [];
    for (const fn of runtimeHandlers) fn(msg, {}, (r) => responses.push(r));
    return responses;
  }
  function fireDoc(type, target) {
    for (const fn of docListeners[type] || []) fn({ target });
  }
  function addMedia(init = {}) {
    const m = new StubMedia();
    Object.assign(m, init);
    mediaElements.push(m);
    return m;
  }
  async function settle(rounds = 8) {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve();
      await new Promise((r) => realSetTimeout(r, 0));
    }
  }
  function restoreTimers() {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }

  return {
    stats,
    mediaElements,
    timers,
    runTimers,
    pendingTimerCount,
    sendRuntime,
    fireDoc,
    addMedia,
    settle,
    restoreTimers,
    StubMedia,
  };
}

module.exports = { createContentEnv };
