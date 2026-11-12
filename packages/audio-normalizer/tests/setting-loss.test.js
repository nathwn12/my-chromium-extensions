const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = process.env.TN_SRC_DIR ? path.resolve(process.env.TN_SRC_DIR) : ROOT;
function src(name) { return fs.readFileSync(path.join(SRC_DIR, name), 'utf8'); }

const sharedApi = require(path.join(ROOT, 'shared.js'));

// ---------- fake chrome storage (per-site aware, onChanged wired) ----------
function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
function createFakeStorage(initial = {}, opts = {}) {
  let store = clone(initial);
  const listeners = [];
  const setCalls = [];
  const api = {
    _store: () => clone(store),
    _listeners: listeners,
    _setCalls: setCalls,
    _setDelay(ms) { opts.delayMs = ms; },
    async get(keys) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (keys === null || keys === undefined) return clone(store);
      if (typeof keys === 'string') return { [keys]: clone(store[keys]) };
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) out[k] = clone(store[k]);
        return out;
      }
      const out = {};
      for (const [k, def] of Object.entries(keys || {})) {
        // Platform behaviour (measured Step 1 repro): the extension API
        // marshals arguments as JSON, so a key whose default is `undefined`
        // is dropped from the query entirely — even when the key exists in
        // storage. The naive `k in store ? ... : def` kept such keys and was
        // more correct than Chromium, hiding product reads that can never
        // work in the real browser.
        if (def === undefined) continue;
        out[k] = k in store ? clone(store[k]) : clone(def);
      }
      return out;
    },
    async set(items) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      setCalls.push(clone(items));
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: clone(store[k]), newValue: clone(v) };
        store[k] = clone(v);
      }
      for (const fn of [...listeners]) { try { fn(clone(changes), 'local'); } catch {} }
    },
    onChanged: { addListener(fn) { listeners.push(fn); } },
  };
  return api;
}

// ---------- background harness (real background.js via vm) ----------
function loadBackground(storage, extra = {}) {
  const runtimeListeners = [];
  const tabsSent = [];
  const scriptingCalls = [];
  let onStartupFn = null;
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
          if (cb) { try { cb([]); } catch {} return []; }
          return [];
        },
        get: async () => { throw new Error('no tab'); },
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
    sandbox.self.TabNormalizerShared = sharedApi;
    sandbox.TabNormalizerShared = sharedApi;
  };
  Object.assign(sandbox, extra);
  vm.createContext(sandbox);
  vm.runInContext(src('background.js'), sandbox, { filename: 'background.js' });
  if (runtimeListeners.length === 0) throw new Error('background did not register onMessage');
  if (storage._listeners.length === 0) throw new Error('background did not register storage.onChanged');
  const sendMessage = (message, sender = {}) => new Promise((resolve) => {
    const sendResponse = (r) => resolve(r);
    const ret = runtimeListeners[0](message, sender, sendResponse);
    if (ret !== true) resolve(undefined);
  });
  return { sandbox, sendMessage, tabsSent, scriptingCalls, runStartup: async () => { if (onStartupFn) await onStartupFn(); } };
}

// ---------- content-script harness (one sandbox per frame) ----------
async function loadContentFrame(href, storage) {
  const runtimeListeners = [];
  const storageListeners = [];
  const postedToPage = [];
  const windowListeners = {};
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
        onChanged: { addListener: (fn) => { storageListeners.push(fn); storage.onChanged.addListener(fn); } },
      },
      runtime: {
        onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
        sendMessage: async (msg) => {
          // Control flows extension -> page only: the content script asks the WORKER,
          // which is the only party allowed to reach the MAIN world. The harness
          // records that request (the page receives nothing).
          if (msg && msg.type === 'CONTROL_HOOK') {
            const actionType = { start: 'START', stop: 'STOP', setGain: 'SET_GAIN', status: 'STATUS_REQUEST' }[msg.action] || msg.action;
            postedToPage.push({ type: actionType, via: 'worker', ...(msg.payload || {}) });
            return { ok: true, alive: true, active: true, gainDb: (msg.payload && msg.payload.gainDb) || 0, error: '' };
          }
          return { ok: true };
        },
        getURL: (p) => `chrome-extension://fake/${p}`,
      },
    },
    window: {
      addEventListener: (t, fn) => { (windowListeners[t] = windowListeners[t] || []).push(fn); },
      removeEventListener: () => {},
      postMessage: (msg) => postedToPage.push(msg),
    },
    document: {
      hidden: false,
      // document_start: this instance was injected while the document loaded.
      readyState: 'loading',
      documentElement: { setAttribute: () => {}, removeAttribute: () => {} },
      addEventListener: () => {},
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.TabNormalizerShared = sharedApi;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src('content-script.js'), sandbox, { filename: 'content-script.js' });
  // The instance is installed synchronously; whether it ARMS depends on the
  // load-time record (a site that loads off does no work at all).
  if (!sandbox.__tabNormalizerContentScriptV5) throw new Error(`content-script did not install for ${href}`);
  const sendMessage = (message) => new Promise((resolve) => {
    if (typeof runtimeListeners[0] !== 'function') {
      resolve({ ok: false, error: 'no receiver' });
      return;
    }
    const ret = runtimeListeners[0](message, {}, resolve);
    if (ret !== true) resolve(undefined);
  });
  return {
    sandbox,
    sendMessage,
    storageListeners,
    postedToPage,
    runtimeListeners: () => runtimeListeners.length,
  };
}

// ---------- popup harness (real popup.js via vm with fake DOM) ----------
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
    'status-dot': makeFakeEl('status-dot'),
    'status-text': makeFakeEl('status-text'),
  };
  els['gain-slider'].value = '0';
  const presetButtons = ['speech', 'music', 'boost'].map((p) => {
    const b = makeFakeEl(`preset-${p}`);
    b.dataset.preset = p;
    b.disabled = false;
    return b;
  });
  presetButtons[Symbol.iterator] = Array.prototype[Symbol.iterator];
  const unloadHandlers = [];
  const intervals = [];
  const tabsCalls = [];
  const mirrorStore = {};
  const fakeDate = { now: () => Date.now() };
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval: () => {},
    Promise, JSON, Object, Array, String, Number, Boolean, Math, Error,
    URL,
    Date: fakeDate,
    document: {
      getElementById: (id) => els[id] || null,
      querySelectorAll: () => presetButtons,
    },
    window: { addEventListener: (t, fn) => { if (t === 'unload') unloadHandlers.push(fn); } },
    chrome: {
      storage: {
        local: {
          get: (keys, cb) => {
            let result;
            if (typeof keys === 'string') result = { [keys]: mirrorStore[keys] };
            else if (Array.isArray(keys)) { result = {}; for (const k of keys) result[k] = mirrorStore[k]; }
            else { result = {}; for (const [k, d] of Object.entries(keys || {})) { if (d === undefined) continue; result[k] = k in mirrorStore ? mirrorStore[k] : d; } }
            if (typeof cb === 'function') { cb(JSON.parse(JSON.stringify(result))); return undefined; }
            return Promise.resolve(JSON.parse(JSON.stringify(result)));
          },
          set: async (items) => { Object.assign(mirrorStore, JSON.parse(JSON.stringify(items))); },
        },
        onChanged: { addListener: () => {} },
      },
      tabs: {
        query: async () => [{ id: 7, url: tabUrl }],
        sendMessage: async (tabId, msg, options) => {
          tabsCalls.push({ tabId, msg, options });
          if (tabsSendMessage) return tabsSendMessage(tabId, msg, options);
          return { ok: true };
        },
      },
      runtime: { sendMessage: runtimeSendMessage },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src('shared.js'), sandbox, { filename: 'shared.js' });
  vm.runInContext(src('popup.js'), sandbox, { filename: 'popup.js' });
  return { sandbox, els, presetButtons, unloadHandlers, intervals, tabsCalls, fakeDate };
}
async function settle(ms = 30) { await new Promise((r) => setTimeout(r, ms)); }

// ============ DEFECT 1: frame targeting (top frame only + provenance) ============
test('defect1a: popup targets the top frame with frameId 0', async () => {
  const runtimeSendMessage = async (msg) => {
    if (msg.type === 'GET_SITE_STATE') return { ok: true, enabled: true, gainDb: 3, siteKey: 'youtube.com', seq: 1 };
    return { ok: true };
  };
  const popup = loadPopup({
    tabUrl: 'https://www.youtube.com/watch?v=1',
    runtimeSendMessage,
    tabsSendMessage: async () => ({ ok: true, enabled: true, hostname: 'www.youtube.com', siteKey: 'youtube.com', gainDb: 3, hookAlive: false, hookActive: false, activating: false, lastError: '', indicator: 'gray' }),
  });
  await settle(50);
  const statusCalls = popup.tabsCalls.filter((c) => c.msg?.type === 'GET_DOCUMENT_STATUS');
  assert.ok(statusCalls.length > 0, 'popup polls document status');
  for (const c of statusCalls) {
    assert.equal(c.options?.frameId, 0, 'status poll targets the top frame only (frameId 0 needs no new permission)');
  }
});

test('defect1b: top-frame targeting AND siteKey provenance are both enforced', async () => {
  const truth = { ok: true, enabled: true, gainDb: 3, siteKey: 'youtube.com', seq: 1 };
  let evilEvenOnTop = false;
  const popup = loadPopup({
    tabUrl: 'https://www.youtube.com/watch?v=1',
    runtimeSendMessage: async (msg) => {
      if (msg.type === 'GET_SITE_STATE') return { ...truth };
      if (msg.type === 'SET_SITE_STATE') return { ok: true, ...truth, seq: 2 };
      return { ok: true };
    },
    tabsSendMessage: async (tabId, msg, options) => {
      if (msg?.type === 'GET_DOCUMENT_STATUS') {
        // Top-frame path returns truth; untargeted path returns the embedded
        // iframe's state (old platform behaviour: one arbitrary answer).
        if (options?.frameId === 0 && !evilEvenOnTop) {
          return { ok: true, enabled: true, hostname: 'www.youtube.com', siteKey: 'youtube.com', gainDb: 3, hookAlive: false, hookActive: false, activating: false, lastError: '', indicator: 'gray' };
        }
        return { ok: true, enabled: false, hostname: 'evil.com', siteKey: 'evil.com', gainDb: -12, hookAlive: false, hookActive: false, activating: false, lastError: '', indicator: 'gray' };
      }
      return { ok: true };
    },
  });
  await settle(50);
  assert.equal(popup.els.toggle.checked, true, 'popup initialised from stored truth (enabled)');
  assert.equal(popup.els['gain-slider'].value, '3');
  // (1) Targeting: every status poll must carry frameId 0. Removing the
  // frameId option fails here even though provenance alone would save the
  // controls below.
  const statusCalls = popup.tabsCalls.filter((c) => c.msg?.type === 'GET_DOCUMENT_STATUS');
  assert.ok(statusCalls.length > 0, 'popup polls document status');
  for (const c of statusCalls) {
    assert.equal(c.options?.frameId, 0, 'missing frameId:0 fails targeting even when provenance passes');
  }
  // (2) Provenance: an evil answer arriving even on the top-frame path must
  // be ignored. Removing the siteKey guard fails here even though targeting
  // alone is correct.
  evilEvenOnTop = true;
  await vm.runInContext('refreshDocumentStatus().catch(()=>{})', popup.sandbox);
  await settle(50);
  assert.equal(popup.els.toggle.checked, true, 'evil siteKey reply does not disable the selected site');
  assert.equal(popup.els['gain-slider'].value, '3', 'evil siteKey reply does not overwrite gain');
});

test('defect1c: disabling site A never disables embedded site B (content guard)', async () => {
  const storage = createFakeStorage({
    'site:youtube.com': { enabled: true, gainDb: 1, seq: 1, mirror: true },
    'site:example.com': { enabled: true, gainDb: 2, seq: 1, mirror: true },
  });
  const frameA = await loadContentFrame('https://www.youtube.com/watch?v=1', storage);
  const frameB = await loadContentFrame('https://example.com/embed', storage);
  await settle();
  const broadcast = { type: 'SET_DOCUMENT_STATE', siteKey: 'www.youtube.com', enabled: false };
  const [ra, rb] = await Promise.all([frameA.sendMessage(broadcast), frameB.sendMessage(broadcast)]);
  await settle();
  assert.equal(ra.ok, true, 'intended frame applies');
  assert.equal(rb.ok, false, 'foreign frame ignores mismatched siteKey');
  // Same guard on the toggle broadcast: a TOGGLE_CHANGED naming site A must
  // never reset an embedded frame from site B.
  const [ta, tb] = await Promise.all([
    frameA.sendMessage({ type: 'TOGGLE_CHANGED', siteKey: 'www.youtube.com', enabled: false }),
    frameB.sendMessage({ type: 'TOGGLE_CHANGED', siteKey: 'www.youtube.com', enabled: false }),
  ]);
  assert.equal(ta.ok, true, 'intended frame applies toggle broadcast');
  assert.equal(tb.ok, false, 'foreign frame ignores mismatched toggle broadcast');
  const stored = await storage.get(['site:example.com']);
  assert.equal(stored['site:example.com'].enabled, true, 'site B stays enabled in storage');
});

test('defect1d: background document messages are actually sent to the top frame (frameId 0)', async () => {
  const storage = createFakeStorage({
    'site:youtube.com': { enabled: false, gainDb: 0, seq: 0, mirror: false },
  });
  const bg = loadBackground(storage);
  // Patch tabs to a real matching tab so the broadcast path actually sends.
  // The old test left tabs.get throwing and tabs.query returning [] so no
  // message was ever sent and the loop asserted nothing (vacuous).
  const matchingTab = { id: 11, url: 'https://youtube.com/watch' };
  bg.sandbox.chrome.tabs.query = async (...args) => {
    const cb = args.find((a) => typeof a === 'function');
    if (cb) { try { cb([matchingTab]); } catch {} return [matchingTab]; }
    return [matchingTab];
  };
  bg.sandbox.chrome.tabs.get = async () => ({ ...matchingTab });
  // Trigger the per-site broadcast listener with a real change.
  await storage.set({ 'site:youtube.com': { enabled: true, gainDb: 2, seq: 1, mirror: true } });
  await settle(20);
  assert.ok(bg.tabsSent.length > 0, `expected a document message to be sent (got ${bg.tabsSent.length})`);
  for (const c of bg.tabsSent) {
    // Every frame, no frameId filter: a cross-origin frame of the site does not
    // share the tab's top-level URL, so a top-frame-only broadcast would miss it
    // and the frame's own siteKey guard isolates a foreign frame instead.
    assert.equal(
      c.options,
      undefined,
      `background message ${c.msg.type} targets every frame (got ${JSON.stringify(c.options)})`,
    );
  }
  const types = bg.tabsSent.map((c) => c.msg.type);
  assert.ok(types.includes('TOGGLE_CHANGED'), `expected TOGGLE_CHANGED broadcast (got ${types})`);
});

// ============ DECIDED RULE: last-accepted-write-wins (no wall clocks) ============
test('defect2a: two popups overlap saves, later arrival wins (documented trade)', async () => {
  // Decided rule: the background applies every intent on arrival and bumps
  // the `seq` audit counter; nothing is ever rejected. Trade (deliberate):
  // if popup 1's message is delayed past popup 2's newer action, the later
  // ARRIVAL (popup 1) wins rather than the later action. There is no
  // clock-free way to distinguish those; the window is milliseconds between
  // two simultaneously-open popups, and the wall-clock alternative locked a
  // field out until the clock caught up.
  const storage = createFakeStorage({
    'site:youtube.com': { enabled: true, gainDb: 0, seq: 0, mirror: true },
  });
  const bg = loadBackground(storage);
  const tabsStub = async () => ({ ok: true, enabled: true, hostname: 'youtube.com', siteKey: 'youtube.com', gainDb: 0, hookAlive: false, hookActive: false, activating: false, lastError: '', indicator: 'gray' });
  // Popup 1's delivery is delayed (stuck in flight); popup 2's is immediate.
  // Popup 1 sends FIRST (older action) but ARRIVES LAST.
  const p1Runtime = async (msg) => {
    if (msg.type === 'SET_SITE_STATE') await new Promise((r) => setTimeout(r, 30));
    return bg.sendMessage(msg);
  };
  const p2Runtime = async (msg) => bg.sendMessage(msg);
  const p1 = loadPopup({ tabUrl: 'https://youtube.com/watch', runtimeSendMessage: p1Runtime, tabsSendMessage: tabsStub });
  const p2 = loadPopup({ tabUrl: 'https://youtube.com/watch', runtimeSendMessage: p2Runtime, tabsSendMessage: tabsStub });
  await settle();
  // Overlap: both user actions dispatch without awaiting (second starts
  // while the first is still in flight). p1 arrives later, so p1 wins even
  // though p1 acted first — that is the accepted trade.
  const f1 = vm.runInContext('saveGainInner(2)', p1.sandbox);
  const f2 = vm.runInContext('saveGainInner(6)', p2.sandbox);
  await Promise.all([f1, f2]);
  await settle(60);
  const stored = await storage.get(['site:youtube.com']);
  assert.equal(stored['site:youtube.com'].gainDb, 2, 'later arrival wins (p1 delayed past p2): accepted trade, not newest-action-wins');
  assert.equal(stored['site:youtube.com'].seq, 2, 'seq audit counter bumps on every accepted write');
  // A different field still lands alongside: no per-field gating means no
  // cross-field blocking.
  const toggler = await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'youtube.com', tabId: 9, set: { enabled: false } });
  assert.ok(toggler.ok, 'enabled intent lands');
  await settle(20);
  const stored2 = await storage.get(['site:youtube.com']);
  assert.equal(stored2['site:youtube.com'].enabled, false, 'enabled lands alongside the gain winner');
  assert.equal(stored2['site:youtube.com'].gainDb, 2, 'gain winner preserved');
});

test('defect2b: the audit sequence is genuinely persisted on disk (survive restart)', async () => {
  const storage = createFakeStorage({
    'site:youtube.com': { enabled: true, gainDb: 0, seq: 5, mirror: true },
  });
  const bg1 = loadBackground(storage);
  const first = await bg1.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'youtube.com', tabId: 1, set: { gainDb: 6 } });
  assert.equal(first.ok, true);
  assert.equal(first.seq, 6, 'background returns the bumped audit counter');
  const snap = await storage.get(['site:youtube.com']);
  assert.equal(snap['site:youtube.com'].seq, 6, 'background bumps seq inside the same per-site value on disk');
  assert.equal(snap['site:youtube.com'].gainDb, 6);
  assert.ok(!('at' in snap['site:youtube.com']) && !('atGain' in snap['site:youtube.com']), 'no wall-clock fields are persisted');
  // Simulate a service-worker restart: a fresh background over the same storage.
  const bg2 = loadBackground(storage);
  // Nothing is ever rejected: every arrival applies and keeps bumping seq.
  const second = await bg2.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'youtube.com', tabId: 1, set: { gainDb: 2 } });
  assert.equal(second.ok, true);
  assert.equal(second.seq, 7, 'sequence continues past the restart instead of resetting');
  const stored = await storage.get(['site:youtube.com']);
  assert.equal(stored['site:youtube.com'].seq, 7, 'sequence continues past the restart instead of resetting');
  assert.equal(stored['site:youtube.com'].gainDb, 2, 'latest arrival lands after restart');
});

test('defect2c repurposed: a multi-field intent applies atomically or not at all', async () => {
  // With the clocks gone the old equal-timestamp title would lie, so this
  // test now covers the decided unit rule: a {gainDb, enabled} intent lands
  // together in one write. A response missing the stored truth is a failure.
  const storage = createFakeStorage({
    'site:youtube.com': { enabled: true, gainDb: 6, seq: 1, mirror: true },
  });
  const bg = loadBackground(storage);
  const writesBefore = storage._setCalls.length;
  const res = await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'youtube.com', tabId: 1, set: { gainDb: 0, enabled: false } });
  assert.equal(res.ok, true);
  assert.equal(res.enabled, false, 'response carries the full stored truth');
  assert.equal(res.gainDb, 0);
  assert.equal(res.seq, 2, 'one accepted write bumps seq once');
  const writes = storage._setCalls.slice(writesBefore).filter((w) => w['site:youtube.com']);
  assert.equal(writes.length, 1, 'multi-field intent is exactly ONE per-site write');
  const rec = writes[0]['site:youtube.com'];
  assert.equal(rec.gainDb, 0, 'gain lands');
  assert.equal(rec.enabled, false, 'enabled lands in the same write');
  assert.equal(rec.mirror, false, 'mirror follows enabled in the same write');
});

// ============ DEFECT 3: no pending work; immediate persist; reset is one write ============
test('defect3a: drag previews transiently, persists once on change (no per-tick write)', async () => {
  const seen = [];
  const tabsCalls = [];
  const runtimeSendMessage = async (msg) => {
    if (msg.type === 'GET_SITE_STATE') return { ok: true, enabled: true, gainDb: 0, siteKey: 'youtube.com', seq: 0 };
    if (msg.type === 'SET_SITE_STATE') { seen.push({ ...msg }); return { ok: true, enabled: true, gainDb: msg.set?.gainDb ?? msg.gainDb, siteKey: 'youtube.com', seq: 1 }; }
    return { ok: true };
  };
  const popup = loadPopup({
    tabUrl: 'https://youtube.com/watch',
    runtimeSendMessage,
    tabsSendMessage: async (tabId, msg, options) => {
      tabsCalls.push({ tabId, msg, options });
      return { ok: true };
    },
  });
  await settle(50);
  popup.els['gain-slider'].disabled = false;
  popup.els.toggle.checked = true;
  // A drag tick renders locally and live-applies a transient preview —
  // no storage intent is dispatched per tick.
  popup.els['gain-slider'].value = '6';
  await popup.els['gain-slider'].fire('input');
  await settle(10);
  assert.equal(seen.filter((m) => m.type === 'SET_SITE_STATE').length, 0, 'input dispatches no persist');
  const previews = tabsCalls.filter((c) => c.msg?.type === 'SET_DOCUMENT_STATE' && c.msg?.transient === true);
  assert.equal(previews.length, 1, 'input live-applies one transient preview to the top frame');
  assert.equal(previews[0].msg.gainDb, 6, 'preview carries the dragged gain');
  assert.equal(previews[0].options?.frameId, 0, 'preview targets the top frame');
  // Release persists exactly once; the paired pointerup does not double it.
  await popup.els['gain-slider'].fire('change');
  await settle(10);
  await popup.els['gain-slider'].fire('pointerup');
  await settle(10);
  const sets = seen.filter((m) => m.type === 'SET_SITE_STATE');
  assert.equal(sets.length, 1, 'change+pointerup persist exactly once per value');
  assert.equal(sets[0].set?.gainDb, 6, 'gain input sends a field-level intent (only gainDb)');
  assert.deepEqual(Object.keys(sets[0].set || {}).sort(), ['gainDb'], 'intent carries ONLY the changed field');
  assert.ok(!('at' in sets[0]) && !('actionAt' in sets[0]), 'no wall-clock stamp is sent (clocks deleted)');
});

test('defect3b: closing the popup cannot lose work (release persist lands after teardown)', async () => {
  // SIMULATION, not browser-equivalent teardown: the harness replaces
  // `runtime.sendMessage` with a thrower and empties the interval list, but
  // the vm context and outstanding continuations stay alive — a real popup
  // close destroys the document and its JS. What this proves is narrower:
  // the release-time intent is dispatched synchronously on `change` before
  // any close could drop it, and the already-dispatched send lands in
  // storage afterwards. Drag ticks before it persisted nothing (by design).
  const storage = createFakeStorage({
    'site:youtube.com': { enabled: true, gainDb: 0, seq: 0, mirror: true },
  });
  const bg = loadBackground(storage);
  let dispatchCount = 0;
  const runtimeSendMessage = async (msg) => {
    if (msg.type === 'GET_SITE_STATE') return bg.sendMessage(msg);
    if (msg.type === 'SET_SITE_STATE') { dispatchCount++; return bg.sendMessage(msg); }
    return bg.sendMessage(msg);
  };
  const popup = loadPopup({
    tabUrl: 'https://youtube.com/watch',
    runtimeSendMessage,
    tabsSendMessage: async () => ({ ok: true, enabled: true, hostname: 'youtube.com', siteKey: 'youtube.com', gainDb: 0, hookAlive: false, hookActive: false, activating: false, lastError: '', indicator: 'gray' }),
  });
  await settle(50);
  assert.equal(popup.unloadHandlers.length, 0, 'no flush-on-close handler exists by design');
  // Drag ticks preview without persisting.
  popup.els['gain-slider'].disabled = false;
  popup.els.toggle.checked = true;
  popup.els['gain-slider'].value = '2';
  await popup.els['gain-slider'].fire('input');
  popup.els['gain-slider'].value = '6';
  await popup.els['gain-slider'].fire('input');
  assert.equal(dispatchCount, 0, 'drag ticks dispatch no persist');
  // Release dispatches synchronously: the intent leaves the popup before
  // any close could drop it.
  popup.els['gain-slider'].value = '6';
  const f = popup.els['gain-slider'].fire('change');
  // Prevent unhandled rejection noise; the popup context is about to go away.
  f.catch(() => {});
  assert.ok(dispatchCount >= 1, 'release dispatches the persist synchronously before close');
  // Simulated teardown: further sends fail and timers are cleared, but the
  // vm context itself stays alive (see note above). The already-dispatched
  // intent is in flight to the background and must land.
  popup.sandbox.chrome.runtime.sendMessage = async () => { throw new Error('popup closed'); };
  popup.intervals.length = 0;
  // Deliberately do NOT await f: the context is gone. Await only the
  // background/storage side, like a closed popup would.
  await settle(80);
  const stored = await storage.get(['site:youtube.com']);
  assert.equal(stored['site:youtube.com'].gainDb, 6, 'release value lands in storage after simulated teardown');
});

test('defect3c: reset is a single storage write carrying gain alone', async () => {
  const storage = createFakeStorage({
    'site:youtube.com': { enabled: true, gainDb: 6, seq: 1, mirror: true },
  });
  const bg = loadBackground(storage);
  const runtimeSendMessage = async (msg) => bg.sendMessage(msg);
  const popup = loadPopup({
    tabUrl: 'https://youtube.com/watch',
    runtimeSendMessage,
    tabsSendMessage: async (tabId, msg) => {
      if (msg?.type === 'GET_DOCUMENT_STATUS') return { ok: true, enabled: true, hostname: 'youtube.com', siteKey: 'youtube.com', gainDb: 6, hookAlive: false, hookActive: false, activating: false, lastError: '', indicator: 'gray' };
      return { ok: true };
    },
  });
  await settle(50);
  const writesBefore = storage._setCalls.length;
  popup.els['gain-slider'].disabled = false;
  popup.els.toggle.checked = true;
  await popup.els['reset-btn'].fire('click');
  await settle(60);
  const writes = storage._setCalls.slice(writesBefore).filter((w) => w['site:youtube.com']);
  assert.equal(writes.length, 1, `reset performs exactly ONE per-site storage write (got ${writes.length})`);
  const rec = writes[0]['site:youtube.com'];
  assert.equal(rec.gainDb, 0);
  assert.equal(rec.enabled, true, 'reset touches only gain, never enabled');
  assert.ok(Object.keys(writes[0]).length === 1 && writes[0]['site:youtube.com'], 'single top-level per-site key');
});

// ============ DEFECT 4: one logical update is one single-key storage write ============
test('defect4: an enabled change persists settings+mirror+sequence in one single-key write', async () => {
  const storage = createFakeStorage({
    'site:youtube.com': { enabled: false, gainDb: 0, seq: 0, mirror: false },
  });
  const bg = loadBackground(storage);
  const setCalls = [];
  const origSet = storage.set.bind(storage);
  storage.set = async (items) => { setCalls.push(items); return origSet(items); };
  const res = await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'youtube.com', tabId: 1, set: { enabled: true } });
  assert.equal(res.ok, true);
  assert.equal(setCalls.length, 1, 'one storage write — no crash window between settings, mirror and sequence');
  const keys = Object.keys(setCalls[0]);
  assert.equal(keys.length, 1, `single top-level key (got: ${keys})`);
  assert.ok(keys[0] === 'site:youtube.com', `per-site key (got: ${keys})`);
  const rec = setCalls[0]['site:youtube.com'];
  assert.equal(rec.enabled, true);
  assert.equal(rec.mirror, true, 'mirror rides in the same value');
  assert.equal(rec.seq, 1, 'sequence rides in the same value (background-assigned increment)');
});

// ============ DEFECT 5: whole-map clobber is impossible by construction ============
test('defect5: concurrent writes to different sites from separate contexts never clobber', async () => {
  const storage = createFakeStorage({
    'site:a.com': { enabled: true, gainDb: 1, seq: 0, mirror: true },
    'site:b.com': { enabled: false, gainDb: 0, seq: 0, mirror: false },
  }, { delayMs: 15 });
  const bgA = loadBackground(storage);
  const bgB = loadBackground(storage);
  const [ra, rb] = await Promise.all([
    bgA.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'a.com', tabId: 1, set: { gainDb: 6 } }),
    bgB.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'b.com', tabId: 2, set: { enabled: true } }),
  ]);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
  const snap = await storage.get(null);
  assert.equal(snap['site:a.com'].gainDb, 6, 'site A gain survives');
  assert.equal(snap['site:a.com'].enabled, true, 'site A enabled untouched');
  assert.equal(snap['site:b.com'].enabled, true, 'site B enable survives');
  assert.equal(snap['site:b.com'].gainDb, 0, 'site B gain untouched');
});

// ============ NEW: same-site stale-field overwrite (two popups, different fields) ============
test('same-site stale-field: two popups changing different fields overlap and both land', async () => {
  // Platform fact under test: storage.local.set REPLACES the whole value
  // under a top-level key (no deep merge). A bare partial set would drop the
  // sibling field; the owner must read-modify-write the WHOLE record through
  // the serialised chain. Slow storage forces the two read-modify-writes to
  // overlap: without serialisation the second write would clobber the first.
  const storage = createFakeStorage({
    'site:youtube.com': { enabled: true, gainDb: 0, seq: 0, mirror: true },
  }, { delayMs: 20 });
  const bg = loadBackground(storage);
  const runtime = async (msg) => bg.sendMessage(msg);
  const tabsStub = async () => ({ ok: true });
  const pGain = loadPopup({ tabUrl: 'https://youtube.com/watch', runtimeSendMessage: runtime, tabsSendMessage: tabsStub });
  const pToggle = loadPopup({ tabUrl: 'https://youtube.com/watch', runtimeSendMessage: runtime, tabsSendMessage: tabsStub });
  await settle(80);
  // Overlap without awaiting: the enabled save starts while the gain save's
  // storage round-trip is still in flight. A snapshot sender would include
  // its stale copy of the other field and the second arrival would revert
  // the first; field-level intents through the chain must both survive.
  const f1 = vm.runInContext('saveGainInner(6)', pGain.sandbox);
  pToggle.els.toggle.checked = false;
  const f2 = pToggle.els.toggle.fire('change');
  await Promise.all([f1, f2]);
  await settle(80);
  const stored = await storage.get(['site:youtube.com']);
  assert.equal(stored['site:youtube.com'].gainDb, 6, 'gain intent lands despite overlap');
  assert.equal(stored['site:youtube.com'].enabled, false, 'enabled intent lands alongside it despite overlap');
  // Reverse overlapping order must also converge to both.
  pToggle.els.toggle.checked = true;
  const r1 = pToggle.els.toggle.fire('change');
  const r2 = vm.runInContext('saveGainInner(3)', pGain.sandbox);
  await Promise.all([r1, r2]);
  await settle(80);
  const stored2 = await storage.get(['site:youtube.com']);
  assert.equal(stored2['site:youtube.com'].gainDb, 3);
  assert.equal(stored2['site:youtube.com'].enabled, true);
});

test('toggle sends a field-level intent carrying only enabled (no stale snapshot)', async () => {
  const seen = [];
  const runtimeSendMessage = async (msg) => {
    if (msg.type === 'GET_SITE_STATE') return { ok: true, enabled: true, gainDb: 6, siteKey: 'youtube.com', seq: 1 };
    if (msg.type === 'SET_SITE_STATE') { seen.push({ ...msg }); return { ok: true, enabled: false, gainDb: 6, siteKey: 'youtube.com', seq: 2 }; }
    return { ok: true };
  };
  const popup = loadPopup({
    tabUrl: 'https://www.youtube.com/watch?v=1',
    runtimeSendMessage,
    tabsSendMessage: async () => ({ ok: true }),
  });
  await settle(50);
  // A sibling popup may have changed gain newer than this
  // popup's cache. The toggle must not carry it: only `enabled`.
  popup.els.toggle.checked = false;
  await popup.els.toggle.fire('change');
  await settle(20);
  const sets = seen.filter((m) => m.type === 'SET_SITE_STATE');
  assert.equal(sets.length, 1, 'toggle dispatches exactly one intent');
  assert.deepEqual({ ...sets[0].set }, { enabled: false }, 'toggle intent carries ONLY enabled (no stale gain snapshot)');
  assert.ok(!('gainDb' in sets[0]) && !('enabled' in sets[0]) && !('seq' in sets[0]), 'no top-level snapshot fields and no popup sequence');
  assert.ok(!('at' in sets[0]) && !('actionAt' in sets[0]), 'no wall-clock stamp is sent (clocks deleted)');
});

test('queued-actions end to end: sibling gain 6 survives a stale-slider disable from this popup', async () => {
  const storage = createFakeStorage({
    'site:youtube.com': { enabled: true, gainDb: 0, seq: 0, mirror: true },
  });
  const bg = loadBackground(storage);
  const runtime = async (msg) => bg.sendMessage(msg);
  const tabsStub = async () => ({ ok: true });
  const pA = loadPopup({ tabUrl: 'https://youtube.com/watch', runtimeSendMessage: runtime, tabsSendMessage: tabsStub });
  const pB = loadPopup({ tabUrl: 'https://youtube.com/watch', runtimeSendMessage: runtime, tabsSendMessage: tabsStub });
  await settle();
  // Popup A types gain 2; sibling popup B then saves gain 6 newer. Popup A
  // never re-reads, so its slider still shows the stale 2 — the disable must
  // not resurrect it.
  pA.els['gain-slider'].disabled = false;
  pA.els.toggle.checked = true;
  pA.els['gain-slider'].value = '2';
  await pA.els['gain-slider'].fire('change');
  pB.els['gain-slider'].disabled = false;
  pB.els.toggle.checked = true;
  pB.els['gain-slider'].value = '6';
  await pB.els['gain-slider'].fire('change');
  await settle(60);
  assert.equal(pA.els['gain-slider'].value, '2', 'popup A slider is stale (unaware of sibling gain 6)');
  pA.els.toggle.checked = false;
  await pA.els.toggle.fire('change');
  await settle(80);
  const stored = await storage.get(['site:youtube.com']);
  assert.equal(stored['site:youtube.com'].enabled, false, 'disable lands');
  assert.equal(stored['site:youtube.com'].gainDb, 6, 'sibling gain 6 survives the stale-slider disable');
});

// ============ NEW: queued actions are never lost (gain 2, gain 6 in flight, toggle off) ============
test('queued-actions: gain 6 survives when toggle off follows while saves are in flight', async () => {
  const storage = createFakeStorage({
    'site:youtube.com': { enabled: true, gainDb: 0, seq: 0, mirror: true },
  }, { delayMs: 20 });
  const bg = loadBackground(storage);
  // Fire gain 2, then gain 6 while the first is still in flight, then a
  // disable — without awaiting between them (immediate dispatch, no chain).
  // The disable carries ONLY enabled, so gain 6 (the later gain arrival)
  // survives underneath enabled:false. Last-accepted-write-wins: arrival
  // order decides, and the serialised chain preserves call order.
  const p1 = bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'youtube.com', tabId: 1, set: { gainDb: 2 } });
  const p2 = bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'youtube.com', tabId: 1, set: { gainDb: 6 } });
  const p3 = bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'youtube.com', tabId: 1, set: { enabled: false } });
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.ok(r1.ok && r2.ok && r3.ok, 'every arrival applies; nothing is rejected');
  const stored = await storage.get(['site:youtube.com']);
  assert.equal(stored['site:youtube.com'].enabled, false, 'disable lands');
  assert.equal(stored['site:youtube.com'].gainDb, 6, 'gain 6 survives the disable (arrival order, serialised)');
});

// ============ NEW: lossless legacy migration (www./subdomain-only) ============
test('legacy www-only siteSettings upgrade preserves gain', async () => {
  const storage = createFakeStorage({
    siteSettings: { 'www.youtube.com': { enabled: true, gainDb: 4 } },
  });
  const bg = loadBackground(storage);
  const got = await bg.sendMessage({ type: 'GET_SITE_STATE', hostname: 'youtube.com' });
  assert.equal(got.enabled, true, 'enabled survives normalisation');
  assert.equal(got.gainDb, 4, 'gain from www-only entry survives');
  // Content-script read path agrees (write-free).
  const frame = await loadContentFrame('https://music.youtube.com/watch', storage);
  await settle();
  const status = await frame.sendMessage({ type: 'GET_DOCUMENT_STATUS' });
  assert.equal(status.enabled, true);
  assert.equal(status.gainDb, 4);
});

test('legacy sibling-subdomain activeSites enables the canonical site', async () => {
  const storage = createFakeStorage({
    siteSettings: { 'www.youtube.com': { enabled: false, gainDb: 5 } },
    activeSites: { 'music.youtube.com': true },
  });
  const bg = loadBackground(storage);
  const got = await bg.sendMessage({ type: 'GET_SITE_STATE', hostname: 'youtube.com' });
  assert.equal(got.enabled, true, 'sibling-subdomain activeSites enables the canonical site');
  assert.equal(got.gainDb, 5, 'gain preserved alongside the enable');
});

test('legacy activeSites entries migrate into their own full-host keys', async () => {
  // Full-host semantics: `music.youtube.com` is its own site, so its legacy
  // enable migrates into `site:music.youtube.com` (consumed), while the
  // existing `site:youtube.com` record is untouched.
  const storage = createFakeStorage({
    'site:youtube.com': { enabled: false, gainDb: 1, seq: 3, mirror: false },
    activeSites: { 'music.youtube.com': true },
    siteSettings: {},
    siteToggles: {},
  });
  const bg = loadBackground(storage);
  await bg.runStartup();
  const after = await storage.get(null);
  assert.ok(!('music.youtube.com' in (after.activeSites || {})), 'consumed music.youtube.com cleared after migrating to its full key');
  assert.equal(after['site:music.youtube.com'].enabled, true, 'legacy enable migrated into its own full-host record');
  assert.equal(after['site:youtube.com'].enabled, false, 'existing full-host truth untouched');
});

test('mixed-schema startup injection covers legacy sites when per-site keys exist', async () => {
  const storage = createFakeStorage({
    'site:a.com': { enabled: true, gainDb: 1, seq: 1, mirror: true },
    siteSettings: { 'www.b.com': { enabled: true, gainDb: 2 } },
    activeSites: {},
    siteToggles: {},
  });
  const bg = loadBackground(storage);
  const tabA = { id: 21, url: 'https://a.com/watch' };
  const tabB = { id: 22, url: 'https://www.b.com/watch' };
  bg.sandbox.chrome.tabs.query = async (...args) => {
    const cb = args.find((a) => typeof a === 'function');
    const tabs = [tabA, tabB];
    if (cb) { try { cb(tabs); } catch {} return tabs; }
    return tabs;
  };
  bg.sandbox.chrome.tabs.get = async (id) => (id === 21 ? { ...tabA } : { ...tabB });
  // hasInjectedContentScript probes via tabs.sendMessage; answer ok:false so
  // syncExistingTabsForSite proceeds to inject both tabs.
  bg.sandbox.chrome.tabs.sendMessage = async (tabId, msg, options) => {
    bg.tabsSent.push({ tabId, msg, options });
    return { ok: false };
  };
  await bg.runStartup();
  const targets = bg.scriptingCalls.map((c) => c.target?.tabId).sort();
  assert.ok(targets.includes(21), `legacy-mixed startup injects per-site tab A (got ${targets})`);
  assert.ok(targets.includes(22), `legacy-mixed startup injects legacy-only tab B even though per-site keys exist (got ${targets})`);
  // And the legacy site was migrated losslessly.
  const gotB = await bg.sendMessage({ type: 'GET_SITE_STATE', hostname: 'b.com' });
  assert.equal(gotB.enabled, true);
  assert.equal(gotB.gainDb, 2);
});

// ============ PRESERVED GUARANTEES ============
test('preserved: legacy activeSites migrates into per-site keys then clears consumed, never dropped', async () => {
  const storage = createFakeStorage({
    siteSettings: { 'youtube.com': { enabled: true, gainDb: 4 } },
    activeSites: { 'music.youtube.com': true, 'legacy.example': true },
    siteToggles: { 'youtube.com': false },
  });
  const bg = loadBackground(storage);
  const got = await bg.sendMessage({ type: 'GET_SITE_STATE', hostname: 'youtube.com' });
  assert.equal(got.enabled, false, 'explicit mirror-off repairs stored enabled:true once');
  assert.equal(got.gainDb, 4, 'gain preserved through migration');
  const snap = await storage.get(null);
  assert.equal(snap['site:youtube.com'].enabled, false, 'migrated per-site record persisted');
  assert.equal(snap['site:youtube.com'].gainDb, 4);
  await bg.runStartup();
  const after = await storage.get(null);
  assert.ok(!('music.youtube.com' in (after.activeSites || {})), 'consumed music.youtube.com cleared (already reflected in per-site)');
  assert.ok(!('legacy.example' in (after.activeSites || {})), 'consumed legacy.example cleared (migrated to its own per-site key)');
  assert.deepEqual(after.activeSites || {}, {}, 'all consumed entries cleared; un-consumed preservation is covered by the dedicated test');
  await storage.set({ siteToggles: { 'youtube.com': false } });
  const got2 = await bg.sendMessage({ type: 'GET_SITE_STATE', hostname: 'youtube.com' });
  assert.equal(got2.enabled, false, 'read prefers the per-site record over a stale legacy mirror');
});

test('delayed disable broadcast never stops a re-enabled tab (stale broadcast ignored)', async () => {
  const storage = createFakeStorage({
    'site:youtube.com': { enabled: true, gainDb: 2, seq: 1, mirror: true },
  });
  const bg = loadBackground(storage);
  const frame = await loadContentFrame('https://youtube.com/watch', storage);
  await settle();
  // Stored truth says enabled:true. A delayed disable broadcast arriving now
  // is stale and must not stop the live hook: the receiver re-reads storage.
  frame.postedToPage.length = 0;
  const res = await frame.sendMessage({ type: 'TOGGLE_CHANGED', siteKey: 'youtube.com', enabled: false });
  assert.equal(res.ok, true);
  await settle(80);
  const status = await frame.sendMessage({ type: 'GET_DOCUMENT_STATUS' });
  assert.equal(status.enabled, true, 'stale disable does not disable a stored-enabled tab');
  const stops = frame.postedToPage.filter((m) => m.type === 'STOP');
  assert.equal(stops.length, 0, 'stale disable posts no STOP to the live hook');
  // A genuine disable (stored says disabled) still stops.
  await storage.set({ 'site:youtube.com': { enabled: false, gainDb: 2, seq: 2, mirror: false } });
  await settle(80);
  const res2 = await frame.sendMessage({ type: 'TOGGLE_CHANGED', siteKey: 'youtube.com', enabled: false });
  assert.equal(res2.ok, true);
  await settle(80);
  const stops2 = frame.postedToPage.filter((m) => m.type === 'STOP');
  assert.ok(stops2.length > 0, 'genuine disable still stops the hook');
});

test('background broadcast re-reads stored truth before sending (delayed query)', async () => {
  const storage = createFakeStorage({
    'site:youtube.com': { enabled: true, gainDb: 0, seq: 1, mirror: true },
  });
  const bg = loadBackground(storage);
  const matchingTab = { id: 31, url: 'https://youtube.com/watch' };
  // Delay the tabs.query callback so the disable change is already stale
  // (re-enabled) by the time the query returns.
  bg.sandbox.chrome.tabs.query = (...args) => {
    const cb = args.find((a) => typeof a === 'function');
    if (cb) {
      setTimeout(() => { try { cb([matchingTab]); } catch {} }, 30);
      return [];
    }
    return Promise.resolve([matchingTab]);
  };
  // Disable then quickly re-enable before the delayed query fires.
  await storage.set({ 'site:youtube.com': { enabled: false, gainDb: 0, seq: 2, mirror: false } });
  await storage.set({ 'site:youtube.com': { enabled: true, gainDb: 0, seq: 3, mirror: true } });
  await settle(80);
  assert.ok(bg.tabsSent.length > 0, 'broadcast sent after delayed query');
  for (const c of bg.tabsSent) {
    assert.equal(c.msg.enabled, true, 'delayed disable is corrected to current stored truth (enabled:true)');
    assert.equal(c.options, undefined, 'broadcast still reaches every frame (no frameId filter)');
  }
});

test('popup reset renders the returned truth, never the sent values', async () => {
  // Reset sends {gainDb:0} but must DISPLAY what the
  // background returned. A stub that returns different stored truth (e.g. a
  // concurrent sibling write landed first) must win on screen.
  const runtimeSendMessage = async (msg) => {
    if (msg.type === 'GET_SITE_STATE') return { ok: true, enabled: true, gainDb: 6, siteKey: 'youtube.com', seq: 3 };
    if (msg.type === 'SET_SITE_STATE') return { ok: true, enabled: true, gainDb: 4, siteKey: 'youtube.com', seq: 4 };
    return { ok: true };
  };
  const popup = loadPopup({
    tabUrl: 'https://www.youtube.com/watch?v=1',
    runtimeSendMessage,
    tabsSendMessage: async (tabId, msg) => {
      if (msg?.type === 'GET_DOCUMENT_STATUS') return { ok: true, enabled: true, hostname: 'youtube.com', siteKey: 'youtube.com', gainDb: 6, hookAlive: false, hookActive: false, activating: false, lastError: '', indicator: 'gray' };
      return { ok: true };
    },
  });
  await settle(50);
  popup.els['gain-slider'].disabled = false;
  popup.els.toggle.checked = true;
  await popup.els['reset-btn'].fire('click');
  await settle(20);
  assert.equal(popup.els['gain-slider'].value, '4', 'reset displays the returned gain, not the sent 0');
});

test('popup treats a truth-less response as a failure, not a success', async () => {
  const truth = { ok: true, enabled: true, gainDb: 3, siteKey: 'youtube.com', seq: 7 };
  let calls = 0;
  const popup = loadPopup({
    tabUrl: 'https://www.youtube.com/watch?v=1',
    runtimeSendMessage: async (msg) => {
      if (msg.type === 'GET_SITE_STATE') {
        // First init call returns truth; the recovery re-read after the
        // failed save also returns truth so the revert path is exercised.
        if (calls === 0) return { ...truth };
        return { ...truth };
      }
      if (msg.type === 'SET_SITE_STATE') { calls++; return { ok: true, siteKey: 'youtube.com', seq: 8 }; }
      return { ok: true };
    },
    tabsSendMessage: async (tabId, msg) => {
      if (msg?.type === 'GET_DOCUMENT_STATUS') {
        return { ok: true, enabled: true, hostname: 'www.youtube.com', siteKey: 'youtube.com', gainDb: 3, hookAlive: false, hookActive: false, activating: false, lastError: '', indicator: 'gray' };
      }
      return { ok: true };
    },
  });
  await settle(50);
  assert.equal(popup.els.toggle.checked, true);
  popup.els['gain-slider'].disabled = false;
  popup.els.toggle.checked = true;
  popup.els['gain-slider'].value = '6';
  await popup.els['gain-slider'].fire('change');
  await settle(50);
  // Gain 6 was never acknowledged with stored truth, so the control reverts
  // to the stored 3 and the status line says so.
  assert.equal(popup.els['gain-slider'].value, '3', 'control reverts when the response carries no stored truth');
  assert.match(popup.els['status-text'].textContent, /revert|could not save/i);
});

test('background broadcast fails closed when its own re-read fails', async () => {
  const storage = createFakeStorage({
    'site:youtube.com': { enabled: true, gainDb: 2, seq: 1, mirror: true },
  });
  const bg = loadBackground(storage);
  const matchingTab = { id: 31, url: 'https://youtube.com/watch' };
  bg.sandbox.chrome.tabs.query = (...args) => {
    const cb = args.find((a) => typeof a === 'function');
    if (cb) { try { cb([matchingTab]); } catch {} return []; }
    return Promise.resolve([matchingTab]);
  };
  // Break the re-read: every get rejects, so the background cannot establish
  // current truth. Fail closed means no broadcast at all — never the
  // captured (possibly stale) change as a fallback.
  const origGet = storage.get.bind(storage);
  storage.get = async () => { throw new Error('read failed (simulated)'); };
  bg.tabsSent.length = 0;
  await storage.set({ 'site:youtube.com': { enabled: false, gainDb: 2, seq: 2, mirror: false } });
  await settle(60);
  storage.get = origGet;
  assert.equal(bg.tabsSent.length, 0, 'no broadcast without established truth (fail closed)');
});

test('a clock jump cannot freeze a field (structurally impossible)', async () => {
  // Structural proof: no source file compares a write against a stored
  // maximum anymore. A future-dated `at` stamp is dead data — ignored, never
  // persisted — so it cannot lock a field "until the wall clock catches up".
  const bgSrc = src('background.js');
  const sharedSrc = src('shared.js');
  const popupSrc = src('popup.js');
  for (const [name, body] of [['background.js', bgSrc], ['shared.js', sharedSrc], ['popup.js', popupSrc]]) {
    assert.ok(!/atEnabled|atGain|atGuard|normalizeActionTime|extractActionTime|incomingAt/.test(body), `${name} compares nothing against a stored timestamp maximum`);
  }
  assert.ok(!/\bnewValue\b.*\bcurrent\b|\bcurrent\s*=\s*newRec\b/.test(bgSrc), 'background never falls back to a captured change on read failure');
  // Behavioral proof: a write carrying a bogus future stamp lands (ignored),
  // and the very next ordinary write to the same field lands too — the field
  // is not frozen.
  const storage = createFakeStorage({
    'site:youtube.com': { enabled: true, gainDb: 0, seq: 0, mirror: true },
  });
  const bg = loadBackground(storage);
  const future = await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'youtube.com', tabId: 1, set: { gainDb: 6 }, at: 9999999999999, actionAt: 9999999999999 });
  assert.equal(future.ok, true, 'future-stamped write is accepted (stamp ignored)');
  const snap = await storage.get(['site:youtube.com']);
  assert.equal(snap['site:youtube.com'].gainDb, 6, 'future-stamped write lands');
  assert.ok(!('at' in snap['site:youtube.com']), 'future stamp is not persisted');
  const next = await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'youtube.com', tabId: 1, set: { gainDb: 2 } });
  assert.equal(next.ok, true, 'next write is accepted too');
  const stored = await storage.get(['site:youtube.com']);
  assert.equal(stored['site:youtube.com'].gainDb, 2, 'field is not frozen by the earlier future stamp');
});

test('sequential same-field writes: later arrival wins (arrival order, no clocks)', async () => {
  const storage = createFakeStorage({
    'site:youtube.com': { enabled: true, gainDb: 0, seq: 0, mirror: true },
  });
  const bg = loadBackground(storage);
  // No timestamps exist. Each arrival applies; the later arrival holds the field.
  const first = await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'youtube.com', tabId: 1, set: { gainDb: 2 } });
  assert.equal(first.ok, true, 'first arrival applies');
  assert.equal(first.seq, 1);
  const second = await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'youtube.com', tabId: 1, set: { gainDb: 6 } });
  assert.equal(second.ok, true, 'second arrival applies; nothing rejected');
  assert.equal(second.seq, 2);
  const stored = await storage.get(['site:youtube.com']);
  assert.equal(stored['site:youtube.com'].gainDb, 6, 'later arrival wins');
  // And the reverse arrival order wins the other way.
  const third = await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'youtube.com', tabId: 1, set: { gainDb: 2 } });
  assert.equal(third.ok, true);
  assert.equal(third.seq, 3);
  const stored2 = await storage.get(['site:youtube.com']);
  assert.equal(stored2['site:youtube.com'].gainDb, 2, 'reversed arrival order wins the other way');
});

test('delayed earlier message still wins on arrival (documented trade, reviewer trace inverted)', async () => {
  // Old reviewer trace, decided outcome inverted: with no clocks the
  // background cannot tell that A's gain-2 action predates B's gain-6 action.
  // B arrives first and writes 6; A's delayed message arrives later and
  // overwrites with 2. That is the accepted trade — later arrival wins —
  // not a defect. The wall-clock alternative froze the field instead.
  const storage = createFakeStorage({
    'site:youtube.com': { enabled: true, gainDb: 0, seq: 0, mirror: true },
  });
  const bg = loadBackground(storage);
  const newerFirst = await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'youtube.com', tabId: 2, set: { gainDb: 6 } });
  assert.ok(newerFirst.ok);
  assert.equal((await storage.get(['site:youtube.com']))['site:youtube.com'].gainDb, 6);
  const olderLate = await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'youtube.com', tabId: 1, set: { gainDb: 2 } });
  assert.ok(olderLate.ok, 'delayed arrival is accepted, never rejected');
  const stored = await storage.get(['site:youtube.com']);
  assert.equal(stored['site:youtube.com'].gainDb, 2, 'later arrival (older action) wins: documented trade');
  assert.equal(stored['site:youtube.com'].seq, 2, 'every arrival bumps the audit counter');
});

test('interruption around an outstanding write still converges (simulated overlap)', async () => {
  // SIMULATION, not a true interruption: the harness fires two ordinary
  // overlapping messages against slow fake storage and awaits both. No VM is
  // torn down and no browser event interrupts anything — the name says
  // "simulated overlap" so it does not claim more than it does.
  const storage = createFakeStorage({
    'site:youtube.com': { enabled: true, gainDb: 0, seq: 0, mirror: true },
  }, { delayMs: 25 });
  const bg = loadBackground(storage);
  // A gain write is outstanding (slow storage) when a disable overlaps it.
  // Both arrivals apply through the serialised chain; neither is lost.
  const gainP = bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'youtube.com', tabId: 1, set: { gainDb: 6 } });
  const disableP = bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'youtube.com', tabId: 1, set: { enabled: false } });
  const [gr, dr] = await Promise.all([gainP, disableP]);
  assert.ok(gr.ok, 'outstanding gain lands');
  assert.ok(dr.ok, 'overlapping disable lands');
  const stored = await storage.get(['site:youtube.com']);
  assert.equal(stored['site:youtube.com'].enabled, false, 'disable survives overlap');
  assert.equal(stored['site:youtube.com'].gainDb, 6, 'gain survives overlap around the outstanding write');
});

test('migration write failure does not abort startup re-injection (isolated, reported)', async () => {
  const storage = createFakeStorage({
    'site:a.com': { enabled: true, gainDb: 1, seq: 1, mirror: true },
    activeSites: { 'b.com': true },
    siteSettings: {},
    siteToggles: {},
  });
  const bg = loadBackground(storage);
  const tabA = { id: 41, url: 'https://a.com/watch' };
  const tabB = { id: 42, url: 'https://b.com/watch' };
  bg.sandbox.chrome.tabs.query = async (...args) => {
    const cb = args.find((a) => typeof a === 'function');
    const tabs = [tabA, tabB];
    if (cb) { try { cb(tabs); } catch {} return tabs; }
    return tabs;
  };
  bg.sandbox.chrome.tabs.get = async (id) => (id === 41 ? { ...tabA } : { ...tabB });
  bg.sandbox.chrome.tabs.sendMessage = async (tabId, msg, options) => {
    bg.tabsSent.push({ tabId, msg, options });
    return { ok: false };
  };
  // Fail ONLY the migration's activeSites clear (quota exhaustion): every set
  // carrying `activeSites` rejects, per-site sets succeed.
  const origSet = storage.set.bind(storage);
  storage.set = async (items) => {
    if (items && Object.prototype.hasOwnProperty.call(items, 'activeSites')) {
      throw new Error('quota exceeded (simulated migration failure)');
    }
    return origSet(items);
  };
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warnings.push(a.join(' ')); };
  try {
    await bg.runStartup();
  } finally {
    console.warn = origWarn;
  }
  const targets = bg.scriptingCalls.map((c) => c.target?.tabId).sort();
  assert.ok(targets.includes(41), `injection still runs for per-site tab A despite migration failure (got ${targets})`);
  assert.ok(targets.includes(42), `injection still runs for legacy tab B despite migration failure (got ${targets})`);
  assert.ok(warnings.some((w) => /migration failed/i.test(w)), `migration failure is reported, not swallowed (got ${JSON.stringify(warnings).slice(0, 200)})`);
});

test('migration merges two raw keys that normalise to one site (no field loss)', async () => {
  const storage = createFakeStorage({
    siteSettings: {
      'youtube.com': { enabled: true, gainDb: 5 },
      'www.youtube.com': { enabled: true },
    },
    activeSites: {},
    siteToggles: {},
  });
  const bg = loadBackground(storage);
  const got = await bg.sendMessage({ type: 'GET_SITE_STATE', hostname: 'youtube.com' });
  assert.equal(got.enabled, true);
  assert.equal(got.gainDb, 5, 'first raw key gain survives the collapse (second carries no gain)');
});

test('preserved: content script performs zero storage writes (background is the single writer)', async () => {
  const storage = createFakeStorage({
    'site:example.com': { enabled: true, gainDb: 0, seq: 0, mirror: true },
    siteSettings: {},
    activeSites: { 'legacy.example': true },
  });
  let writes = 0;
  const origSet = storage.set.bind(storage);
  storage.set = async (...a) => { writes++; return origSet(...a); };
  const frame = await loadContentFrame('https://example.com/embed', storage);
  await settle();
  assert.equal(writes, 0, 'init sync with legacy keys present writes nothing');
  const res = await frame.sendMessage({ type: 'SET_DOCUMENT_STATE', siteKey: 'example.com', enabled: true, gainDb: 6 });
  await settle();
  assert.equal(res.ok, true);
  assert.equal(writes, 0, 'document-state path reaches no storage write');
  // Transient session path is read-only too: it installs a live override,
  // never a persisted write.
  const res2 = await frame.sendMessage({ type: 'SET_DOCUMENT_STATE', siteKey: 'example.com', enabled: false, transient: true });
  await settle();
  assert.equal(res2.ok, true);
  assert.equal(writes, 0, 'transient document-state path writes nothing');
  const stored = await storage.get(['site:example.com', 'activeSites']);
  assert.deepEqual(stored['site:example.com'], { enabled: true, gainDb: 0, seq: 0, mirror: true }, 'stored truth untouched by transient apply');
  assert.ok('legacy.example' in stored.activeSites, 'legacy keys left for the background single writer');

  // FINAL RULE: a document that loaded with the site OFF installs no listener
  // at all, so it cannot even reach the read-only paths above.
  const offStorage = createFakeStorage({
    'site:quiet.example': { enabled: false, gainDb: 0, seq: 0, mirror: false },
  });
  const offFrame = await loadContentFrame('https://quiet.example/embed', offStorage);
  await settle(60);
  assert.equal(offFrame.runtimeListeners(), 0, 'a site that loads off does no work');
  assert.equal(offFrame.storageListeners.length, 1, 'and keeps only the inert storage surface');
});

test('preserved: every message-type name still has a working read path', async () => {
  const storage = createFakeStorage({
    'site:youtube.com': { enabled: true, gainDb: 2, seq: 1, mirror: true },
  });
  const bg = loadBackground(storage);
  const frame = await loadContentFrame('https://youtube.com/watch', storage);
  await settle();
  for (const msg of [
    { type: 'GET_SITE_STATE', hostname: 'youtube.com' },
    { type: 'SET_SITE_STATE', siteKey: 'youtube.com', tabId: 1, set: { gainDb: 3 } },
    { type: 'TOGGLE_SITE', hostname: 'youtube.com' },
    { type: 'SOFT_RECHECK_DOCUMENT', siteKey: 'youtube.com', tabId: 1 },
  ]) {
    const r = await bg.sendMessage(msg);
    assert.ok(r && typeof r.ok === 'boolean', `${msg.type} still handled (got ${JSON.stringify(r)?.slice(0, 80)})`);
    assert.ok(!(typeof r.error === 'string' && r.error.startsWith('Unknown')), `${msg.type} is known`);
  }
  // Legacy top-level shape still accepted (backward compat when `set` absent).
  const legacyRes = await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'youtube.com', tabId: 1, gainDb: 4 });
  assert.ok(legacyRes.ok, 'legacy top-level SET_SITE_STATE still has a read path');
  for (const msg of [
    { type: 'GET_DOCUMENT_STATUS' },
    { type: 'SET_DOCUMENT_STATE', siteKey: 'youtube.com', enabled: true },
    { type: 'SOFT_RECHECK_DOCUMENT' },
    { type: 'CLEAR_SESSION_OVERRIDE' },
    { type: 'TOGGLE_CHANGED', siteKey: 'youtube.com', enabled: true },
  ]) {
    const r = await frame.sendMessage(msg);
    assert.ok(r && typeof r.ok === 'boolean', `${msg.type} still handled`);
  }
});

test('preserved: failed writes revert instead of looking successful (truthful recovery)', async () => {
  const truth = { ok: true, enabled: true, gainDb: 3, siteKey: 'youtube.com', seq: 7 };
  const popup = loadPopup({
    tabUrl: 'https://www.youtube.com/watch?v=1',
    runtimeSendMessage: async (msg) => {
      if (msg.type === 'GET_SITE_STATE') return { ...truth };
      if (msg.type === 'SET_SITE_STATE') return { ok: false, error: 'boom' };
      return { ok: true };
    },
    tabsSendMessage: async (tabId, msg) => {
      if (msg?.type === 'GET_DOCUMENT_STATUS') {
        return { ok: true, enabled: true, hostname: 'www.youtube.com', siteKey: 'youtube.com', gainDb: 3, hookAlive: false, hookActive: false, activating: false, lastError: '', indicator: 'gray' };
      }
      return { ok: true };
    },
  });
  await settle(50);
  assert.equal(popup.els.toggle.checked, true);
  popup.els.toggle.checked = false;
  await popup.els.toggle.fire('change');
  await settle(50);
  assert.equal(popup.els.toggle.checked, true, 'control reverts to stored truth on failure');
  assert.match(popup.els['status-text'].textContent, /revert|Could not save/i);
});

test('no product writer can re-create a mirror/settings diverge (recurrence path closed)', async () => {
  // Owner's bug class: `siteToggles[site] = false` while the per-site record
  // says `enabled: true`, mirror newer — the reported "auto-enable". The
  // whole-map `siteToggles` writer (`shared.saveSiteState`) had zero callers
  // but was one popup-path call away from re-creating the diverge after the
  // migration repaired it. It is deleted; this test fails if a legacy-map
  // write ever returns to product code. The orphaned helpers around it —
  // `loadSiteState`, the `storageGet`/`storageSet` passthroughs, and
  // `reconcileMirrorIntoSettings` — had zero product callers and are deleted
  // too; `migrateLegacyToRecord` is the surviving read-only migration.
  const productFiles = ['background.js', 'content-script.js', 'popup.js', 'shared.js'];
  const bodies = Object.fromEntries(productFiles.map((f) => [f, src(f)]));
  // (1) The shipped API exposes no mirror writer and no orphaned helpers.
  assert.equal(typeof sharedApi.saveSiteState, 'undefined', 'saveSiteState writer deleted from the shipped API');
  assert.equal(typeof sharedApi.loadSiteState, 'undefined', 'loadSiteState had zero callers (deleted)');
  assert.equal(typeof sharedApi.storageGet, 'undefined', 'storageGet had zero callers outside loadSiteState (deleted)');
  assert.equal(typeof sharedApi.storageSet, 'undefined', 'storageSet had zero callers (deleted)');
  assert.equal(typeof sharedApi.reconcileMirrorIntoSettings, 'undefined', 'reconcileMirrorIntoSettings had zero callers (deleted)');
  assert.equal(typeof sharedApi.migrateLegacyToRecord, 'function', 'read-only migration preserved');
  // (2) Every storage write in product code carries ONLY a per-site key or the
  // startup `activeSites` clear. No write may name `siteToggles` /
  // `siteSettings` / `siteSeq`.
  const allowedWriteArg = /storage\.local\.set\s*\(\s*(\{\s*\[perKey\]|\{\s*activeSites\b)/;
  for (const [name, body] of Object.entries(bodies)) {
    const writeRe = /storage\.local\.set\s*\(/g;
    let m;
    let count = 0;
    while ((m = writeRe.exec(body))) {
      count++;
      const window = body.slice(m.index, m.index + 80);
      assert.ok(
        allowedWriteArg.test(window),
        `${name} storage write must be per-site/activeSites-only, got: ${JSON.stringify(window.slice(0, 80))}`,
      );
      assert.ok(
        !/siteToggles|siteSettings|siteSeq/.test(window),
        `${name} storage write must not carry a legacy map, got: ${JSON.stringify(window.slice(0, 80))}`,
      );
    }
    if (name === 'background.js') assert.ok(count > 0, 'background write scan is live (found writes)');
  }
  // (3) Every legacy READ shape is preserved, so an existing store still
  // migrates losslessly: `get` keys, the `changes.siteToggles` listeners,
  // and the migration call sites.
  assert.ok(bodies['background.js'].includes("'activeSites'"), 'background still reads the legacy maps');
  assert.ok(bodies['background.js'].includes('changes.siteToggles'), 'background siteToggles listener preserved');
  assert.ok(bodies['content-script.js'].includes("'siteToggles'"), 'content script still reads the legacy mirror');
  assert.ok(bodies['content-script.js'].includes('migrateLegacyToRecord'), 'content-script migration read path preserved');
});

test('legacy-only store (siteSettings/siteToggles/activeSites, no per-site key) migrates and applies', async () => {
  // The exact pre-upgrade shape: no `site:<key>` record exists, only the
  // three legacy maps. Must migrate losslessly and agree on both read paths.
  const storage = createFakeStorage({
    siteSettings: { 'www.youtube.com': { enabled: true, gainDb: 4 } },
    activeSites: { 'music.youtube.com': true },
    siteToggles: { 'youtube.com': false },
  });
  const bg = loadBackground(storage);
  const got = await bg.sendMessage({ type: 'GET_SITE_STATE', hostname: 'youtube.com' });
  assert.equal(got.enabled, false, 'explicit mirror-off wins enabled once (diverge repaired)');
  assert.equal(got.gainDb, 4, 'gain preserved from the www-only settings entry');
  const snap = await storage.get(null);
  assert.equal(snap['site:youtube.com'].enabled, false, 'migrated per-site record persisted');
  assert.equal(snap['site:youtube.com'].gainDb, 4);
  // Content-script read path agrees... by doing nothing: a document that loaded
  // with the site off installs no listener and performs no work, and the
  // background is the single writer.
  let writes = 0;
  const origSet = storage.set.bind(storage);
  storage.set = async (...a) => { writes++; return origSet(...a); };
  const frame = await loadContentFrame('https://music.youtube.com/watch', storage);
  await settle(60);
  assert.equal(frame.runtimeListeners(), 0, 'a disabled site installs no runtime listener');
  assert.equal(frame.storageListeners.length, 1, 'only the one inert storage surface');
  assert.equal(writes, 0, 'content-script read path writes nothing');
});

test('startup migration preserves the legacy audit sequence like the ordinary read path', async () => {
  // Identical legacy stores (settings + actives + toggles + siteSeq): the
  // ordinary GET_SITE_STATE read adopts siteSeq, and the startup migration
  // must yield the SAME sequence. Before the fix the startup write carried
  // seq 0 while the read carried 41.
  const mkStore = () => createFakeStorage({
    siteSettings: { 'youtube.com': { enabled: true, gainDb: 4 } },
    activeSites: { 'youtube.com': true },
    siteToggles: {},
    siteSeq: { 'youtube.com': 41 },
  });
  const bgRead = loadBackground(mkStore());
  const got = await bgRead.sendMessage({ type: 'GET_SITE_STATE', hostname: 'youtube.com' });
  assert.equal(got.seq, 41, 'ordinary read adopts the legacy siteSeq');
  const s2 = mkStore();
  const bgStart = loadBackground(s2);
  await bgStart.runStartup();
  const snap = await s2.get(null);
  assert.ok(snap['site:youtube.com'], 'startup migration persists a per-site record');
  assert.equal(snap['site:youtube.com'].seq, 41, 'startup migration adopts the same legacy siteSeq');
  assert.equal(snap['site:youtube.com'].gainDb, 4, 'settings survive alongside the sequence');
});
