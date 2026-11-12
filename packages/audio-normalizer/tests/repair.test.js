const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
const shared = require('../shared.js');

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------- fake storage with call counts ----------
function createStore(initial = {}) {
  let store = clone(initial);
  const listeners = [];
  let getCalls = 0;
  const setCalls = [];
  return {
    getCalls: () => getCalls,
    setCalls,
    async get(keys) {
      getCalls++;
      if (keys === null || keys === undefined) return clone(store);
      if (typeof keys === 'string') return { [keys]: clone(store[keys]) };
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) out[k] = clone(store[k]);
        return out;
      }
      const out = {};
      for (const [k, def] of Object.entries(keys || {})) {
        if (def === undefined) continue;
        out[k] = k in store ? clone(store[k]) : clone(def);
      }
      return out;
    },
    async set(items) {
      setCalls.push(clone(items));
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: clone(store[k]), newValue: clone(v) };
        store[k] = clone(v);
      }
      for (const fn of [...listeners]) { try { fn(clone(changes), 'local'); } catch {} }
    },
    onChanged: { addListener(fn) { listeners.push(fn); } },
    _get: (k) => clone(store[k]),
  };
}

// ---------- content-script harness ----------
async function loadContent(href, storage) {
  const runtimeListeners = [];
  const windowListeners = {};
  const postedToPage = [];
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval: () => {},
    Promise, JSON, Object, Array, String, Number, Boolean, Date, Math, Error,
    URL,
    location: { href },
    chrome: {
      storage: {
        local: { get: (...a) => storage.get(...a), set: (...a) => storage.set(...a) },
        onChanged: { addListener: (fn) => storage.onChanged.addListener(fn) },
      },
      runtime: {
        onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
        sendMessage: async () => ({ ok: true }),
        getURL: (p) => `chrome-extension://test-id/${p}`,
      },
    },
    window: {
      addEventListener: (t, fn) => { (windowListeners[t] = windowListeners[t] || []).push(fn); },
      removeEventListener: () => {},
      postMessage: (msg) => postedToPage.push(msg),
    },
    document: {
      hidden: false,
      documentElement: {
        _a: {},
        setAttribute(k, v) { this._a[k] = String(v); },
        removeAttribute(k) { delete this._a[k]; },
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._a, k) ? this._a[k] : null; },
      },
      addEventListener: () => {},
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.TabNormalizerShared = shared;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('content-script.js'), sandbox, { filename: 'content-script.js' });
  // FAIL CLOSED: listeners appear only after the storage answer.
  await sleep(40);
  const sendMessage = (message) => new Promise((resolve) => {
    if (typeof runtimeListeners[0] !== 'function') {
      resolve({ ok: false, error: 'no receiver' });
      return;
    }
    const ret = runtimeListeners[0](message, {}, resolve);
    if (ret !== true) resolve(undefined);
  });
  const listenerCount = () => runtimeListeners.length;
  const dispatchPage = (data) => {
    for (const fn of (windowListeners.message || [])) fn({ source: sandbox.window, data });
  };
  return { sandbox, sendMessage, postedToPage, dispatchPage, listenerCount };
}

// ---------- background harness ----------
function loadBackground(storage, tabUrl = 'https://example.com/') {
  const runtimeListeners = [];
  const tabsSent = [];
  const scriptingCalls = [];
  let onStartupFn = null;
  const tab = { id: 7, url: tabUrl };
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, JSON, Object, Array, String, Number, Boolean, Map, Date, Math, Error,
    URL,
    chrome: {
      storage: {
        local: { get: (...a) => storage.get(...a), set: (...a) => storage.set(...a) },
        onChanged: { addListener: (fn) => storage.onChanged.addListener(fn) },
      },
      runtime: {
        onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
        onStartup: { addListener: (fn) => { onStartupFn = fn; } },
        sendMessage: async () => ({ ok: true }),
      },
      tabs: {
        query: async (...args) => {
          const cb = args.find((a) => typeof a === 'function');
          if (cb) { try { cb([tab]); } catch {} return []; }
          return [tab];
        },
        get: async () => ({ ...tab }),
        sendMessage: async (tabId, msg, options) => { tabsSent.push({ tabId, msg, options }); return { ok: true }; },
        onUpdated: { addListener: () => {} },
        onRemoved: { addListener: () => {} },
      },
      scripting: { executeScript: async (opts) => { scriptingCalls.push(opts); return []; } },
    },
    __tabsSent: tabsSent,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.importScripts = () => {
    sandbox.self.TabNormalizerShared = shared;
    sandbox.TabNormalizerShared = shared;
  };
  vm.createContext(sandbox);
  vm.runInContext(read('background.js'), sandbox, { filename: 'background.js' });
  const sendMessage = (message, sender = {}) => new Promise((resolve) => {
    const ret = runtimeListeners[0](message, sender, resolve);
    if (ret !== true) resolve(undefined);
  });
  return { sandbox, sendMessage, tabsSent, scriptingCalls, runStartup: async () => { if (onStartupFn) await onStartupFn(); } };
}

// ---------- page-hook harness ----------
function loadHook({ attrs = null, preHook = null, preConnectPatch = false } = {}) {
  const hookSrc = read('page-hook.js');
  const posted = [];
  const windowListeners = {};
  const addedModuleUrls = [];
  const resetMessages = [];

  class FakeElement {
    constructor() { this._tnListeners = Object.create(null); }
    addEventListener(type, fn) { (this._tnListeners[type] = this._tnListeners[type] || []).push(fn); }
    removeEventListener() {}
    dispatchEvent(ev) {
      const type = typeof ev === 'string' ? ev : ev && ev.type;
      if (!type) return true;
      for (const fn of ((this._tnListeners[type] || []).slice())) {
        try { fn.call(this, typeof ev === 'string' ? { type, target: this } : Object.assign({ target: this }, ev)); } catch {}
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
    connect() { return undefined; }
    disconnect() {}
  }
  if (preConnectPatch) FakeAudioNode.prototype.__tnConnect = true;
  const capturedByContext = new WeakMap();
  class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.sampleRate = 48000;
      this.destination = {};
      this.audioWorklet = { addModule: async (url) => { addedModuleUrls.push(url); } };
    }
    async resume() {}
    close() { this.state = 'closed'; return Promise.resolve(); }
    createGain() { const n = new FakeAudioNode(); n.context = this; return n; }
    createMediaElementSource(el) {
      let set = capturedByContext.get(this);
      if (!set) { set = new Set(); capturedByContext.set(this, set); }
      if (set.has(el)) {
        throw new DOMException('already captured', 'InvalidStateError');
      }
      set.add(el);
      return { connect() {}, disconnect() {} };
    }
    addEventListener() {}
    removeEventListener() {}
  }
  class FakeWorkletNode {
    constructor() {
      this._ope = null;
      this.port = { postMessage: (msg) => { if (msg && msg.type === 'reset-program') resetMessages.push(msg); } };
    }
    connect() { return undefined; }
    disconnect() {}
    set onprocessorerror(v) { this._ope = v; }
    get onprocessorerror() { return this._ope; }
  }
  let observerCallback = null;
  class FakeMutationObserver {
    constructor(cb) { observerCallback = cb; }
    observe() {}
    disconnect() {}
  }
  const documentElementStub = {
    _attrs: { ...(attrs === null
      ? {
        'data-tab-normalizer-pending': '1',
        'data-tn-worklet-url': 'chrome-extension://test-id/audio/normalizer-worklet.js',
      }
      : attrs) },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    removeAttribute(k) { delete this._attrs[k]; },
  };
  const documentStub = {
    documentElement: documentElementStub,
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
  };
  const windowStub = {
    addEventListener(t, fn) { (windowListeners[t] = windowListeners[t] || []).push(fn); },
    removeEventListener() {},
    postMessage(msg) { posted.push(msg); },
    AudioContext: FakeAudioContext,
    OfflineAudioContext: FakeAudioContext,
    webkitAudioContext: undefined,
  };
  if (preHook !== null) windowStub.__tabNormalizerHookV5 = preHook;
  const sandbox = {
    window: windowStub,
    document: documentStub,
    location: { href: 'https://example.com/' },
    Element: FakeElement,
    HTMLMediaElement: FakeMediaElement,
    AudioNode: FakeAudioNode,
    AudioContext: FakeAudioContext,
    OfflineAudioContext: FakeAudioContext,
    AudioWorkletNode: FakeWorkletNode,
    MutationObserver: FakeMutationObserver,
    DOMException,
    URL,
    console,
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(hookSrc, sandbox, { filename: 'page-hook.js' });
  const dispatchPage = (data) => {
    for (const fn of (windowListeners.message || [])) fn({ source: windowStub, data });
  };
  const fireMutations = (mutations) => {
    if (observerCallback) observerCallback(mutations);
  };
  return {
    sandbox, posted, dispatchPage, fireMutations, addedModuleUrls, resetMessages,
    documentElementStub, windowStub, FakeMediaElement, FakeElement,
  };
}

// ============ item 6: full-host keys ============
test('item6: github pages hosts get distinct toggles, legacy collapses read-only', async () => {
  assert.equal(shared.getSiteKey('alice.github.io'), 'alice.github.io');
  assert.equal(shared.getSiteKey('bob.github.io'), 'bob.github.io');
  assert.equal(shared.legacySiteStorageKey('alice.github.io'), 'site:github.io');
  const storage = createStore({
    'site:alice.github.io': { enabled: true, gainDb: 1, seq: 1, mirror: true },
  });
  const alice = await loadContent('https://alice.github.io/app', storage);
  const bob = await loadContent('https://bob.github.io/app', storage);
  await sleep(60);
  const sa = await alice.sendMessage({ type: 'GET_DOCUMENT_STATUS' });
  assert.equal(sa.enabled, true, 'alice enabled by its own full-key record');
  // bob has no record at all, so the fail-closed bootstrap installs nothing:
  // there is no content script to ask, which is the strongest form of "not
  // enabled by alice's full-key record".
  assert.equal(bob.listenerCount(), 0, 'bob gets no content script at all (unknown host is inactive)');
});

test('item6: legacy collapsed record migrates to the full key on first write', async () => {
  const storage = createStore({
    siteSettings: { 'www.youtube.com': { enabled: true, gainDb: 4 } },
  });
  const bg = loadBackground(storage, 'https://www.youtube.com/watch');
  const got = await bg.sendMessage({ type: 'GET_SITE_STATE', hostname: 'www.youtube.com' });
  assert.equal(got.enabled, true);
  assert.equal(got.gainDb, 4);
  assert.ok(storage._get('site:www.youtube.com'), 'first write migrates to the full key');
  assert.equal(storage._get('site:www.youtube.com').gainDb, 4);
});

// ============ item 2/8/9/10: manifest, policy, copy ============
test('item2: content script covers opaque-origin iframes', () => {
  // The content script is no longer a static `<all_urls>` manifest entry: it
  // is registered dynamically (background.js `syncContentScriptRegistration`).
  // The opaque-origin guarantee now lives on that descriptor, so assert both
  // halves: the manifest no longer injects anywhere, and the registration
  // carries `matchOriginAsFallback` with `all_frames`.
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.content_scripts, undefined, 'no static injection left');
  const bg = read('background.js');
  assert.match(bg, /matchOriginAsFallback:\s*true/);
  assert.match(bg, /allFrames:\s*true/);
  assert.match(bg, /runAt:\s*'document_start'/);
});

test('item8: unused tabs permission gone from manifest and policy', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.ok(!manifest.permissions.includes('tabs'), 'no tabs permission');
  assert.ok(!read('PRIVACY_POLICY.md').includes('`tabs`'), 'no tabs line in policy');
});

test('item9: page-hook not web-accessible, worklet is', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const resources = manifest.web_accessible_resources.flatMap((e) => e.resources);
  assert.ok(!resources.includes('page-hook.js'), 'hook injected via scripting only');
  assert.ok(resources.includes('audio/normalizer-worklet.js'), 'worklet stays reachable');
});

test('item10: reset zeroes gain, per-site opt-in copy', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.ok(!/every tab/i.test(manifest.description), 'no every-tab claim');
  assert.ok(/per-site/i.test(manifest.description), 'per-site opt-in stated');
  assert.ok(!/return a site to defaults/i.test(read('README.md')), 'no defaults claim');
  assert.ok(/zero/i.test(read('README.md')), 'reset zeroes gain');
});

// ============ item 1: own capture never mislabeled ============
test('item1: own createMediaElementSource capture is not marked __tnWebAudio', async () => {
  const src = read('page-hook.js');
  assert.ok(src.includes('!state.internalWiring'), 'capture marking gated on internalWiring');
  const h = loadHook();
  await sleep(150);
  const A = new h.FakeMediaElement();
  await A.play();
  await sleep(150);
  assert.notEqual(A.__tnWebAudio, true, 'own attach must not label the element page-wired');
  assert.equal(A.__tnAttached, true, 'element attached');
});

// ============ item 3: worklet origin pinning ============
test('item3: foreign-extension START never becomes the worklet URL', async () => {
  // Forged START as the FIRST start (no auto-start, no pinned fallback):
  // the unpinned validator accepts the foreign id and loads it as the
  // worklet; the pinned validator fails closed with no module load.
  const h = loadHook({ attrs: {} });
  await sleep(80);
  h.addedModuleUrls.length = 0;
  h.dispatchPage({
    channel: 'tab-normalizer-v5',
    type: 'START',
    reason: 'forged',
    gainDb: 0,
    workletUrl: 'chrome-extension://other-id/audio/normalizer-worklet.js',
  });
  await sleep(150);
  assert.ok(!h.addedModuleUrls.some((u) => u.includes('other-id')), 'foreign origin never loaded as worklet');
  assert.ok(h.posted.some((m) => m.type === 'HOOK_ERROR' && /Invalid worklet URL/.test(String(m.error))), 'fail-closed status error');
});

test('item3: missing pinned origin fails closed with a visible error', async () => {
  const h = loadHook({ attrs: {} });
  await sleep(80);
  h.dispatchPage({
    channel: 'tab-normalizer-v5',
    type: 'START',
    reason: 'x',
    gainDb: 0,
    workletUrl: 'https://evil.example/audio/normalizer-worklet.js',
  });
  await sleep(80);
  const errors = h.posted.filter((m) => m.type === 'HOOK_ERROR');
  assert.ok(errors.length > 0, 'fail-closed HOOK_ERROR posted');
  assert.ok(errors.every((m) => /Invalid worklet URL/.test(String(m.error))), 'clear status error, never empty');
});

test('item3: hook echoes gainDb on status so drift is correctable', async () => {
  const h = loadHook();
  await sleep(150);
  const started = h.posted.filter((m) => m.type === 'HOOK_STARTED');
  assert.ok(started.length > 0, 'hook started');
  assert.equal(typeof started[0].gainDb, 'number', 'status carries gainDb echo');
});

test('item3b: content corrects a drifted hook gain from stored truth', async () => {
  const storage = createStore({
    'site:example.com': { enabled: true, gainDb: 3, seq: 1, mirror: true },
  });
  const c = await loadContent('https://example.com/watch', storage);
  await sleep(60);
  c.postedToPage.length = 0;
  c.dispatchPage({ channel: 'tab-normalizer-v5', type: 'HOOK_STATUS', active: true, gainDb: 99 });
  await sleep(20);
  const corrections = c.postedToPage.filter((m) => m.type === 'SET_GAIN');
  assert.ok(corrections.length > 0, 'drift corrected with a SET_GAIN');
  assert.equal(corrections[corrections.length - 1].gainDb, 3, 'stored truth re-asserted');
});

// ============ item 4: error always visible ============
test('item4: HOOK_ERROR carries lastError even while inactive', async () => {
  const src = read('page-hook.js');
  assert.ok(!src.includes('state.active ? state.lastError'), 'no active-gated error');
  const h = loadHook({ attrs: {} });
  await sleep(80);
  h.dispatchPage({
    channel: 'tab-normalizer-v5',
    type: 'START',
    reason: 'x',
    gainDb: 0,
    workletUrl: 'https://evil.example/audio/normalizer-worklet.js',
  });
  await sleep(80);
  const errors = h.posted.filter((m) => m.type === 'HOOK_ERROR');
  assert.ok(errors.length > 0, 'HOOK_ERROR posted while inactive');
  assert.ok(errors.every((m) => String(m.error).length > 0), 'error never blanked');
});

// ============ item 5: page hook object cannot block install ============
test('item5: page-defined hook object is overwritten; guard is __tnConnect', () => {
  const src = read('page-hook.js');
  assert.ok(src.includes('__tnConnect'), 'early-return keyed on the connect patch');
  assert.ok(!src.includes('__tabNormalizerHookV5?.revive'), 'no revive-based early return');
  let revived = false;
  const h = loadHook({ preHook: { revive: () => { revived = true; } } });
  assert.equal(revived, false, 'page revive() never consulted');
  assert.equal(typeof h.windowStub.__tabNormalizerHookV5.revive, 'function', 'real hook installed');
});

test('item5: second load early-returns once the real hook is present', () => {
  const h = loadHook({ preHook: { revive: () => {} }, preConnectPatch: true });
  assert.equal(typeof h.windowStub.__tabNormalizerHookV5.revive, 'function');
  assert.ok(h.posted.length === 0, 'patched hook present: no reinstall chatter');
});

// ============ item 7: stopped flag + disabled backstop ============
test('item7: revive ignores the DOM pending fallback after stop', async () => {
  const src = read('page-hook.js');
  assert.ok(src.includes('state.stopped'), 'stopped flag tracked');
  const h = loadHook();
  await sleep(150);
  assert.ok(h.posted.some((m) => m.type === 'HOOK_STARTED'), 'started');
  h.dispatchPage({ channel: 'tab-normalizer-v5', type: 'STOP' });
  await sleep(30);
  assert.ok(h.posted.some((m) => m.type === 'HOOK_STOPPED'), 'stopped');
  const before = h.posted.filter((m) => m.type === 'HOOK_STARTED').length;
  h.documentElementStub.setAttribute('data-tab-normalizer-pending', '1');
  h.windowStub.__tabNormalizerHookV5.revive();
  await sleep(150);
  assert.equal(
    h.posted.filter((m) => m.type === 'HOOK_STARTED').length,
    before,
    'no re-route after stop without a real START',
  );
});

test('item7: disabled tab posts STOP when an active hook reports in', async () => {
  const storage = createStore({
    'site:example.com': { enabled: false, gainDb: 0, seq: 0, mirror: false },
  });
  const c = await loadContent('https://example.com/watch', storage);
  await sleep(60);
  c.postedToPage.length = 0;
  c.dispatchPage({ channel: 'tab-normalizer-v5', type: 'HOOK_STARTED', active: true });
  await sleep(20);
  const stops = c.postedToPage.filter((m) => m.type === 'STOP');
  assert.ok(stops.length > 0, 'STOP backstop posted for a disabled tab');
});

// ============ item 11: prune on emptied/ended/removal ============
test('item11: emptied and ended detach the element for collection', async () => {
  const src = read('page-hook.js');
  assert.ok(src.includes('detachMediaElement'), 'detach helper exists');
  const h = loadHook();
  await sleep(150);
  const A = new h.FakeMediaElement();
  await A.play();
  await sleep(150);
  assert.equal(A.__tnAttached, true, 'attached');
  A.dispatchEvent({ type: 'emptied' });
  assert.equal(A.__tnAttached, false, 'emptied detaches');
  const B = new h.FakeMediaElement();
  await B.play();
  await sleep(150);
  assert.equal(B.__tnAttached, true, 'second element attached');
  B.dispatchEvent({ type: 'ended' });
  assert.equal(B.__tnAttached, false, 'ended detaches');
});

test('item11: removed nodes detach via the observer', async () => {
  const h = loadHook();
  await sleep(150);
  const A = new h.FakeMediaElement();
  await A.play();
  await sleep(150);
  assert.equal(A.__tnAttached, true, 'attached');
  h.fireMutations([{ addedNodes: [], removedNodes: [A] }]);
  await sleep(250);
  assert.equal(A.__tnAttached, false, 'removal detaches');
});

test('item11: closed contexts pruned, idle media contexts closed', async () => {
  const src = read('page-hook.js');
  assert.ok(src.includes('pruneClosedSessions'), 'closed-context prune exists');
  assert.ok(src.includes('session.sources.clear()'), 'teardown drops source refs');
  assert.ok(src.includes('maybeCloseIdleMediaSession'), 'idle hook-created contexts close');
});

// ============ item 12: in-memory document status ============
test('item12: GET_DOCUMENT_STATUS answers from memory without storage reads', async () => {
  const src = read('content-script.js');
  const fnStart = src.indexOf('async function getDocumentStatus');
  assert.ok(fnStart >= 0, 'getDocumentStatus exists');
  const fnBody = src.slice(fnStart, src.indexOf('async function ensureFreshPopupStatus'));
  assert.ok(!fnBody.includes('getEffectiveDocumentState'), 'no storage-backed state read per poll');
  assert.ok(!fnBody.includes('readStoredConfig'), 'no storage read per poll');
  const storage = createStore({
    'site:example.com': { enabled: true, gainDb: 2, seq: 1, mirror: true },
  });
  const c = await loadContent('https://example.com/watch', storage);
  await sleep(60);
  const baseline = storage.getCalls();
  await c.sendMessage({ type: 'GET_DOCUMENT_STATUS' });
  await c.sendMessage({ type: 'GET_DOCUMENT_STATUS' });
  await c.sendMessage({ type: 'GET_DOCUMENT_STATUS' });
  assert.equal(storage.getCalls(), baseline, 'three polls add zero storage reads');
});

// ============ item 13: persist once per drag, broadcast once ============
function makeFakeEl(id) {
  return {
    id, disabled: false, checked: false, value: '0', textContent: '', className: '',
    dataset: {}, _handlers: {},
    addEventListener(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); },
    async fire(ev, ...args) { for (const fn of (this._handlers[ev] || [])) await fn(...args); },
  };
}
function loadPopup({ tabUrl, runtimeSendMessage, tabsSendMessage }) {
  const els = {
    'reset-btn': makeFakeEl('reset-btn'),
    toggle: makeFakeEl('toggle'),
    'gain-slider': makeFakeEl('gain-slider'),
    'gain-value': makeFakeEl('gain-value'),
    hostname: makeFakeEl('hostname'),
    'status-pill': makeFakeEl('status-pill'),
    'status-text': makeFakeEl('status-text'),
  };
  const presetButtons = ['speech', 'music', 'boost'].map((p) => {
    const b = makeFakeEl(`preset-${p}`);
    b.dataset.preset = p;
    return b;
  });
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval: () => {},
    Promise, JSON, Object, Array, String, Number, Boolean, Math, Error,
    URL,
    Date,
    document: {
      getElementById: (id) => els[id] || null,
      querySelectorAll: () => presetButtons,
    },
    window: { addEventListener: () => {} },
    chrome: {
      tabs: {
        query: async () => [{ id: 7, url: tabUrl }],
        sendMessage: tabsSendMessage,
      },
      runtime: { sendMessage: runtimeSendMessage },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('shared.js'), sandbox, { filename: 'shared.js' });
  vm.runInContext(read('popup.js'), sandbox, { filename: 'popup.js' });
  return { sandbox, els };
}

test('item13: drag persists once on release with one broadcast', async () => {
  const seen = [];
  const bgStorage = createStore({
    'site:example.com': { enabled: true, gainDb: 0, seq: 0, mirror: true },
  });
  const bg = loadBackground(bgStorage, 'https://example.com/watch');
  const runtimeSendMessage = async (msg) => {
    if (msg.type === 'GET_SITE_STATE') return { ok: true, enabled: true, gainDb: 0, siteKey: 'example.com', seq: 0 };
    if (msg.type === 'SET_SITE_STATE') {
      seen.push(msg);
      const res = await bg.sendMessage(msg);
      return res;
    }
    return { ok: true };
  };
  const tabsCalls = [];
  const popup = loadPopup({
    tabUrl: 'https://example.com/watch',
    runtimeSendMessage,
    tabsSendMessage: async (tabId, msg, options) => {
      tabsCalls.push({ tabId, msg, options });
      if (msg?.type === 'GET_DOCUMENT_STATUS') {
        return { ok: true, enabled: true, hostname: 'example.com', siteKey: 'example.com', gainDb: 0, hookAlive: false, hookActive: false, activating: false, lastError: '', indicator: 'gray' };
      }
      return { ok: true };
    },
  });
  await sleep(60);
  popup.els['gain-slider'].disabled = false;
  popup.els.toggle.checked = true;
  bg.tabsSent.length = 0;
  // A 5-step drag: ticks preview only, release persists once.
  for (const v of ['2', '4', '6', '8', '10']) {
    popup.els['gain-slider'].value = v;
    await popup.els['gain-slider'].fire('input');
  }
  await sleep(10);
  assert.equal(seen.length, 0, 'no persist during the drag');
  await popup.els['gain-slider'].fire('change');
  await popup.els['gain-slider'].fire('pointerup');
  await sleep(60);
  assert.equal(seen.length, 1, 'exactly one persist for the whole drag');
  assert.deepEqual({ ...seen[0].set }, { gainDb: 10 }, 'field-level gain intent only');
  const broadcasts = bg.tabsSent.filter((c) => c.msg?.type === 'TOGGLE_CHANGED');
  assert.equal(broadcasts.length, 1, 'exactly one broadcast per persisted write');
  assert.equal(broadcasts[0].options?.frameId, 0, 'broadcast targets the top frame');
});

test('item13: same-tick bursts broadcast once per site', async () => {
  const storage = createStore({
    'site:example.com': { enabled: true, gainDb: 0, seq: 0, mirror: true },
  });
  const bg = loadBackground(storage, 'https://example.com/watch');
  bg.tabsSent.length = 0;
  await storage.set({ 'site:example.com': { enabled: true, gainDb: 1, seq: 1, mirror: true } });
  await storage.set({ 'site:example.com': { enabled: true, gainDb: 2, seq: 2, mirror: true } });
  await sleep(40);
  const broadcasts = bg.tabsSent.filter((c) => c.msg?.type === 'TOGGLE_CHANGED');
  assert.equal(broadcasts.length, 1, 'coalesced to one broadcast');
  assert.equal(broadcasts[0].msg.gainDb, 2, 'broadcast carries the re-read truth');
});
