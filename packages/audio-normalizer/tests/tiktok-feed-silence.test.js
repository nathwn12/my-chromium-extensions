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
  const captured = new Set();
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
    createMediaElementSource(el) {
      createCalls++;
      // Web Audio allows exactly ONE source per element: a second attempt throws,
      // which is what leaves a released element unmanaged on a live document.
      if (captured.has(el)) throw new DOMException('already captured', 'InvalidStateError');
      captured.add(el);
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
  // There is no page control channel: the hook starts only when the WORKER
  // calls the dispatcher it installed (`executeScript({func})` in the real
  // extension), so the harness drives that call exactly like the worker does.
  const control = (action, payload) => (typeof sandbox.__tnHookV6 === 'function'
    ? sandbox.__tnHookV6(action, payload || {})
    : { ok: false, alive: false, active: false, error: 'No hook in this frame.' });
  const start = (payload) => control('start', {
    gainDb: 0,
    workletUrl: 'chrome-extension://test-id/audio/normalizer-worklet.js',
    ...(payload || {}),
  });
  const stop = () => control('stop', {});
  const WORKLET_URL = 'chrome-extension://test-id/audio/normalizer-worklet.js';
  const reinject = () => {
    // What the content script does before asking the worker for a new injection.
    docEl.setAttribute('data-tn-worklet-url', WORKLET_URL);
    vm.runInContext(src, sandbox, { filename: 'page-hook.js#reinject' });
  };
  const fireDoc = (t) => { for (const fn of (docListeners[t] || []).slice()) { try { fn(); } catch {} } };
  // Old premise kept: a frame the content script injected into was armed at
  // load (the pending-start attribute). The worker's start call is that arming.
  start();
  const fireMutations = (mutations) => {
    if (observerCallback) observerCallback(mutations);
  };
  return {
    sandbox, posted, control, start, stop, reinject, fireDoc, fireMutations, workletInstances, edges, contexts,
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

test('site off RELEASES the captured graph instead of keeping a route for it', async () => {
  const h = loadHook();
  await sleep(200);
  const A = new h.FakeMediaElement();
  await A.play();
  await sleep(250);
  assert.equal(A.__tnAttached, true, 'element captured while running');
  assert.ok(h.workletInstances.length > 0, 'and normalized through the worklet');
  // Gate the feed: suspend the context before STOP, as an autoplay-gated
  // tab holds it.
  h.contexts[0].state = 'suspended';
  h.stop();
  await sleep(150);
  const workEids = new Set(h.workletInstances.map((x) => x._eid));
  // Design cut: stop releases the context and its sources for good, so nothing
  // of ours routes this element any more (a reload rebuilds it).
  assert.equal(isAudible(h.edges, workEids), false, 'no route of ours survives');
  assert.equal(A.__tnAttached !== true, true, 'the element is released from our registry');
  assert.equal(A.muted, false, 'and is never left muted by us');
});

test('a captured context closes on stop even after the element ended', async () => {
  const h = loadHook();
  await sleep(200);
  const A = new h.FakeMediaElement();
  await A.play();
  await sleep(250);
  assert.equal(A.__tnAttached, true, 'element captured');
  A.dispatchEvent({ type: 'ended' });
  await sleep(50);
  h.stop();
  await sleep(150);
  assert.equal(h.contexts[0].state, 'closed', 'stop closes the captured context');
  assert.equal(A.__tnAttached !== true, true, 'and drops the element from the registry');
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

// Design cut (round 5): a released capture cannot be re-taken on a live
// document. The element is left alone until the page is reloaded; the popup
// carries the reload notice (see exclusion.test.js).
test('exclude -> enable on a live document leaves the element unprocessed; a reload normalizes it', async () => {
  const h = loadHook();
  await sleep(200);
  const A = new h.FakeMediaElement();
  await A.play();
  await sleep(300);
  const routeOf = (harness) => new Set(harness.workletInstances.map((x) => x._eid));
  assert.equal(A.__tnAttached, true, 'the element is normalized while enabled');
  assert.equal(isRoutedThroughWorklet(h.edges, routeOf(h)), true, 'routed through the worklet');

  h.stop();                       // exclude/disable: releases everything for good
  await sleep(250);
  assert.equal(A.__tnAttached !== true, true, 'released from our registry');

  // Re-enable on the SAME live document: the old source is still held by the
  // page, so the fresh instance cannot capture the element and leaves it alone.
  h.reinject();
  h.start();
  await sleep(200);
  A.muted = false;
  await A.play();
  await sleep(300);
  assert.equal(A.__tnAttached !== true, true, 'the old element is never adopted and never processed');
  assert.equal(A.muted, false, 'and is left untouched by us');
  assert.equal(A.__tnWebAudio, true, 'the one-source rule is recorded, not retried in a loop');

  // After a reload (a fresh page world) the same element normalizes again.
  const reloaded = loadHook();
  await sleep(200);
  const B = new reloaded.FakeMediaElement();
  await B.play();
  await sleep(300);
  assert.equal(B.__tnAttached, true, 'a reloaded page captures and processes its element');
  assert.equal(isRoutedThroughWorklet(reloaded.edges, routeOf(reloaded)), true, 'through the worklet');
});
