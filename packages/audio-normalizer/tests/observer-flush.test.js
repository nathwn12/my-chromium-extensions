const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const HOOK_PATH = process.env.PAGE_HOOK_PATH || path.join(ROOT, 'page-hook.js');
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Stub DOM harness for the observer flush: DIV nodes carry M descendants and
// record every querySelectorAll selector they are asked for.
function loadHook() {
  const src = fs.readFileSync(HOOK_PATH, 'utf8');
  const windowListeners = {};
  const scheduled = []; // { delay } for every setTimeout after load
  const observedRoots = [];
  let observerCallback = null;

  const stats = { starCalls: 0, avCalls: 0 };

  class FakeElement {
    constructor() {
      this._tnListeners = Object.create(null);
      this.shadowRoot = null;
      this._descCount = 200;
    }
    addEventListener(t, fn) { (this._tnListeners[t] = this._tnListeners[t] || []).push(fn); }
    removeEventListener() {}
    querySelectorAll(sel) {
      if (sel === '*') {
        stats.starCalls++;
        const out = new Array(this._descCount);
        for (let i = 0; i < this._descCount; i++) out[i] = { shadowRoot: null };
        return out;
      }
      stats.avCalls++;
      return [];
    }
  }
  class FakeMediaElement extends FakeElement {
    constructor() { super(); this.muted = false; this.src = ''; this.tagName = 'VIDEO'; }
    play() { return Promise.resolve(); }
  }
  class FakeAudioNode {
    connect() {}
    disconnect() {}
  }
  class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.sampleRate = 48000;
      this.destination = {};
      this.audioWorklet = { addModule: async () => {} };
    }
    async resume() {}
    close() { this.state = 'closed'; return Promise.resolve(); }
    createGain() { const n = new FakeAudioNode(); n.context = this; return n; }
    createMediaElementSource() { return { connect() {}, disconnect() {} }; }
    addEventListener() {}
    removeEventListener() {}
  }
  class FakeWorkletNode {
    constructor() { this.port = { postMessage() {} }; }
    connect() {}
    disconnect() {}
  }
  class FakeMutationObserver {
    constructor(cb) { observerCallback = cb; }
    observe(root) { observedRoots.push(root); }
    disconnect() {}
  }
  const docEl = {
    _attrs: {
      'data-tab-normalizer-pending': '1',
      'data-tn-worklet-url': 'chrome-extension://test-id/audio/normalizer-worklet.js',
    },
    getAttribute(k) { return Object.hasOwn(this._attrs, k) ? this._attrs[k] : null; },
    removeAttribute(k) { delete this._attrs[k]; },
  };
  const sandbox = {
    window: {
      addEventListener() {}, removeEventListener() {}, postMessage() {},
      AudioContext: FakeAudioContext, OfflineAudioContext: FakeAudioContext,
      webkitAudioContext: undefined,
    },
    document: {
      documentElement: docEl,
      querySelectorAll() { return []; },
      addEventListener() {}, removeEventListener() {},
    },
    location: { href: 'https://example.com/' },
    Element: FakeElement, HTMLMediaElement: FakeMediaElement,
    AudioNode: FakeAudioNode, AudioContext: FakeAudioContext,
    OfflineAudioContext: FakeAudioContext, AudioWorkletNode: FakeWorkletNode,
    MutationObserver: FakeMutationObserver, DOMException, URL,
    console, setTimeout: (fn, ms, ...a) => { scheduled.push({ delay: ms }); return setTimeout(fn, ms, ...a); }, clearTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'page-hook.js' });
  return {
    stats, scheduled, observedRoots, FakeElement,
    fireMutations: (mutations) => { if (observerCallback) observerCallback(mutations); },
  };
}

test('a 200-descendant subtree never triggers querySelectorAll("*")', async () => {
  const h = loadHook();
  await sleep(150);
  const before = h.stats.starCalls;
  const added = new h.FakeElement();
  const removed = new h.FakeElement();
  h.fireMutations([{ addedNodes: [added], removedNodes: [removed] }]);
  await sleep(300);
  assert.equal(h.stats.starCalls, before, 'flush must not blanket-walk descendants with querySelectorAll("*")');
  assert.ok(h.stats.avCalls >= 2, 'bounded audio/video lookups still run on added and removed nodes');
});

test('the direct shadowRoot check is kept (O(1), no descendant sweep)', async () => {
  const h = loadHook();
  await sleep(150);
  const host = new h.FakeElement();
  const root = { querySelectorAll() { return []; } };
  host.shadowRoot = root;
  h.fireMutations([{ addedNodes: [host], removedNodes: [] }]);
  await sleep(300);
  assert.ok(h.observedRoots.includes(root), 'an added host with its own open root is still observed directly');
});

test('a 500-mutation burst drains within a bounded time with none lost', async () => {
  const h = loadHook();
  const N = 500;
  const mutations = [];
  for (let i = 0; i < N; i++) {
    mutations.push({ addedNodes: [new h.FakeElement()], removedNodes: [new h.FakeElement()] });
  }
  const mark = h.scheduled.length;
  const t0 = Date.now();
  h.fireMutations(mutations);
  const BOUND_MS = 1500;
  let elapsed = 0;
  for (;;) {
    await sleep(20);
    elapsed = Date.now() - t0;
    if (h.stats.avCalls >= N * 2) break;
    assert.ok(elapsed < BOUND_MS, `burst did not drain within ${BOUND_MS} ms (saw ${h.stats.avCalls}/500*2 lookups)`);
  }
  assert.equal(h.stats.avCalls, N * 2, 'every mutation processed exactly once across flushes (none dropped)');
  const requeued = h.scheduled.slice(mark).filter((t) => t.delay === 0);
  assert.ok(requeued.length > 0, 'the remainder is carried to a follow-up tick (capped flush, no unbounded sync loop)');
});
