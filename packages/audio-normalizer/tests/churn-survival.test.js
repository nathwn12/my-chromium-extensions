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
function loadHook({ rejectResume = false } = {}) {
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
  let resumeCalls = 0;
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
    async resume() {
      resumeCalls++;
      if (rejectResume) throw new Error('autoplay policy');
      if (this.state !== 'closed') this.state = 'running';
    }
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
    addEventListener(type, fn) { (this._listeners ||= {})[type] = (this._listeners[type] || []).concat(fn); }
    removeEventListener(type, fn) {
      if (this._listeners && this._listeners[type]) this._listeners[type] = this._listeners[type].filter((listener) => listener !== fn);
    }
    transition(state) {
      this.state = state;
      for (const fn of (this._listeners?.statechange || []).slice()) fn.call(this, { type: 'statechange', target: this });
    }
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
    setAttribute(k, v) { this._attrs[k] = String(v); },
    removeAttribute(k) { delete this._attrs[k]; },
  };
  const documentStub = {
    visibilityState: 'visible',
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
  // No page control channel: the worker arms the hook through the dispatcher.
  const control = (action, payload) => (typeof sandbox.__tnHookV6 === 'function'
    ? sandbox.__tnHookV6(action, payload || {})
    : { ok: false, alive: false, active: false, error: 'No hook in this frame.' });
  const stopHook = () => control('stop', {});
  const WORKLET_URL = 'chrome-extension://test-id/audio/normalizer-worklet.js';
  const startHook = () => control('start', { gainDb: 0, workletUrl: WORKLET_URL });
  // What the content script does before asking the worker to inject again: stage
  // the worklet URL on the document, then run the file in the same page world.
  const reinject = () => {
    docEl.setAttribute('data-tn-worklet-url', WORKLET_URL);
    vm.runInContext(src, sandbox, { filename: 'page-hook.js#reinject' });
  };
  startHook();
  return {
    sandbox, posted, contexts, createdSources, FakeMediaElement,
    counts: () => ({ createCalls, closeCalls, suspendCalls, resumeCalls }),
    control,
    status: () => control('status', {}),
    startHook,
    reinject,
    stopHook,
    destroyHook: () => control('destroy', {}),
    fireMutations: (mutations) => { if (observerCallback) observerCallback(mutations); },
    // The page (or a previous hook instance) owns the element: the one-shot
    // capture is consumed. pageCapture also labels like the patched page
    // path; consumeCapture leaves it unlabelled (previous-instance case).
    pageCapture: (el) => { el.__tnWebAudio = true; captured.add(el); },
    consumeCapture: (el) => { captured.add(el); },
  };
}

test('an attached session recovers when its context suspends during dormancy without media events', async () => {
  for (const visibilityState of ['hidden', 'visible']) {
    const h = loadHook();
    await sleep(250);
    const media = new h.FakeMediaElement();
    await media.play();
    await sleep(1700);
    assert.equal(media.__tnAttached, true, 'session is processing before dormancy');

    const context = h.contexts[0];
    const resumesBefore = h.counts().resumeCalls;
    h.sandbox.document.visibilityState = visibilityState;
    context.transition('suspended');
    await sleep(40);

    assert.ok(h.counts().resumeCalls > resumesBefore, `${visibilityState} statechange initiates bounded resume recovery`);
    assert.equal(context.state, 'running', 'the same captured context resumes');
    assert.equal(media.__tnAttached, true, 'the existing media session remains attached');
    assert.equal(h.contexts.length, 1, 'recovery creates no duplicate context');
    assert.equal(h.counts().createCalls, 1, 'recovery never recaptures the media element');
    await sleep(1600);
    const resumesAfterBurst = h.counts().resumeCalls;
    await sleep(300);
    assert.equal(h.counts().resumeCalls, resumesAfterBurst, 'recovery stops after its bounded burst');
  }
});

test('autoplay rejection is reported and repeated suspension cannot extend the bounded retry burst', async () => {
  const h = loadHook({ rejectResume: true });
  await sleep(250);
  const media = new h.FakeMediaElement();
  await media.play();
  await sleep(1700);
  assert.equal(media.__tnAttached, true, 'session is attached before dormancy');
  const context = h.contexts[0];
  const resumesBefore = h.counts().resumeCalls;
  context.transition('suspended');
  await sleep(1600);
  const resumesAfterBurst = h.counts().resumeCalls;
  assert.ok(resumesAfterBurst > resumesBefore, 'statechange attempts resume');
  assert.ok(resumesAfterBurst <= resumesBefore + 6, 'failed resume uses at most one bounded burst');
  assert.equal(context.state, 'suspended', 'a rejected resume does not claim success');
  assert.equal(h.status().error, 'Audio context remains suspended. Resume playback to restore audio.',
    'a blocked resume is reported instead of silently claiming recovery');
  for (let i = 0; i < 4; i++) context.transition('suspended');
  await sleep(400);
  assert.equal(h.counts().resumeCalls, resumesAfterBurst, 'recovery stops after its bounded burst');
  assert.equal(h.contexts.length, 1, 'failure never creates another context');
  assert.equal(h.counts().createCalls, 1, 'failure never recaptures the element');
  context.transition('running');
  assert.equal(h.status().error, '', 'a later running transition clears only the recovery warning');
});

test('STOP and closed-session statechanges cannot schedule suspended recovery', async () => {
  const h = loadHook();
  await sleep(250);
  const media = new h.FakeMediaElement();
  await media.play();
  await sleep(1700);
  const context = h.contexts[0];

  h.stopHook();
  const stoppedResumes = h.counts().resumeCalls;
  context.transition('suspended');
  await sleep(50);
  assert.equal(h.counts().resumeCalls, stoppedResumes, 'STOP leaves the context watcher inert');

  h.startHook();
  await sleep(50);
  context.transition('closed');
  await sleep(50);
  const closedResumes = h.counts().resumeCalls;
  context.transition('suspended');
  await sleep(300);
  assert.equal(h.counts().resumeCalls, closedResumes, 'a closed or torn-down session cannot recover');
  assert.equal(h.contexts.length, 1, 'closed state does not create duplicate contexts');
});

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

test('stop KEEPS the captured context (a live re-enable reuses it); destroy releases it', async () => {
  const h = loadHook();
  await sleep(250);
  const A = new h.FakeMediaElement();
  await A.play();
  await sleep(300);
  assert.equal(A.__tnAttached, true, 'element captured');
  assert.equal(h.counts().createCalls, 1, 'context captured something');
  const source = A.__tnSource;
  const context = h.contexts[0];

  // Removal while active must not close or suspend the running context.
  h.fireMutations([{ addedNodes: [], removedNodes: [A] }]);
  await sleep(300);
  assert.equal(context.state, 'running', 'active context stays running when idle');
  assert.equal(h.counts().closeCalls, 0, 'no close while active');

  // An ordinary disable is a STOP: the worklet goes away and the page plays at
  // 0 dB, but the context, the source and the ownership all survive. Releasing
  // them here would make a re-enable impossible without a reload — a captured
  // element can never be captured twice.
  h.stopHook();
  await sleep(250);
  assert.equal(h.counts().closeCalls, 0, 'stop closes nothing');
  assert.notEqual(context.state, 'closed', 'the captured context survives a stop');
  assert.equal(source.disconnectCount, 0, 'the captured source stays wired, at unity');
  assert.equal(A.__tnSource, source, 'the element keeps its one source, so re-enable needs no re-capture');
  assert.equal(A.muted, false, 'and never left muted by us');
  assert.equal(h.status().active, false, 'nothing is processing while off');

  // Re-enable on the same document: live, one context, one source.
  const second = h.startHook();
  await sleep(300);
  assert.equal(second.active, true, 'the re-enabled hook processes again');
  assert.equal(h.contexts.length, 1, 'no second context was created');
  // The element comes back (a feed re-insert) and plays: it re-attaches to the
  // SAME source, with no second createMediaElementSource.
  h.fireMutations([{ addedNodes: [A], removedNodes: [] }]);
  await A.play();
  await sleep(300);
  assert.equal(h.counts().createCalls, 1, 'and the element was never captured twice');
  assert.equal(A.__tnAttached, true, 'the re-inserted element is managed again');

  // DESTROY is the exclusion/uninstall path and the only thing that releases.
  h.destroyHook();
  await sleep(250);
  assert.equal(h.counts().closeCalls, 1, 'destroy closes the captured context');
  assert.equal(context.state, 'closed', 'and it stays closed');
  assert.ok(source.disconnectCount >= 1, 'the captured source is disconnected');
  assert.equal(A.__tnAttached !== true, true, 'the element is released from our registry');
  assert.equal(A.muted, false, 'and never left muted by us');

  // A later instance (a fresh injection, as after a reload) builds its OWN
  // context and never adopts the released one.
  h.reinject();
  h.startHook();
  await sleep(300);
  assert.equal(h.contexts.length, 2, 'a later instance creates its own context, it does not adopt');
  assert.equal(h.counts().createCalls, 1, 'and does not try to capture the old element again');
  assert.equal(A.__tnAttached !== true, true, 'the old element stays unmanaged until a reload');
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
