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
function loadHook({ pendingStart = true, gate = null } = {}) {
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
    _attrs: pendingStart
      ? {
        'data-tab-normalizer-pending': '1',
        'data-tn-worklet-url': 'chrome-extension://test-id/audio/normalizer-worklet.js',
      }
      : {},
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

  const dispatchPage = (data) => {
    for (const entry of listeners.filter((e) => e.target === 'window' && e.type === 'message')) {
      entry.fn({ source: windowStub, data });
    }
  };

  return {
    sandbox,
    posted,
    media,
    timers,
    listeners,
    dispatchPage,
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
  assert.equal(attached.windowListeners, 3, 'the control channel + focus + pageshow while active');
  assert.ok(attached.documentListeners >= 1, 'lifecycle/document listeners are bound while active');

  hook.dispatchPage({ channel: 'tab-normalizer-v5', type: 'STOP' });
  // Let the untracked resume race (400 ms) expire: after it, a fully torn-down
  // hook leaves no timer of its own.
  await settle(500);

  const stopped = hook.counts();
  assert.equal(stopped.mediaListeners, 0, 'every per-element listener is gone');
  assert.equal(stopped.windowListeners, 1, 'only the START control channel survives (re-enable needs it)');
  assert.equal(stopped.documentListeners, 0, 'no document listener survives');
  assert.equal(stopped.timers, 0, 'no timer survives');
  assert.equal(stopped.total, 1, 'exactly one listener remains in the whole hook');

  const messagesBefore = hook.posted.length;
  hook.media.dispatch('play');
  hook.media.dispatch('playing');
  hook.media.dispatch('loadstart');
  await settle(60);
  assert.equal(hook.posted.length, messagesBefore, 'a synthetic media event produces no reaction');
  assert.equal(hook.counts().mediaListeners, 0, 'and does not re-arm the element');
  assert.equal(hook.counts().timers, 0, 'and schedules nothing');
});

test('teardown: the surviving control channel still accepts a later START', async () => {
  const hook = loadHook();
  await settle(40);
  hook.dispatchPage({ channel: 'tab-normalizer-v5', type: 'STOP' });
  await settle(60);
  assert.equal(hook.counts().mediaListeners, 0, 'torn down');

  // Re-enable: the hook must come back without a reload.
  hook.dispatchPage({
    channel: 'tab-normalizer-v5',
    type: 'START',
    gainDb: 0,
    workletUrl: 'chrome-extension://test-id/audio/normalizer-worklet.js',
  });
  await settle(80);
  assert.ok(hook.counts().mediaListeners >= 6, 'the element is watched again after START');
  assert.ok(hook.counts().windowListeners >= 1, 'lifecycle listeners are re-bound on start');
});

test('teardown: a frame-gate refusal installs nothing at all', async () => {
  // The MAIN-world gate the background writes before the hook file.
  const fresh = loadHook({ pendingStart: true, gate: { host: 'www.tiktok.com', excluded: true } });
  await settle(40);
  assert.equal(fresh.counts().total, 0, 'an excluded frame gets no listener, no timer, no patch');
  assert.equal(fresh.counts().timers, 0);
  assert.deepEqual(fresh.posted, [], 'and reports nothing to the page');
});
