const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
function src(name) { return fs.readFileSync(path.join(ROOT, name), 'utf8'); }
async function settle(ms = 30) { await new Promise((r) => setTimeout(r, ms)); }

// ---------- a page-hook harness that COUNTS live listeners and timers ----------
// Every addEventListener/removeEventListener and setTimeout/clearTimeout is
// really wired, so "how much is still attached after STOP" is measured rather
// than asserted from the product's own bookkeeping.
function loadHook({ startHook = true, gate = null } = {}) {
  const posted = [];
  const timers = new Set();
  const listeners = []; // { target, type, fn }
  let nextTimer = 1;

  function addListener(target) {
    return (type, fn) => { listeners.push({ target, type, fn }); };
  }
  function removeListener(target) {
    return (type, fn) => {
      const index = listeners.findIndex((entry) => entry.target === target && entry.type === type && entry.fn === fn);
      if (index !== -1) listeners.splice(index, 1);
    };
  }
  const countFor = (target) => listeners.filter((entry) => entry.target === target).length;

  class FakeMediaElement {
    constructor() {
      this.tagName = 'VIDEO';
      this.muted = false;
      this.paused = false;
      this.src = '';
      this.addListener = addListener(this);
      this.removeListener = removeListener(this);
    }
    addEventListener(type, fn) { this.addListener(type, fn); }
    removeEventListener(type, fn) { this.removeListener(type, fn); }
    dispatch(type) {
      for (const entry of listeners.filter((e) => e.target === this && e.type === type).slice()) {
        try { entry.fn.call(this, { type, target: this }); } catch {}
      }
    }
    play() {
      this.dispatch('play');
      this.dispatch('playing');
      return Promise.resolve();
    }
    querySelectorAll() { return []; }
  }
  class FakeAudioNode {
    connect() { return undefined; }
    disconnect() {}
  }
  const captured = new WeakSet();
  class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.sampleRate = 48000;
      this.destination = {};
      this.audioWorklet = { addModule: async () => {} };
    }
    async resume() {}
    close() { this.state = 'closed'; return Promise.resolve(); }
    createGain() { const node = new FakeAudioNode(); node.context = this; return node; }
    createMediaElementSource(el) {
      if (captured.has(el)) throw new Error('already captured');
      captured.add(el);
      return { connect() {}, disconnect() {} };
    }
    addEventListener(type, fn) { addListener(this)(type, fn); }
    removeEventListener(type, fn) { removeListener(this)(type, fn); }
  }
  class FakeWorkletNode {
    constructor() {
      this._ope = null;
      this.port = { postMessage: () => {} };
    }
    connect() { return undefined; }
    disconnect() {}
    set onprocessorerror(value) { this._ope = value; }
    get onprocessorerror() { return this._ope; }
  }
  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }

  const media = new FakeMediaElement();
  const documentElement = {
    _attrs: {
      'data-tn-worklet-url': 'chrome-extension://test-id/audio/normalizer-worklet.js',
    },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    removeAttribute(k) { delete this._attrs[k]; },
  };
  const documentStub = {
    documentElement,
    querySelectorAll: (selector) => (String(selector).includes('audio') ? [media] : []),
    addEventListener: addListener('document'),
    removeEventListener: removeListener('document'),
  };
  const windowStub = {
    addEventListener: addListener('window'),
    removeEventListener: removeListener('window'),
    postMessage: (msg) => posted.push(msg),
    AudioContext: FakeAudioContext,
    OfflineAudioContext: FakeAudioContext,
    webkitAudioContext: undefined,
  };
  const sandbox = {
    window: windowStub,
    document: documentStub,
    location: { href: 'https://example.com/' },
    Element: FakeMediaElement,
    HTMLMediaElement: FakeMediaElement,
    AudioNode: FakeAudioNode,
    AudioContext: FakeAudioContext,
    OfflineAudioContext: FakeAudioContext,
    AudioWorkletNode: FakeWorkletNode,
    MutationObserver: FakeMutationObserver,
    DOMException: Error,
    URL,
    console,
    setTimeout: (fn, ms) => {
      const id = nextTimer++;
      timers.add(id);
      const handle = setTimeout(() => { timers.delete(id); try { fn(); } catch {} }, ms);
      if (handle.unref) handle.unref();
      return id;
    },
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: () => 0,
    clearInterval: () => {},
  };
  sandbox.globalThis = sandbox;
  if (gate) sandbox.__tabNormalizerFrameGate = gate;
  vm.createContext(sandbox);
  vm.runInContext(src('page-hook.js'), sandbox, { filename: 'page-hook.js' });

  // Control arrives ONLY through the dispatcher the worker calls with
  // `executeScript({func})`; the hook never starts itself and listens on no
  // page channel.
  const control = (action, payload) => (typeof sandbox.__tnHookV6 === 'function'
    ? sandbox.__tnHookV6(action, payload || {})
    : { ok: false, alive: false, active: false, error: 'No hook in this frame.' });
  const WORKLET_URL = 'chrome-extension://test-id/audio/normalizer-worklet.js';
  const start = () => control('start', { gainDb: 0, workletUrl: WORKLET_URL });
  const stop = () => control('stop', {});
  // Exactly what the content script does before asking the worker to inject:
  // stage the worklet URL on the document, then run the file in the frame.
  const reinject = () => {
    documentElement.setAttribute('data-tn-worklet-url', WORKLET_URL);
    vm.runInContext(src('page-hook.js'), sandbox, { filename: 'page-hook.js#reinject' });
  };
  if (startHook) start();

  return {
    sandbox,
    posted,
    media,
    timers,
    listeners,
    control,
    start,
    stop,
    reinject,
    countFor,
    FakeMediaElement,
    counts: () => ({
      windowListeners: countFor('window'),
      documentListeners: countFor('document'),
      mediaListeners: countFor(media),
      timers: timers.size,
      total: listeners.length,
    }),
  };
}

test('teardown: STOP releases every tracked listener and timer', async () => {
  const hook = loadHook();
  await settle(40);

  const attached = hook.counts();
  assert.ok(attached.mediaListeners >= 6, `the media element is watched while active (got ${attached.mediaListeners})`);
  // No window `message` listener exists any more: control is the dispatcher
  // only, so the window carries exactly the two lifecycle listeners.
  assert.equal(attached.windowListeners, 2, 'focus + pageshow while active, no page control channel');
  assert.ok(attached.documentListeners >= 1, 'lifecycle/document listeners are bound while active');

  hook.stop();
  // Let the untracked resume race (400 ms) expire: after it, a fully torn-down
  // hook leaves no timer of its own.
  await settle(500);

  const stopped = hook.counts();
  assert.equal(stopped.mediaListeners, 0, 'every per-element listener is gone');
  assert.equal(stopped.windowListeners, 0, 'no window listener survives (re-enable is a fresh injection)');
  assert.equal(stopped.documentListeners, 0, 'no document listener survives');
  assert.equal(stopped.timers, 0, 'no timer survives');
  assert.equal(stopped.total, 0, 'not one listener remains in the whole hook');

  const messagesBefore = hook.posted.length;
  hook.media.dispatch('play');
  hook.media.dispatch('playing');
  hook.media.dispatch('loadstart');
  await settle(60);
  assert.equal(hook.posted.length, messagesBefore, 'a synthetic media event produces no reaction');
  assert.equal(hook.counts().mediaListeners, 0, 'and does not re-arm the element');
  assert.equal(hook.counts().timers, 0, 'and schedules nothing');
});

test('teardown: STOP deletes the dispatcher; a fresh injection re-arms', async () => {
  const hook = loadHook();
  await settle(40);
  hook.stop();
  await settle(60);
  assert.equal(hook.counts().mediaListeners, 0, 'torn down');
  // The page-reachable control surface is gone: STOP removed the dispatcher, so
  // nothing in the document can make this hook do work again.
  assert.equal(typeof hook.sandbox.__tnHookV6, 'undefined', 'the dispatcher is deleted');
  assert.equal(typeof hook.sandbox.__tnDisposeV6, 'function', 'the inert teardown-only marker survives');
  assert.equal(hook.control('start', { gainDb: 0 }).ok, false, 'calling the removed dispatcher does nothing');
  await settle(60);
  assert.equal(hook.counts().mediaListeners, 0, 'and cannot re-arm it');

  // Re-enable: the worker injects the file again (same world), which disposes
  // the old instance and installs a fresh dispatcher the worker can start.
  hook.reinject();
  assert.equal(typeof hook.sandbox.__tnHookV6, 'function', 'a fresh injection installs a dispatcher');
  hook.start();
  await settle(80);
  assert.ok(hook.counts().windowListeners >= 1, 'lifecycle listeners are re-bound on start');
  assert.equal(hook.control('status', {}).active, true, 'the fresh instance is live and routing');
  // The element the previous instance already captured cannot be captured a
  // second time (Web Audio allows one source per element), so it keeps the
  // audible route the old instance left it on and is never muted by us.
  assert.equal(hook.media.muted, false, 'a previously captured element is left audible, not muted');
  // A newly appearing element is what the re-enabled hook takes over.
  const second = new hook.FakeMediaElement();
  assert.ok(hook.countFor(second) === 0, 'nothing watches the new element before it plays');
  await second.play();
  await settle(120);
  assert.ok(hook.countFor(second) >= 6, `the re-enabled hook watches the new element (got ${hook.countFor(second)})`);
  assert.equal(second.__tnAttached, true, 'and routes it through the fresh session');
});

test('teardown: a frame-gate refusal installs nothing at all', async () => {
  // The MAIN-world gate the background writes before the hook file.
  const fresh = loadHook({ startHook: false, gate: { host: 'www.tiktok.com', excluded: true } });
  await settle(40);
  assert.equal(fresh.counts().total, 0, 'an excluded frame gets no listener, no timer, no patch');
  assert.equal(fresh.counts().timers, 0);
  assert.equal(typeof fresh.sandbox.__tnHookV6, 'undefined', 'and nothing the worker could call');
  assert.deepEqual(fresh.posted, [], 'and reports nothing to the page');
});
