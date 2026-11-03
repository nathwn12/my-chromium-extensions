const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (n) => fs.readFileSync(path.join(ROOT, n), 'utf8');
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function loadHook(opts = {}) {
  const src = read('page-hook.js');
  const posted = [];
  const windowListeners = {};
  const docListeners = {};
  let createCalls = 0;
  let resumeCalls = 0;
  const edges = new Set();
  const edgeKey = (a, b) => a._eid + '->' + b._eid;
  let eid = 1;
  const contexts = [];
  let observerCallback = null;
  const initState = opts.contextState || 'running';
  const resumeStuck = !!opts.resumeStuck;

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
    connect(dest) {
      if (opts.throwOnWorkletConnect && dest && dest._isWorklet) throw new Error('connect boom');
      if (dest) edges.add(edgeKey(this, dest));
      return undefined;
    }
    disconnect(dest) {
      if (!dest) {
        for (const k of [...edges]) if (k.startsWith(this._eid + '->')) edges.delete(k);
      } else {
        edges.delete(edgeKey(this, dest));
      }
    }
  }
  class FakeAudioContext {
    constructor() {
      this.state = initState;
      this.sampleRate = 48000;
      this.destination = { _eid: 99999 };
      this.audioWorklet = { addModule: async () => {} };
      contexts.push(this);
    }
    async resume() {
      resumeCalls++;
      if (!resumeStuck) this.state = 'running';
    }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createGain() { const n = new FakeAudioNode(); n.context = this; return n; }
    createMediaElementSource() {
      createCalls++;
      return { connect() {}, disconnect() {}, _eid: eid++ };
    }
    addEventListener() {}
    removeEventListener() {}
  }
  const workletInstances = [];
  class FakeWorkletNode {
    constructor() {
      this._isWorklet = true;
      this._eid = eid++;
      this._ope = null;
      this.port = { postMessage() {} };
      this.connectedTo = [];
      workletInstances.push(this);
    }
    connect(dest) {
      if (opts.throwOnWorkletConnect) throw new Error('connect boom');
      if (dest) edges.add(edgeKey(this, dest));
    }
    disconnect(dest) {
      if (!dest) {
        for (const k of [...edges]) if (k.startsWith(this._eid + '->')) edges.delete(k);
      } else edges.delete(edgeKey(this, dest));
    }
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
    setAttribute(k, v) { this._attrs[k] = String(v); },
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
  const dispatchPage = (d) => {
    for (const fn of (windowListeners.message || [])) fn({ source: windowStub, data: d });
  };
  const fireDoc = (t) => { for (const fn of (docListeners[t] || []).slice()) { try { fn(); } catch {} } };
  const fireMutations = (mutations) => {
    if (observerCallback) observerCallback(mutations);
  };
  return {
    sandbox, posted, dispatchPage, fireDoc, fireMutations, workletInstances, edges, contexts,
    counts: () => ({ createCalls, resumeCalls }),
    FakeMediaElement, windowStub,
  };
}

function isRoutedThroughWorklet(edges, workEids) {
  let intoWorklet = false;
  let outOfWorklet = false;
  for (const k of edges) {
    const [a, b] = k.split('->').map(Number);
    if (workEids.has(b)) intoWorklet = true;
    if (workEids.has(a)) outOfWorklet = true;
  }
  return intoWorklet && outOfWorklet;
}

// Bounded poll that rejects loudly on timeout: the hook wires its session
// on real timers (worklet module load, bounded resume, recovery burst), so a
// fixed sleep races them under parallel `node --test` load.
async function waitFor(cond, timeoutMs, label) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for: ' + label);
    await sleep(10);
  }
}

function isAudible(edges, workEids) {
  const outputs = new Set();
  for (const k of edges) {
    const [a, b] = k.split('->').map(Number);
    if (b === 99999) outputs.add(a);
  }
  for (const k of edges) {
    const [a, b] = k.split('->').map(Number);
    if (outputs.has(b) && !workEids.has(a)) return true;
  }
  return false;
}

test('suspended context never captures; element left unmuted', async () => {
  const h = loadHook({ contextState: 'suspended', resumeStuck: true });
  await sleep(150);
  const A = new h.FakeMediaElement();
  A.muted = false;
  await A.play();
  await sleep(300);
  assert.equal(h.counts().createCalls, 0, 'no createMediaElementSource into suspended context');
  assert.equal(A.muted, false, 'element unmuted (guard restored)');
  assert.equal(A.__tnAttached !== true, true, 'not marked attached');
});

test('maybeCloseIdleMediaSession refuses while sources held', () => {
  const src = read('page-hook.js');
  const start = src.indexOf('function maybeCloseIdleMediaSession');
  assert.ok(start >= 0, 'helper exists');
  const body = src.slice(start, start + 800);
  assert.ok(body.includes('session.captured'), 'capture latch guards close, not a size check');
});

test('processor error bypasses to audible path', async () => {
  const h = loadHook();
  // Wait for the routed steady state instead of a fixed sleep: under
  // parallel `node --test` load the hook's own timers (bounded resume,
  // 250 ms recovery-burst ticks that re-run routeSession) slip relative to
  // the test's sleeps, so sleep-then-act races them.
  await waitFor(() => h.workletInstances.length > 0
    && typeof h.workletInstances[h.workletInstances.length - 1]._ope === 'function'
    && isRoutedThroughWorklet(h.edges, new Set(h.workletInstances.map((x) => x._eid))),
    10000, 'worklet routed input->worklet->output');
  // Always drive the CURRENT worklet: a burst tick may have replaced it.
  const w = h.workletInstances[h.workletInstances.length - 1];
  w._ope(new Error('boom'));
  // Assert synchronously: the bypass connects input->output inside the
  // error handler itself, and any await yields to the recovery burst whose
  // next tick re-routes through a fresh worklet (disconnecting the bypass).
  const workEids = new Set(h.workletInstances.map((x) => x._eid));
  assert.equal(isAudible(h.edges, workEids), true, 'input connected straight to output (audible), not silent');
});

test('throwing connect in routeSession still leaves audible path', async () => {
  const h = loadHook({ throwOnWorkletConnect: true });
  await sleep(250);
  const workEids = new Set(h.workletInstances.map((x) => x._eid));
  assert.equal(isAudible(h.edges, workEids), true, 'bypass input->output survives a throwing connect');
});

test('site off with suspended context does not silence captured element', async () => {
  const h = loadHook();
  await sleep(200);
  const A = new h.FakeMediaElement();
  await A.play();
  await sleep(250);
  assert.equal(A.__tnAttached, true, 'element captured while running');
  // Gate the feed: suspend the context before STOP, as an autoplay-gated
  // tab holds it.
  h.contexts[0].state = 'suspended';
  const before = h.counts().resumeCalls;
  h.dispatchPage({ channel: 'tab-normalizer-v5', type: 'STOP' });
  await sleep(100);
  const workEids = new Set(h.workletInstances.map((x) => x._eid));
  assert.equal(isAudible(h.edges, workEids), true, 'captured element kept on input->destination path');
  assert.ok(h.counts().resumeCalls > before, 'stop/bypass resumes suspended context toward audible');
});

test('context is not closed after ended while element stays in DOM', async () => {
  const h = loadHook();
  await sleep(200);
  const A = new h.FakeMediaElement();
  await A.play();
  await sleep(250);
  assert.equal(A.__tnAttached, true, 'element captured');
  A.dispatchEvent({ type: 'ended' });
  await sleep(50);
  h.dispatchPage({ channel: 'tab-normalizer-v5', type: 'STOP' });
  await sleep(100);
  assert.notEqual(h.contexts[0].state, 'closed', 'captured context never closes after ended');
});

test('removal inside the debounce window is still detached', async () => {
  const h = loadHook();
  await sleep(200);
  const A = new h.FakeMediaElement();
  const B = new h.FakeMediaElement();
  await A.play();
  await B.play();
  await sleep(250);
  assert.equal(A.__tnAttached, true, 'A attached');
  assert.equal(B.__tnAttached, true, 'B attached');
  // Two removals land in the same 100 ms debounce window: the second
  // must coalesce, not drop.
  h.fireMutations([{ addedNodes: [], removedNodes: [A] }]);
  h.fireMutations([{ addedNodes: [], removedNodes: [B] }]);
  await sleep(300);
  assert.equal(A.__tnAttached, false, 'first removal detached');
  assert.equal(B.__tnAttached, false, 'debounced removal still detached');
});
