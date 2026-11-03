const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (n) => fs.readFileSync(path.join(ROOT, n), 'utf8');
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function fnSrc(src, name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) return '';
  const open = src.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  return src.slice(i);
}

// Churn harness: the one-shot capture registry is shared across contexts in
// the sandbox, mirroring the Web Audio rule that a second
// createMediaElementSource on one element throws InvalidStateError.
function loadHook() {
  const src = read('page-hook.js');
  const posted = [];
  const windowListeners = {};
  const docListeners = {};
  const contexts = [];
  const createdSources = [];
  const captured = new Set();
  let observerCallback = null;
  let createCalls = 0;
  let closeCalls = 0;
  let suspendCalls = 0;
  let eid = 1;

  class FakeElement {
    constructor() { this._tnListeners = Object.create(null); }
    addEventListener(t, fn) { (this._tnListeners[t] = this._tnListeners[t] || []).push(fn); }
    removeEventListener() {}
    dispatchEvent(ev) {
      const type = typeof ev === 'string' ? ev : ev && ev.type;
      for (const fn of ((this._tnListeners[type] || []).slice())) {
        try { fn.call(this, { type, target: this }); } catch {}
      }
      return true;
    }
    querySelectorAll() { return []; }
  }
  class FakeMediaElement extends FakeElement {
    constructor() { super(); this.muted = false; this.src = ''; this.tagName = 'VIDEO'; }
    play() {
      this.dispatchEvent({ type: 'play' });
      this.dispatchEvent({ type: 'playing' });
      return Promise.resolve();
    }
  }
  class FakeAudioNode {
    constructor() { this._eid = eid++; }
    connect() { return undefined; }
    disconnect() { return undefined; }
  }
  class FakeSource {
    constructor() {
      this._eid = eid++;
      this.connectCount = 0;
      this.disconnectCount = 0;
    }
    connect() { this.connectCount++; return undefined; }
    disconnect() { this.disconnectCount++; return undefined; }
  }
  class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.sampleRate = 48000;
      this.destination = { _eid: 99999 };
      this.audioWorklet = { addModule: async () => {} };
      contexts.push(this);
    }
    async resume() { if (this.state !== 'closed') this.state = 'running'; }
    async suspend() { suspendCalls++; if (this.state === 'running') this.state = 'suspended'; }
    close() { closeCalls++; this.state = 'closed'; return Promise.resolve(); }
    createGain() { const n = new FakeAudioNode(); n.context = this; return n; }
    createMediaElementSource(el) {
      createCalls++;
      if (captured.has(el)) throw new DOMException('already captured', 'InvalidStateError');
      captured.add(el);
      const s = new FakeSource();
      createdSources.push(s);
      return s;
    }
    addEventListener() {}
    removeEventListener() {}
  }
  class FakeWorkletNode {
    constructor() {
      this._eid = eid++;
      this._ope = null;
      this.port = { postMessage() {} };
    }
    connect() { return undefined; }
    disconnect() { return undefined; }
    set onprocessorerror(v) { this._ope = v; }
    get onprocessorerror() { return this._ope; }
  }
  class FakeMutationObserver { constructor(cb) { observerCallback = cb; } observe() {} disconnect() {} }
  const docEl = {
    _attrs: {
      'data-tab-normalizer-pending': '1',
      'data-tn-worklet-url': 'chrome-extension://test-id/audio/normalizer-worklet.js',
    },
    getAttribute(k) { return Object.hasOwn(this._attrs, k) ? this._attrs[k] : null; },
    removeAttribute(k) { delete this._attrs[k]; },
  };
  const documentStub = {
    documentElement: docEl,
    querySelectorAll() { return []; },
    addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
    removeEventListener() {},
  };
  const windowStub = {
    addEventListener(t, fn) { (windowListeners[t] = windowListeners[t] || []).push(fn); },
    removeEventListener() {},
    postMessage(m) { posted.push(m); },
    AudioContext: FakeAudioContext,
    OfflineAudioContext: FakeAudioContext,
    webkitAudioContext: undefined,
  };
  const sandbox = {
    window: windowStub, document: documentStub,
    location: { href: 'https://example.com/' },
    Element: FakeElement, HTMLMediaElement: FakeMediaElement,
    AudioNode: FakeAudioNode, AudioContext: FakeAudioContext,
    OfflineAudioContext: FakeAudioContext, AudioWorkletNode: FakeWorkletNode,
    MutationObserver: FakeMutationObserver, DOMException, URL,
    console, setTimeout, clearTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'page-hook.js' });
  return {
    sandbox, posted, contexts, createdSources, FakeMediaElement,
    counts: () => ({ createCalls, closeCalls, suspendCalls }),
    dispatchPage: (d) => {
      for (const fn of (windowListeners.message || [])) fn({ source: windowStub, data: d });
    },
    fireMutations: (mutations) => { if (observerCallback) observerCallback(mutations); },
    // The page (or a previous hook instance) owns the element: the one-shot
    // capture is consumed. pageCapture also labels like the patched page
    // path; consumeCapture leaves it unlabelled (previous-instance case).
    pageCapture: (el) => { el.__tnWebAudio = true; captured.add(el); },
    consumeCapture: (el) => { captured.add(el); },
  };
}

test('remove + re-insert reuses the one source with zero re-capture', async () => {
  const h = loadHook();
  await sleep(250);
  const A = new h.FakeMediaElement();
  A.muted = false;
  await A.play();
  await sleep(300);
  assert.equal(A.__tnAttached, true, 'element attached');
  assert.equal(h.counts().createCalls, 1, 'exactly one capture');
  const source = A.__tnSource;
  assert.ok(source, 'source handle kept on the element');
  const connectsAfterFirst = source.connectCount;

  h.fireMutations([{ addedNodes: [], removedNodes: [A] }]);
  await sleep(300);
  assert.equal(A.__tnAttached, false, 'removal leaves the present set');
  assert.equal(h.counts().createCalls, 1, 'removal captures nothing');
  assert.equal(source.disconnectCount, 0, 'removal never disconnects the source');

  h.fireMutations([{ addedNodes: [A], removedNodes: [] }]);
  await sleep(300);
  assert.equal(h.counts().createCalls, 1, 're-insert never re-captures');
  assert.equal(A.__tnAttached, true, 're-inserted element attached');
  assert.equal(A.__tnSource, source, 'the SAME node is reused');
  assert.ok(source.connectCount > connectsAfterFirst, 'the same node is reconnected');
  assert.equal(source.disconnectCount, 0, 'still never disconnected');
});

test('detach never disconnects and never drops the cache entry', async () => {
  const hookSrc = read('page-hook.js');
  const detachFn = fnSrc(hookSrc, 'detachMediaElement');
  assert.ok(detachFn.length > 0, 'detach helper exists');
  assert.ok(!detachFn.includes('disconnect'), 'detach never disconnects the source');
  assert.ok(!detachFn.includes('elementSources.delete') && !detachFn.includes('elementSources.clear'),
    'detach never deletes the cache entry');
  assert.ok(!detachFn.includes('sources.delete'), 'detach never drops the strong source set');

  const h = loadHook();
  await sleep(250);
  const B = new h.FakeMediaElement();
  await B.play();
  await sleep(300);
  assert.equal(B.__tnAttached, true, 'element attached');
  const source = B.__tnSource;
  assert.ok(source, 'cache entry exists');
  h.fireMutations([{ addedNodes: [], removedNodes: [B] }]);
  await sleep(300);
  assert.equal(B.__tnAttached, false, 'removal leaves the present set');
  assert.ok(B.__tnSource, 'cache entry survives removal');
  assert.equal(source.disconnectCount, 0, 'source stays wired while removed');
  h.fireMutations([{ addedNodes: [B], removedNodes: [] }]);
  await sleep(300);
  assert.equal(h.counts().createCalls, 1, 'surviving entry means zero re-capture');
  assert.equal(B.__tnSource, source, 'same node reused after removal');
});

test('a captured context is suspended, never closed, when idle', async () => {
  const h = loadHook();
  await sleep(250);
  const A = new h.FakeMediaElement();
  await A.play();
  await sleep(300);
  assert.equal(A.__tnAttached, true, 'element captured');
  assert.equal(h.counts().createCalls, 1, 'context captured something');

  // Removal while active must not close or suspend the running context.
  h.fireMutations([{ addedNodes: [], removedNodes: [A] }]);
  await sleep(300);
  assert.equal(h.contexts[0].state, 'running', 'active context stays running when idle');
  assert.equal(h.counts().closeCalls, 0, 'no close while active');

  // Stopping with no present elements suspends the captured context instead
  // of closing it.
  h.dispatchPage({ channel: 'tab-normalizer-v5', type: 'STOP' });
  await sleep(200);
  assert.equal(h.counts().closeCalls, 0, 'a captured context is never closed');
  assert.ok(h.counts().suspendCalls >= 1, 'the idle captured context is suspended');
  assert.equal(h.contexts[0].state, 'suspended', 'suspended, not closed');
});

test('a page-captured element is skipped and left unmuted by us', async () => {
  const h = loadHook();
  await sleep(250);

  // Labelled page capture: our gate skips before any capture attempt.
  const B = new h.FakeMediaElement();
  B.muted = false;
  h.pageCapture(B);
  await B.play();
  await sleep(300);
  assert.equal(h.counts().createCalls, 0, 'no capture attempted for a page-owned element');
  assert.equal(B.__tnAttached !== true, true, 'never marked attached');
  assert.equal(B.muted, false, 'not muted by us');

  // Unlabelled one-shot consumption (previous hook instance): our attempt
  // throws InvalidStateError with no cache — skipped, guard restored.
  const C = new h.FakeMediaElement();
  C.muted = false;
  h.consumeCapture(C);
  await C.play();
  await sleep(300);
  assert.equal(C.__tnAttached !== true, true, 'throw with no cache never attaches');
  assert.equal(C.muted, false, 'not left muted by us');

  // And the latch never blocks a cached source: label a captured element
  // as page-wired afterwards, churn it, and it still reuses its route.
  const D = new h.FakeMediaElement();
  await D.play();
  await sleep(300);
  assert.equal(D.__tnAttached, true, 'element captured');
  const before = h.counts().createCalls;
  const source = D.__tnSource;
  D.__tnWebAudio = true; // a later failed page-side capture labels it
  h.fireMutations([{ addedNodes: [], removedNodes: [D] }]);
  await sleep(300);
  h.fireMutations([{ addedNodes: [D], removedNodes: [] }]);
  await sleep(300);
  assert.equal(h.counts().createCalls, before, 'cached source reused despite the latch');
  assert.equal(D.__tnAttached, true, 're-inserted despite the latch');
  assert.equal(D.__tnSource, source, 'same node reused');
});
