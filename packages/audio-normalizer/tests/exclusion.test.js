const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
function src(name) { return fs.readFileSync(path.join(ROOT, name), 'utf8'); }
const sharedApi = require(path.join(ROOT, 'shared.js'));

async function settle(ms = 40) { await new Promise((r) => setTimeout(r, ms)); }
function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

// ---------- fake chrome.storage.local (per-site aware, onChanged wired) ----------
function createFakeStorage(initial = {}) {
  let store = clone(initial);
  let listeners = [];
  const setCalls = [];
  return {
    _store: () => clone(store),
    _setCalls: setCalls,
    _listenerCount: () => listeners.length,
    async get(keys) {
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
    onChanged: {
      addListener(fn) { listeners.push(fn); },
      removeListener(fn) { listeners = listeners.filter((entry) => entry !== fn); },
    },
  };
}

// ---------- fake chrome.scripting with a live registration registry ----------
function createFakeScripting() {
  const registered = new Map();
  const calls = { execute: [], register: [], update: [], unregister: [] };
  let failNextRegister = null;
  let failNextUpdate = null;
  const api = {
    executeScript: async (opts) => {
      calls.execute.push({
        ...clone(opts),
        // JSON drops functions: keep the name so a test can prove WHICH
        // function the worker injects (gate, presence probe, hook teardown).
        funcName: opts.func ? opts.func.name : null,
        files: opts.files ? opts.files.slice() : null,
      });
      return [];
    },
    getRegisteredContentScripts: async (filter) => {
      let list = Array.from(registered.values());
      if (filter && filter.ids) list = list.filter((s) => filter.ids.includes(s.id));
      return clone(list);
    },
    registerContentScripts: async (scripts) => {
      if (failNextRegister) {
        const message = failNextRegister;
        failNextRegister = null;
        throw new Error(message);
      }
      calls.register.push(clone(scripts));
      for (const s of scripts) registered.set(s.id, clone(s));
    },
    updateContentScripts: async (scripts) => {
      if (failNextUpdate) {
        const message = failNextUpdate;
        failNextUpdate = null;
        throw new Error(message);
      }
      calls.update.push(clone(scripts));
      for (const s of scripts) registered.set(s.id, clone(s));
    },
    unregisterContentScripts: async (filter) => {
      calls.unregister.push(clone(filter) || null);
      if (filter && filter.ids) for (const id of filter.ids) registered.delete(id);
      else registered.clear();
    },
  };
  return {
    api,
    registered,
    calls,
    failNextRegister(message) { failNextRegister = message; },
    failNextUpdate(message) { failNextUpdate = message; },
  };
}

// ---------- background harness (real background.js through vm) ----------
function loadBackground(storage, { tabUrl = 'https://example.com/', scripting = createFakeScripting(), log = console } = {}) {
  const runtimeListeners = [];
  const tabsSent = [];
  const tab = { id: 7, url: tabUrl };
  let onStartupFn = null;
  let onInstalledFn = null;
  const sandbox = {
    console: log,
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
        onInstalled: { addListener: (fn) => { onInstalledFn = fn; } },
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
      scripting: scripting.api,
    },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.importScripts = () => {
    sandbox.self.TabNormalizerShared = sharedApi;
    sandbox.TabNormalizerShared = sharedApi;
  };
  vm.createContext(sandbox);
  vm.runInContext(src('background.js'), sandbox, { filename: 'background.js' });
  if (runtimeListeners.length === 0) throw new Error('background did not register onMessage');
  const sendMessage = (message, sender = {}) => new Promise((resolve) => {
    const ret = runtimeListeners[0](message, sender, resolve);
    if (ret !== true) resolve(undefined);
  });
  return {
    sandbox,
    sendMessage,
    tabsSent,
    scripting,
    runStartup: async () => { if (onStartupFn) await onStartupFn(); },
    runInstalled: async () => { if (onInstalledFn) await onInstalledFn({ reason: 'install' }); await settle(30); },
  };
}

// ---------- content-script harness (one sandbox per frame) ----------
function loadContentFrame(href, storage, { excludedCache = null, fastTimerMs = null } = {}) {
  const runtimeListeners = [];
  const removedRuntime = [];
  const windowListeners = {};
  const documentListeners = {};
  const removedWindowListeners = [];
  const storageListeners = [];
  const posted = [];
  const postedToPage = [];
  const timeouts = new Map();
  const intervals = new Map();
  let nextTimer = 1;
  let timerRegistrations = 0;
  // Timer delays at or above `fastTimerMs` fire at once: a test that proves a
  // bounded wait does not have to sit through the real budget.
  const delayOf = (ms) => (fastTimerMs !== null && Number(ms) >= fastTimerMs ? 0 : ms);
  const sandbox = {
    console,
    // Tracked AND real: product timers must actually fire in these tests, but
    // nothing may keep the process alive after a test ends.
    setTimeout: (fn, ms) => {
      timerRegistrations += 1;
      const id = nextTimer++;
      timeouts.set(id, ms);
      const handle = setTimeout(() => {
        if (!timeouts.has(id)) return;
        timeouts.delete(id);
        try { fn(); } catch {}
      }, delayOf(ms));
      if (handle.unref) handle.unref();
      return id;
    },
    clearTimeout: (id) => { timeouts.delete(id); },
    setInterval: (fn, ms) => {
      timerRegistrations += 1;
      const id = nextTimer++;
      intervals.set(id, ms);
      const handle = setInterval(() => { if (intervals.has(id)) { try { fn(); } catch {} } }, delayOf(ms));
      if (handle.unref) handle.unref();
      return id;
    },
    clearInterval: (id) => { intervals.delete(id); },
    Promise, JSON, Object, Array, String, Number, Boolean, Date, Math, Error,
    URL,
    location: { href },
    chrome: {
      storage: {
        local: { get: (...a) => storage.get(...a), set: (...a) => storage.set(...a) },
        onChanged: {
          addListener: (fn) => { storage.onChanged.addListener(fn); storageListeners.push(fn); },
          removeListener: (fn) => {
            storage.onChanged.removeListener?.(fn);
            const index = storageListeners.indexOf(fn);
            if (index !== -1) storageListeners.splice(index, 1);
          },
        },
      },
      runtime: {
        onMessage: {
          addListener: (fn) => runtimeListeners.push(fn),
          removeListener: (fn) => removedRuntime.push(fn),
        },
        sendMessage: async (msg) => {
          // Control flows extension -> page only: the content script asks the WORKER,
          // which is the only party allowed to reach the MAIN world. The harness
          // records that request; the page itself receives nothing.
          if (msg && msg.type === 'CONTROL_HOOK') {
            const actionType = { start: 'START', stop: 'STOP', setGain: 'SET_GAIN', status: 'STATUS_REQUEST' }[msg.action] || msg.action;
            postedToPage.push({ type: actionType, via: 'worker', action: msg.action, gainDb: (msg.payload || {}).gainDb });
            return { ok: true, alive: true, active: true, gainDb: (msg.payload && msg.payload.gainDb) || 0, error: '' };
          }
          return { ok: true };
        },
        getURL: (p) => `chrome-extension://fake/${p}`,
      },
    },
    window: {
      addEventListener: (t, fn) => { (windowListeners[t] = windowListeners[t] || []).push(fn); },
      removeEventListener: (t, fn) => { removedWindowListeners.push({ t, fn }); },
      postMessage: (msg) => posted.push(msg),
    },
    document: {
      hidden: false,
      // document_start: this instance was injected while the document loaded.
      readyState: 'loading',
      documentElement: { setAttribute: () => {}, removeAttribute: () => {} },
      addEventListener: (t, fn) => { (documentListeners[t] = documentListeners[t] || []).push(fn); },
      removeEventListener: () => {},
    },
  };
  if (excludedCache !== null) sandbox.__tabNormalizerExclusionCache = excludedCache;
  sandbox.globalThis = sandbox;
  sandbox.TabNormalizerShared = sharedApi;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src('content-script.js'), sandbox, { filename: 'content-script.js' });
  const sendMessage = (message) => new Promise((resolve) => {
    // No listener = no receiver: the platform rejects, and the product's
    // fail-closed frames have exactly zero listeners.
    if (typeof runtimeListeners[0] !== 'function') {
      resolve({ ok: false, error: 'no receiver' });
      return;
    }
    const ret = runtimeListeners[0](message, {}, resolve);
    if (ret !== true) resolve(undefined);
  });
  const liveListeners = () => runtimeListeners.filter((fn) => !removedRuntime.includes(fn));
  return {
    sandbox,
    sendMessage,
    posted,
    postedToPage,
    timeouts,
    intervals,
    liveListeners,
    windowListeners,
    removedRuntime,
    removedWindowListeners,
    get storageListeners() { return storageListeners.length; },
    get timerRegistrations() { return timerRegistrations; },
  };
}

// ---------- popup harness (real popup.js through vm with a fake DOM) ----------
function makeFakeEl(id) {
  return {
    id, disabled: false, checked: false, value: '0', textContent: '', className: '',
    dataset: {}, attrs: {}, _handlers: {},
    addEventListener(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); },
    async fire(ev, ...args) { for (const fn of (this._handlers[ev] || [])) await fn(...args); },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
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
    'exclude-btn': makeFakeEl('exclude-btn'),
    'status-text': makeFakeEl('status-text'),
  };
  const presetButtons = ['speech', 'music', 'boost'].map((p) => {
    const b = makeFakeEl(`preset-${p}`);
    b.dataset.preset = p;
    return b;
  });
  presetButtons[Symbol.iterator] = Array.prototype[Symbol.iterator];
  const intervals = [];
  const tabsCalls = [];
  const runtimeCalls = [];
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval: () => {},
    Promise, JSON, Object, Array, String, Number, Boolean, Math, Error,
    URL,
    Date,
    document: {
      getElementById: (id) => els[id] || null,
      querySelectorAll: () => presetButtons,
    },
    window: { addEventListener: () => {} },
    chrome: {
      storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener: () => {} } },
      tabs: {
        query: async () => [{ id: 7, url: tabUrl }],
        sendMessage: async (tabId, msg, options) => {
          tabsCalls.push({ tabId, msg, options });
          if (tabsSendMessage) return tabsSendMessage(tabId, msg, options);
          return { ok: true };
        },
      },
      runtime: {
        sendMessage: async (msg) => {
          runtimeCalls.push(msg);
          return runtimeSendMessage(msg);
        },
      },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src('shared.js'), sandbox, { filename: 'shared.js' });
  vm.runInContext(src('popup.js'), sandbox, { filename: 'popup.js' });
  return { sandbox, els, presetButtons, intervals, tabsCalls, runtimeCalls };
}

// ============ contract: the stored record carries `excluded` ============
test('record round-trip: excluded survives normalize and defaults to false', () => {
  const record = { enabled: true, gainDb: 3, seq: 4, mirror: true, excluded: true, seen: true };
  assert.deepEqual(sharedApi.normalizeSiteRecord(record), record, 'excluded round-trips');
  assert.equal(sharedApi.normalizeSiteRecord({ enabled: true }).excluded, false, 'missing = false');
  assert.equal(sharedApi.normalizeSiteRecord({ enabled: true, excluded: 0 }).excluded, false);
  assert.equal(sharedApi.normalizeSiteRecord({ enabled: true, excluded: 'yes' }).excluded, true);
});

test('subdomain rule: h === key || h.endsWith("." + key)', () => {
  assert.equal(sharedApi.hostMatchesSiteKey('tiktok.com', 'tiktok.com'), true);
  assert.equal(sharedApi.hostMatchesSiteKey('www.tiktok.com', 'tiktok.com'), true);
  assert.equal(sharedApi.hostMatchesSiteKey('a.b.tiktok.com', 'tiktok.com'), true);
  assert.equal(sharedApi.hostMatchesSiteKey('nottiktok.com', 'tiktok.com'), false);
  assert.equal(sharedApi.hostMatchesSiteKey('www.tiktok.com:443', 'tiktok.com'), true);
  assert.equal(sharedApi.hostMatchesSiteKey('www.tiktok.com', 'www.tiktok.com'), true);
  assert.equal(sharedApi.hostMatchesSiteKey('tiktok.com', 'www.tiktok.com'), false);
  assert.equal(sharedApi.hostMatchesSiteKey('localhost:3000', 'localhost'), true);
});

test('subdomain rule: isHostExcluded scans a cached key list', () => {
  assert.equal(sharedApi.isHostExcluded('www.tiktok.com', ['tiktok.com']), true);
  assert.equal(sharedApi.isHostExcluded('example.com', ['tiktok.com']), false);
  assert.equal(sharedApi.isHostExcluded('example.com', []), false);
  assert.equal(sharedApi.isHostExcluded('example.com', null), false);
});

test('ancestorSiteKeys lists parents nearest-first, never itself', () => {
  assert.deepEqual(sharedApi.ancestorSiteKeys('a.b.example.com'), ['b.example.com', 'example.com', 'com']);
  assert.deepEqual(sharedApi.ancestorSiteKeys('www.tiktok.com'), ['tiktok.com', 'com']);
  assert.deepEqual(sharedApi.ancestorSiteKeys('example.com'), ['com']);
  assert.deepEqual(sharedApi.ancestorSiteKeys('localhost'), []);
});

test('normalization: trailing dot before the port, unicode hosts, and bare-key ancestors', () => {
  // Trailing dot BEFORE the port: the dot strip must happen after the port
  // strip, or the key keeps a trailing dot.
  assert.equal(sharedApi.getSiteKey('example.com.:443'), 'example.com');
  assert.equal(sharedApi.getSiteKey('example.com.'), 'example.com');
  assert.equal(sharedApi.hostMatchesSiteKey('example.com.:443', 'example.com'), true);
  // IPv6 groups are not ports.
  assert.equal(sharedApi.getSiteKey('[::1]:8080'), '::1');

  // Unicode hosts canonicalize to punycode, like location.hostname does.
  assert.equal(sharedApi.getSiteKey('bücher.example'), 'xn--bcher-kva.example');
  assert.equal(sharedApi.hostMatchesSiteKey('www.bücher.example', 'xn--bcher-kva.example'), true);

  // The suffix rule has no label floor for ancestors either.
  assert.deepEqual(sharedApi.ancestorSiteKeys('foo.localhost'), ['localhost']);
  assert.equal(sharedApi.isHostExcluded('foo.localhost', ['localhost']), true);
  assert.equal(sharedApi.isHostExcluded('example.com', ['com']), true);
  assert.equal(sharedApi.isHostExcluded('nottiktok.com', ['tiktok.com']), false);
});

test('excludeMatches pattern derivation', () => {
  assert.equal(sharedApi.siteExcludeMatchPattern('tiktok.com'), '*://*.tiktok.com/*');
  assert.deepEqual(
    sharedApi.siteExcludeMatchPatterns(['tiktok.com', 'www.tiktok.com', 'tiktok.com']),
    ['*://*.tiktok.com/*', '*://*.www.tiktok.com/*'],
    'deduped, one pattern per key',
  );
  assert.deepEqual(sharedApi.siteExcludeMatchPatterns(['localhost']), ['*://localhost/*']);
  assert.deepEqual(sharedApi.siteExcludeMatchPatterns(['127.0.0.1']), ['*://127.0.0.1/*']);
  assert.deepEqual(sharedApi.siteExcludeMatchPatterns(['::1']), ['*://[::1]/*']);
  assert.deepEqual(sharedApi.siteExcludeMatchPatterns([]), []);
});

// ============ background: storing exclusion, exclusion beats enablement ============
test('exclude-then-undo keeps enabled and gainDb untouched', async () => {
  const storage = createFakeStorage({
    'site:tiktok.com': { enabled: true, gainDb: 4.5, seq: 2, mirror: true },
  });
  const bg = loadBackground(storage, { tabUrl: 'https://www.tiktok.com/' });

  const excluded = await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'tiktok.com', set: { excluded: true } });
  assert.equal(excluded.excluded, true);
  assert.equal(excluded.enabled, true, 'enablement is preserved, not rewritten');
  assert.equal(excluded.gainDb, 4.5, 'gain is preserved');
  assert.deepEqual(storage._store()['site:tiktok.com'], {
    enabled: true, gainDb: 4.5, seq: 3, mirror: true, excluded: true, seen: true,
  }, 'one write, whole record, excluded added');

  const state = await bg.sendMessage({ type: 'GET_SITE_STATE', siteKey: 'tiktok.com' });
  assert.equal(state.excluded, true, 'GET_SITE_STATE reports exclusion');

  const undone = await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'tiktok.com', set: { excluded: false } });
  assert.equal(undone.excluded, false);
  assert.equal(undone.enabled, true, 'undo restores the same enabled');
  assert.equal(undone.gainDb, 4.5, 'undo restores the same gain');
  assert.equal(storage._store()['site:tiktok.com'].excluded, false);
});

test('background never injects the MAIN-world hook for an excluded host', async () => {
  const storage = createFakeStorage({
    'site:tiktok.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: true },
  });
  const bg = loadBackground(storage, { tabUrl: 'https://www.tiktok.com/' });
  const res = await bg.sendMessage(
    { type: 'INJECT_PAGE_HOOK' },
    { tab: { id: 7, url: 'https://www.tiktok.com/' }, frameId: 0 },
  );
  assert.equal(res.ok, false, 'refused');
  assert.match(String(res.error), /exclud/i);
  assert.deepEqual(bg.scripting.calls.execute, [], 'zero executeScript calls');
});

test('background never injects the MAIN-world hook for an excluded parent host', async () => {
  const storage = createFakeStorage({
    'site:tiktok.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: true },
  });
  const bg = loadBackground(storage, { tabUrl: 'https://www.tiktok.com/' });
  const res = await bg.sendMessage(
    { type: 'INJECT_PAGE_HOOK' },
    { tab: { id: 7, url: 'https://www.tiktok.com/' }, frameId: 0 },
  );
  assert.equal(res.ok, false);
});

test('enabling an excluded site does not activate the current tab', async () => {
  const storage = createFakeStorage({
    'site:tiktok.com': { enabled: false, gainDb: 0, seq: 1, mirror: false, excluded: true },
  });
  const bg = loadBackground(storage, { tabUrl: 'https://www.tiktok.com/' });
  const res = await bg.sendMessage({
    type: 'SET_SITE_STATE', siteKey: 'tiktok.com', tabId: 7, set: { enabled: true },
  });
  assert.equal(res.ok, true);
  assert.deepEqual(clone(res.activation), { state: 'idle' }, 'exclusion beats enablement at the background layer');
  assert.deepEqual(bg.scripting.calls.execute, [], 'no content-script injection on an excluded host');
});

// ============ registration-time enforcement ============
test('manifest carries no static <all_urls> content script', () => {
  const manifest = JSON.parse(src('manifest.json'));
  assert.equal(manifest.content_scripts, undefined, 'static injection is gone');
  assert.ok(manifest.permissions.includes('scripting'), 'scripting permission present');
  assert.ok(manifest.permissions.includes('storage'));
});

test('registration: enabled hosts are matches, excluded hosts are excludeMatches', async () => {
  const storage = createFakeStorage({
    'site:example.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: false },
    'site:tiktok.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: true },
    'site:quiet.example': { enabled: false, gainDb: 0, seq: 1, mirror: false, excluded: false },
  });
  const bg = loadBackground(storage);
  await bg.runInstalled();

  const [registration] = Array.from(bg.scripting.registered.values());
  assert.ok(registration, 'a dynamic content script is registered');
  assert.deepEqual(registration.js, ['shared.js', 'content-script.js'], 'same files, same ordering');
  assert.equal(registration.runAt, 'document_start');
  assert.equal(registration.allFrames, true);
  assert.equal(registration.world, 'ISOLATED');
  assert.equal(registration.matchOriginAsFallback, true);
  assert.deepEqual(registration.matches, ['*://example.com/*'], 'only hosts that can actually be active, exact host');
  assert.deepEqual(registration.excludeMatches, ['*://*.tiktok.com/*'], 'derived from excluded hosts');
  assert.ok(!registration.matches.includes('<all_urls>'), 'never all_urls');

  // The browser-visible registry answers with the excludes (the same assertion
  // the cost-audit harness makes from the service worker).
  const seen = await bg.scripting.api.getRegisteredContentScripts();
  assert.ok(seen.some((s) => s.excludeMatches.includes('*://*.tiktok.com/*')));
  assert.ok(seen.every((s) => !s.matches.includes('*://*.tiktok.com/*')));
});

test('registration: nothing enabled means nothing registered at all', async () => {
  const storage = createFakeStorage({
    'site:tiktok.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: true },
    'site:example.com': { enabled: false, gainDb: 0, seq: 1, mirror: false, excluded: false },
  });
  const bg = loadBackground(storage);
  await bg.runInstalled();
  assert.equal(bg.scripting.registered.size, 0, 'no registration: zero injected code on idle hosts');
  assert.equal(bg.scripting.calls.register.length, 0, 'never registered');

  // ...and a registration that stops matching is removed, not left stale.
  await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'example.com', set: { enabled: true } });
  await settle();
  assert.equal(bg.scripting.registered.size, 1, 'enabled host registered');
  await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'example.com', set: { excluded: true } });
  await settle();
  assert.equal(bg.scripting.registered.size, 0, 'stale registration removed');
  assert.ok(bg.scripting.calls.unregister.length > 0);
});

test('registration: an exclusion change re-registers, an install and a startup both do', async () => {
  const storage = createFakeStorage({
    'site:example.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: false },
    'site:tiktok.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: false },
  });
  const bg = loadBackground(storage);
  await bg.runInstalled();
  const initial = Array.from(bg.scripting.registered.values())[0];
  assert.deepEqual(initial.excludeMatches, []);
  assert.deepEqual(initial.matches, ['*://example.com/*', '*://tiktok.com/*']);

  await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'tiktok.com', set: { excluded: true } });
  await settle();
  const afterExclude = Array.from(bg.scripting.registered.values())[0];
  assert.deepEqual(afterExclude.excludeMatches, ['*://*.tiktok.com/*'], 'exclusion re-registered');
  assert.deepEqual(afterExclude.matches, ['*://example.com/*'], 'excluded host is no longer a match');

  await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'tiktok.com', set: { excluded: false } });
  await settle();
  const afterUndo = Array.from(bg.scripting.registered.values())[0];
  assert.deepEqual(afterUndo.matches, ['*://example.com/*', '*://tiktok.com/*'], 'undo re-registers the host');
  assert.deepEqual(afterUndo.excludeMatches, []);

  // A startup is a reconciliation, not a rewrite: the descriptor already says
  // what the records derive, so nothing is written on the wake.
  bg.scripting.calls.register.length = 0;
  bg.scripting.calls.update.length = 0;
  await bg.runStartup();
  await settle();
  assert.equal(
    bg.scripting.calls.register.length + bg.scripting.calls.update.length,
    0,
    'startup reconciles an identical descriptor without rewriting it',
  );
  // ...and it CORRECTS one that no longer says it: the self-healing half.
  bg.scripting.registered.set('tab-normalizer-content-script', {
    ...Array.from(bg.scripting.registered.values())[0],
    matches: ['*://example.com/*'],
    excludeMatches: [],
  });
  await bg.runStartup();
  await settle();
  assert.deepEqual(
    Array.from(bg.scripting.registered.values())[0].matches,
    ['*://example.com/*', '*://tiktok.com/*'],
    'startup restored the host the stale descriptor had lost',
  );
});

test('registration: a worker WAKE reconciles a descriptor a dead worker left behind', async () => {
  const storage = createFakeStorage({
    'site:example.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: false },
    'site:tiktok.com': { enabled: true, gainDb: 0, seq: 2, mirror: true, excluded: true },
  });
  const scripting = createFakeScripting();
  // The crash-shaped sequence: a previous worker wrote this while tiktok.com was
  // still enabled, then died before the exclusion write's pass. The descriptor
  // now matches a host the records exclude.
  scripting.registered.set('tab-normalizer-content-script', {
    id: 'tab-normalizer-content-script',
    js: ['shared.js', 'content-script.js'],
    matches: ['*://example.com/*', '*://tiktok.com/*'],
    excludeMatches: [],
    runAt: 'document_start',
    allFrames: true,
    matchOriginAsFallback: true,
    world: 'ISOLATED',
    persistAcrossSessions: true,
  });
  // A new worker: no message, no install, no startup event — only the wake.
  const bg = loadBackground(storage, { scripting });
  await settle(80);

  const [registration] = Array.from(scripting.registered.values());
  assert.ok(registration, 'the surviving descriptor is reconciled, not dropped and forgotten');
  assert.ok(
    !registration.matches.includes('*://tiktok.com/*'),
    'the excluded host is gone from matches on the wake alone',
  );
  assert.deepEqual(registration.excludeMatches, ['*://*.tiktok.com/*'], 'and it is in excludeMatches');
  assert.ok(
    registration.matches.includes('*://example.com/*'),
    'the enabled host is still matched after the wake',
  );
  assert.ok(
    scripting.calls.update.length > 0 || scripting.calls.register.length > 0,
    'the wake wrote the correction',
  );
  void bg;
});

test('registration: a rejected update fails closed, and the next wake heals it', async () => {
  const storage = createFakeStorage({
    'site:example.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: false },
    'site:tiktok.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: false },
  });
  const scripting = createFakeScripting();
  const bg = loadBackground(storage, { scripting });
  await bg.runInstalled();
  assert.deepEqual(
    Array.from(scripting.registered.values())[0].matches,
    ['*://example.com/*', '*://tiktok.com/*'],
    'both hosts are matches while enabled',
  );

  // The exclusion write lands; the update that should remove tiktok.com from
  // matches rejects.
  scripting.failNextUpdate('Invalid value for host_wildcard');
  await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'tiktok.com', set: { excluded: true } });
  await settle(60);

  const stale = Array.from(scripting.registered.values())[0];
  assert.ok(
    !stale || !stale.matches.includes('*://tiktok.com/*'),
    'a descriptor that could not be corrected was dropped: fail closed, never a stale match on an excluded host',
  );

  // A worker restart over the same registry and storage: the wake must converge
  // with no user action and no navigation.
  const revived = loadBackground(storage, { scripting });
  await settle(120);
  const healed = Array.from(scripting.registered.values())[0];
  assert.ok(healed, 'the registration is rebuilt');
  assert.deepEqual(healed.matches, ['*://example.com/*'], 'the allowed host is back');
  assert.deepEqual(healed.excludeMatches, ['*://*.tiktok.com/*'], 'the excluded host is only an exclusion');
  void revived;
});

test('registration: when the descriptor cannot be updated OR removed, it is reported once and the next wake converges', async () => {
  const storage = createFakeStorage({
    'site:example.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: false },
    'site:tiktok.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: false },
  });
  const scripting = createFakeScripting();
  const lines = [];
  const log = {
    log: () => {},
    warn: () => {},
    error: (...args) => lines.push(args.map(String).join(' ')),
  };
  const bg = loadBackground(storage, { scripting, log });
  await bg.runInstalled();
  const initial = Array.from(scripting.registered.values())[0];
  assert.ok(initial.matches.includes('*://tiktok.com/*'), 'both hosts are matches to begin with');

  // OS-level failure: the descriptor can be neither corrected nor removed.
  const api = scripting.api;
  const realUpdate = api.updateContentScripts;
  const realUnregister = api.unregisterContentScripts;
  api.updateContentScripts = async () => { throw new Error('update rejected'); };
  api.unregisterContentScripts = async () => { throw new Error('remove rejected'); };

  await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'tiktok.com', set: { excluded: true } });
  await settle(80);
  const answered = await bg.sendMessage({ type: 'GET_SITE_STATE', siteKey: 'example.com' });
  assert.equal(answered.ok, true, 'the extension keeps answering while registration is stuck');

  // Loud, once — not once per attempt.
  assert.equal(
    lines.filter((line) => /REGISTRATION STUCK/.test(line)).length,
    1,
    'the stuck registration is reported exactly once',
  );

  // Bounded: no synchronous re-entry. A retry is one timer away, not a loop.
  const attempts = () => scripting.calls.update.length + scripting.calls.register.length;
  const afterFirst = attempts();
  await settle(100);
  assert.ok(attempts() <= afterFirst + 2, `no runaway retry loop (attempts ${afterFirst} -> ${attempts()})`);

  // The documented limit really is present here: the stale descriptor still
  // matches the excluded host, because no API was able to remove it.
  const stuck = Array.from(scripting.registered.values())[0];
  assert.ok(stuck.matches.includes('*://tiktok.com/*'), 'LIMIT: the uncorrectable descriptor still matches');

  // ...and the next wake converges as soon as the browser answers again.
  api.updateContentScripts = realUpdate;
  api.unregisterContentScripts = realUnregister;
  const revived = loadBackground(storage, { scripting, log });
  await settle(150);
  const healed = Array.from(scripting.registered.values())[0];
  assert.ok(healed, 'a registration exists after the wake');
  assert.deepEqual(healed.matches, ['*://example.com/*'], 'the excluded host is gone from matches');
  assert.deepEqual(healed.excludeMatches, ['*://*.tiktok.com/*'], 'and present as an exclusion');
  void revived;
});

test('registration failure is logged, not fatal, the gate layer still works, and the retry heals it', async () => {
  const storage = createFakeStorage({
    'site:example.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: false },
  });
  const scripting = createFakeScripting();
  // Every registration write fails: the wake pass and the install pass both hit
  // it, so the failure is not consumed by whichever pass arrives first.
  const realRegister = scripting.api.registerContentScripts;
  let rejectRegisters = true;
  scripting.api.registerContentScripts = async (scripts) => {
    if (rejectRegisters) throw new Error('Invalid value for host_wildcard');
    return realRegister(scripts);
  };
  const bg = loadBackground(storage, { scripting });
  await bg.runInstalled();
  assert.equal(bg.scripting.registered.size, 0, 'registration failed');
  const res = await bg.sendMessage({ type: 'GET_SITE_STATE', siteKey: 'example.com' });
  assert.equal(res.ok, true, 'the extension keeps answering after a registration failure');
  assert.equal(res.enabled, true);

  // The bounded retry rebuilds it without a user action.
  rejectRegisters = false;
  await settle(400);
  assert.equal(bg.scripting.registered.size, 1, 'the retry registered the content script');
  assert.deepEqual(
    Array.from(bg.scripting.registered.values())[0].matches,
    ['*://example.com/*'],
    'and with the derived matches',
  );
});

// ============ backstop gate + live teardown ============
test('gate: a cached exclusion stops the content script before any listener or timer', () => {
  const storage = createFakeStorage({});
  const frame = loadContentFrame('https://www.tiktok.com/foryou', storage, {
    excludedCache: { hosts: ['tiktok.com'] },
  });
  assert.equal(frame.liveListeners().length, 0, 'no runtime listener');
  assert.deepEqual(frame.windowListeners, {}, 'no window listener');
  assert.equal(frame.timeouts.size, 0, 'no timer');
  assert.equal(frame.intervals.size, 0, 'no interval');
  assert.equal(frame.posted.length, 0, 'no page message');
  assert.equal(frame.sandbox.__tabNormalizerContentScriptV5, undefined, 'nothing installed');
});

// Replaces the old fail-open assertion: a FRESH document with no cache must
// install NOTHING until storage has answered, and an excluded answer must keep
// it that way. (The previous test asserted the opposite and was the defect.)
test('gate: a fresh document installs nothing before the answer, and never for an excluded host', async () => {
  const storage = createFakeStorage({
    'site:tiktok.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: false },
  });
  // Nothing is installed synchronously: the storage answer has not arrived.
  const pending = loadContentFrame('https://www.tiktok.com/foryou', storage, {
    excludedCache: { hosts: [] },
  });
  assert.equal(pending.liveListeners().length, 0, 'no listener before the answer');
  // One timer, and it is the bounded read guard itself (never an SPA watch or a
  // retry): the frame does no work while the answer is outstanding.
  assert.deepEqual([...pending.timeouts.values()], [2000], 'only the read budget is pending');
  await settle();
  assert.ok(pending.liveListeners().length > 0, 'a known, non-excluded host arms after the answer');

  // Same cold start, but the stored truth says excluded: it stays inert.
  const excludedStorage = createFakeStorage({
    'site:tiktok.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: true },
  });
  const inert = loadContentFrame('https://www.tiktok.com/foryou', excludedStorage, {
    excludedCache: { hosts: [] },
  });
  await settle(60);
  assert.equal(inert.liveListeners().length, 0, 'excluded host never arms, even on a cold document');
  assert.equal(inert.timeouts.size, 0);
  assert.equal(
    inert.storageListeners,
    1,
    'and keeps exactly the one inert surface rule 6 allows: its own storage signal',
  );
  assert.equal(inert.posted.length, 0, 'and never talks to the page');
});

test('bootstrap: a storage read that never answers is bounded, inert, observable, and recoverable', async () => {
  const initial = createFakeStorage({
    'site:example.com': { enabled: true, gainDb: 2, seq: 1, mirror: true, excluded: false },
  });
  const realGet = initial.get.bind(initial);
  let reads = 0;
  let hang = true;
  const storage = {
    onChanged: initial.onChanged,
    set: (items) => initial.set(items),
    get: (...args) => {
      reads += 1;
      return hang ? new Promise(() => {}) : realGet(...args);
    },
  };
  // The bounded wait is real; this run makes it fire at once.
  const frame = loadContentFrame('https://example.com/watch', storage, {
    excludedCache: { hosts: [] },
    fastTimerMs: 1000,
  });
  await settle(200);

  // Bounded: the read is retried exactly once, then given up on. A read that
  // never resolves can therefore never hang the bootstrap forever.
  assert.equal(reads, 2, `one idle read plus one retry (saw ${reads})`);
  assert.equal(frame.intervals.size, 0, 'no SPA watch');
  assert.equal(frame.timeouts.size, 0, 'no timer is left behind');
  assert.equal(
    frame.liveListeners().length,
    1,
    'exactly one inert listener survives: the extension-message recovery surface',
  );
  assert.deepEqual(frame.posted, [], 'the page received nothing');
  assert.deepEqual(frame.postedToPage, [], 'and the worker was asked for no hook control');

  // Observable, not silent: the frame answers with the reason it is inert.
  const status = await frame.sendMessage({ type: 'GET_DOCUMENT_STATUS' });
  assert.equal(status.ok, true, 'the frame still answers');
  assert.equal(status.enabled, false, 'and does no work');
  assert.equal(status.hookAlive, false);
  assert.match(String(status.bootstrapError), /timed out/i, 'the reason is reported');

  // Recoverable: once storage answers, a soft re-check retries the read and
  // arms the frame. A hung read cannot permanently disable an enabled site.
  hang = false;
  await frame.sendMessage({ type: 'SOFT_RECHECK_DOCUMENT' });
  await settle(120);
  assert.equal(frame.liveListeners().length, 1, 'the message listener is never registered twice');
  assert.ok(frame.intervals.size > 0, 'and the SPA watch runs');
  assert.ok((frame.windowListeners.popstate || []).length > 0, 'page listeners are armed');
  const recovered = await frame.sendMessage({ type: 'GET_DOCUMENT_STATUS' });
  assert.equal(recovered.enabled, true, 'the stored truth (enabled) is live again');
  assert.equal(recovered.gainDb, 2, 'and so is the stored gain');
  assert.equal(recovered.bootstrapError, '', 'and the read error is cleared');
});

test('the exclusion signal creates nothing while the frame is torn down', async () => {
  const storage = createFakeStorage({
    'site:www.tiktok.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: false },
  });
  const frame = loadContentFrame('https://www.tiktok.com/foryou', storage);
  await settle(80);
  assert.ok(frame.intervals.size > 0, 'armed before the exclusion');

  await frame.sendMessage({ type: 'TOGGLE_CHANGED', siteKey: 'www.tiktok.com', enabled: true, excluded: true });
  await settle(40);
  assert.equal(frame.storageListeners, 1, 'the one allowed surface survives');
  assert.equal(frame.liveListeners().length, 0, 'everything else is released');
  assert.equal(frame.timeouts.size, 0, 'and no timer is pending');

  // Ten relevant changes of every legacy and per-site shape: the surviving
  // listener must CREATE nothing on a torn-down frame. No timer, no observer,
  // no re-read loop — measured at registration, not after timers expire.
  const timersBefore = frame.timerRegistrations;
  for (let i = 0; i < 10; i += 1) {
    await storage.set({ activeSites: { 'www.tiktok.com': true } });
    await storage.set({ siteSettings: { 'www.tiktok.com': { enabled: true, gainDb: i } } });
    await storage.set({ siteToggles: { 'www.tiktok.com': true } });
    await storage.set({
      'site:www.tiktok.com': { enabled: true, gainDb: i, seq: i + 2, mirror: true, excluded: true },
    });
  }
  await settle(150);
  assert.equal(
    frame.timerRegistrations,
    timersBefore,
    `a torn-down frame registers no timer at all (registered ${frame.timerRegistrations - timersBefore})`,
  );
  assert.equal(frame.timeouts.size, 0, 'a torn-down frame still has zero timers');
  assert.equal(frame.intervals.size, 0, 'zero intervals');
  assert.equal(frame.storageListeners, 1, 'exactly its one inert surface');
  assert.equal(frame.liveListeners().length, 0, 'and nothing that could answer a message');
  assert.equal(frame.posted.length, 0, 'the page received nothing');
});

test('gate: a storage read error resolves to inactive, never to allowed', async () => {
  const storage = createFakeStorage({
    'site:example.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: false },
  });
  storage.get = async () => { throw new Error('storage unavailable'); };
  const frame = loadContentFrame('https://example.com/watch', storage, { excludedCache: { hosts: [] } });
  await settle(60);
  assert.equal(frame.liveListeners().length, 0, 'no listener on a read error');
  assert.equal(frame.timeouts.size, 0, 'no timer on a read error');
  assert.equal(frame.posted.length, 0, 'no page message on a read error');
});

test('gate: a host with no stored record at all stays inactive (unknown is not allowed)', async () => {
  const storage = createFakeStorage({});
  const frame = loadContentFrame('https://unvisited.example/watch', storage, { excludedCache: { hosts: [] } });
  await settle(60);
  assert.equal(frame.liveListeners().length, 0, 'unknown host installs nothing');
  assert.equal(frame.intervals.size, 0);
  assert.equal(frame.posted.length, 0);
});

test('exclusion beats enablement in the content script (no hook, no START, no listeners)', async () => {
  const storage = createFakeStorage({
    'site:tiktok.com': { enabled: true, gainDb: 3, seq: 1, mirror: true, excluded: true },
  });
  const injected = [];
  const frame = loadContentFrame('https://www.tiktok.com/foryou', storage);
  frame.sandbox.chrome.runtime.sendMessage = async (msg) => { injected.push(msg); return { ok: true }; };
  await settle();
  assert.deepEqual(injected.filter((m) => m.type === 'INJECT_PAGE_HOOK'), [], 'never asks for the page hook');
  assert.deepEqual(
    injected.filter((m) => m.type === 'CONTROL_HOOK' && m.action === 'start'),
    [],
    'never asks the worker to start the hook',
  );
  assert.equal(frame.liveListeners().length, 0, 'an excluded frame has no listener to answer with');
  assert.equal(frame.intervals.size, 0, 'and no timer');
});

test('exclusion also beats an excluded parent host for a subdomain tab', async () => {
  const storage = createFakeStorage({
    'site:tiktok.com': { enabled: true, gainDb: 3, seq: 1, mirror: true, excluded: true },
  });
  const injected = [];
  const frame = loadContentFrame('https://www.tiktok.com/foryou', storage);
  frame.sandbox.chrome.runtime.sendMessage = async (msg) => { injected.push(msg); return { ok: true }; };
  await settle();
  assert.deepEqual(injected.filter((m) => m.type === 'INJECT_PAGE_HOOK'), []);
});

test('exclusion beats the transient session override', async () => {
  const storage = createFakeStorage({
    'site:tiktok.com': { enabled: true, gainDb: 3, seq: 1, mirror: true, excluded: true },
  });
  const frame = loadContentFrame('https://www.tiktok.com/foryou', storage);
  await settle();
  // There is no listener to deliver the override to: the frame was never
  // armed, which is the strongest form of "exclusion beats the transient".
  await frame.sendMessage({
    type: 'SET_DOCUMENT_STATE', siteKey: 'tiktok.com', enabled: true, gainDb: 3, transient: true,
  });
  await settle();
  assert.deepEqual(
    frame.postedToPage.filter((m) => m.type === 'START'),
    [],
    'transient enable cannot start an excluded site',
  );
  assert.equal(frame.liveListeners().length, 0, 'and there is no listener that could receive it');
});

test('live teardown: excluding an open tab stops audio and releases every listener and timer', async () => {
  const storage = createFakeStorage({
    'site:www.tiktok.com': { enabled: true, gainDb: 3, seq: 1, mirror: true, excluded: false },
  });
  const injected = [];
  const frame = loadContentFrame('https://www.tiktok.com/foryou', storage);
  frame.sandbox.chrome.runtime.sendMessage = async (msg) => { injected.push(msg); return { ok: true }; };
  await settle();
  assert.ok(frame.intervals.size > 0, 'the SPA watch runs while enabled');
  assert.ok(frame.timeouts.size > 0, 'activation retries are in flight while enabled');

  frame.postedToPage.length = 0;
  injected.length = 0;
  await frame.sendMessage({ type: 'TOGGLE_CHANGED', siteKey: 'www.tiktok.com', enabled: true, excluded: true });
  await settle();

  // The frame releases everything it owns, becomes inert, and asks the worker
  // for exactly one thing: the STOP it can no longer perform itself (the worker
  // answers by destroying that frame's hook). It never asks for work again.
  assert.deepEqual(frame.posted, [], 'the frame posts nothing to the page: there is no page channel');
  const stops = injected.filter((m) => m.type === 'CONTROL_HOOK' && m.action === 'stop');
  assert.equal(stops.length, 1, 'exactly one STOP is delegated to the worker');
  assert.deepEqual(
    injected.filter((m) => m.type === 'INJECT_PAGE_HOOK'
      || (m.type === 'CONTROL_HOOK' && m.action !== 'stop')),
    [],
    'and nothing else: a torn-down frame cannot restart the hook',
  );
  assert.equal(frame.intervals.size, 0, 'every interval is cleared');
  assert.equal(frame.timeouts.size, 0, 'every timeout is cleared');
  assert.equal(frame.removedRuntime.length, 1, 'the runtime listener is removed');
  assert.ok(frame.removedWindowListeners.length >= 4, 'window listeners are removed');
  assert.equal(frame.liveListeners().length, 0, 'the frame is inert');
  assert.equal(frame.storageListeners, 1, 'and keeps exactly one inert surface: its storage signal');
});

test('live teardown also follows a PARENT-host exclusion through the storage broadcast', async () => {
  const storage = createFakeStorage({
    'site:tiktok.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: false },
  });
  const frame = loadContentFrame('https://www.tiktok.com/foryou', storage);
  await settle();
  assert.ok(frame.intervals.size > 0, 'enabled through the parent record');

  await storage.set({
    'site:tiktok.com': { enabled: true, gainDb: 0, seq: 2, mirror: true, excluded: true },
  });
  await settle(120);
  // The frame learns the PARENT record's verdict, so its synchronous gate would
  // refuse a re-entry even though its own key was never excluded.
  assert.ok(
    frame.sandbox.__tabNormalizerExclusionCache.hosts.includes('tiktok.com'),
    'the parent key is in the synchronous gate cache',
  );
  assert.equal(frame.intervals.size, 0, 'no timer survives');
  assert.equal(frame.liveListeners().length, 0);
});

test('gate runs before reinject(): an excluded re-entry calls nothing', async () => {
  const storage = createFakeStorage({
    'site:www.tiktok.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: true },
  });
  const frame = loadContentFrame('https://www.tiktok.com/foryou', storage, { excludedCache: { hosts: [] } });
  await settle();
  // Make the previous instance's reinject observable.
  let reinjectCalls = 0;
  frame.sandbox.__tabNormalizerContentScriptV5 = { reinject: () => { reinjectCalls += 1; } };

  // Re-execute the same file in the same world with an excluded gate verdict.
  const nodeVm = require('node:vm');
  frame.sandbox.__tabNormalizerFrameGate = { host: 'www.tiktok.com', excluded: true };
  nodeVm.runInContext(src('content-script.js'), frame.sandbox, { filename: 'content-script.js#reinject' });
  await settle(40);
  assert.equal(reinjectCalls, 0, 'the gate refused before reinject() was reached');
});

test('teardown: the popup probe listener and its timer are cancelled', async () => {
  const storage = createFakeStorage({
    'site:www.tiktok.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: false },
  });
  const frame = loadContentFrame('https://www.tiktok.com/foryou', storage);
  await settle(50);
  // A popup status poll starts a probe: one window listener + a 1 s timeout.
  await frame.sendMessage({ type: 'GET_DOCUMENT_STATUS' });
  await settle(10);
  assert.ok(frame.timeouts.size > 0, 'the probe timer is live');

  await frame.sendMessage({ type: 'TOGGLE_CHANGED', siteKey: 'www.tiktok.com', enabled: true, excluded: true });
  await settle(20);
  assert.equal(frame.timeouts.size, 0, 'the probe timeout was cancelled by teardown');
});

test('teardown is message-driven from the popup path: TOGGLE_CHANGED carries excluded', async () => {
  const storage = createFakeStorage({
    'site:tiktok.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: false },
  });
  const bg = loadBackground(storage, { tabUrl: 'https://www.tiktok.com/foryou' });
  await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'tiktok.com', tabId: 7, set: { excluded: true } });
  await settle();
  const broadcast = bg.tabsSent.find((c) => c.msg?.type === 'TOGGLE_CHANGED');
  assert.ok(broadcast, 'the open tab is messaged');
  assert.equal(broadcast.msg.excluded, true, 'the message carries the exclusion');
  // All frames, not just the top one: a cross-origin frame of the excluded host
  // does not share the tab's top-level URL and must tear down too.
  assert.equal(broadcast.options, undefined, 'an exclusion broadcast reaches every frame');

  // The reliable half: the WORKER also pushes teardown straight into every
  // MAIN world of every affected tab, so a frame whose content script is
  // mid-read, hung, or already detached still loses its hook.
  const teardown = bg.scripting.calls.execute.find((c) => c.funcName === 'tnHookTeardownAll');
  assert.ok(teardown, 'the worker injects the teardown function');
  assert.equal(teardown.world, 'MAIN', 'into the world the hook lives in');
  assert.deepEqual(teardown.target, { tabId: 7, allFrames: true }, 'every frame of the tab, not just the top');
  assert.deepEqual(teardown.args, ['destroy'], 'destroy: no dispatcher is left for the page to reach');
});

test('an ordinary (non-exclusion) broadcast also reaches every frame, and the siteKey guard isolates foreign ones', async () => {
  const storage = createFakeStorage({
    'site:tiktok.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: false },
  });
  const bg = loadBackground(storage, { tabUrl: 'https://www.tiktok.com/foryou' });
  await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'tiktok.com', tabId: 7, set: { gainDb: 3 } });
  await settle();
  const broadcast = bg.tabsSent.find((c) => c.msg?.type === 'TOGGLE_CHANGED');
  assert.ok(broadcast);
  // One send path for every broadcast: no frameId filter. A cross-origin frame
  // of another site receives the message too, and drops it on its own exact
  // `siteKey` match ('defect1c: disabling site A never disables embedded site
  // B' proves that guard).
  assert.equal(broadcast.options, undefined, 'no frameId filter: every frame is addressed');
});

// ============ popup control ============
test('popup: a first-ever enable shows the automatic reload, not an instruction', async () => {
  const popup = loadPopup({
    tabUrl: 'https://fresh.example/watch',
    runtimeSendMessage: async (msg) => {
      if (msg.type === 'GET_SITE_STATE') {
        return { ok: true, enabled: false, gainDb: 0, excluded: false, siteKey: 'fresh.example', seq: 1 };
      }
      if (msg.type === 'SET_SITE_STATE') {
        return {
          ok: true, enabled: true, gainDb: 0, excluded: false, seen: true,
          siteKey: 'fresh.example', seq: 2,
          activation: { state: 'reloading', message: 'Reloading to activate…' },
        };
      }
      return { ok: true };
    },
    // The tab is going away: the document cannot answer.
    tabsSendMessage: async () => { throw new Error('Receiving end does not exist.'); },
  });
  await settle(60);
  popup.els.toggle.checked = true;
  await popup.els.toggle.fire('change');
  await settle(160);
  const text = String(popup.els['status-text'].textContent);
  assert.match(text, /reloading to activate/i, 'the automatic reload is announced');
  assert.doesNotMatch(text, /reload applies this/i, 'the user is never told to reload');
  assert.equal(popup.els['status-pill'].textContent, 'Reloading', 'the pill says what is happening');
});

test('popup: a live enable says Active without a reload notice; a first-ever enable keeps the notice', async () => {
  // A seen host: the background answers activation "live" and the tab reports
  // an armed, processing document with the hook present.
  const live = loadPopup({
    tabUrl: 'https://example.com/watch',
    runtimeSendMessage: async (msg) => {
      if (msg.type === 'GET_SITE_STATE') {
        return { ok: true, enabled: false, gainDb: 0, excluded: false, siteKey: 'example.com', seq: 1 };
      }
      if (msg.type === 'SET_SITE_STATE') {
        return {
          ok: true, enabled: true, gainDb: 0, excluded: false, seen: true,
          siteKey: 'example.com', seq: 2, activation: { state: 'live' },
        };
      }
      return { ok: true };
    },
    tabsSendMessage: async (_tabId, msg) => {
      if (msg.type === 'GET_DOCUMENT_STATUS') {
        return {
          ok: true, siteKey: 'example.com', enabled: true, gainDb: 0,
          hookAlive: true, hookActive: true, hookPresent: true, indicator: 'green',
        };
      }
      return { ok: true };
    },
  });
  await settle(60);
  live.els.toggle.checked = true;
  await live.els.toggle.fire('change');
  await settle(120);
  const liveText = String(live.els['status-text'].textContent);
  assert.doesNotMatch(liveText, /reload/i, 'no reload claim for a live enable');
  assert.match(liveText, /normalizer active/i, 'the honest state is shown');
  assert.equal(live.els['status-pill'].textContent, 'Active', 'and the pill is Active');

  // A first-ever enable: no hook in the document yet, so the background says
  // "reload" and the popup says so once.
  const first = loadPopup({
    tabUrl: 'https://fresh.example/watch',
    runtimeSendMessage: async (msg) => {
      if (msg.type === 'GET_SITE_STATE') {
        return { ok: true, enabled: false, gainDb: 0, excluded: false, siteKey: 'fresh.example', seq: 1 };
      }
      if (msg.type === 'SET_SITE_STATE') {
        return {
          ok: true, enabled: true, gainDb: 0, excluded: false, seen: true,
          siteKey: 'fresh.example', seq: 2,
          activation: { state: 'reload', message: 'Enabled. Reload applies this.' },
        };
      }
      return { ok: true };
    },
    tabsSendMessage: async () => ({ ok: false, error: 'no receiver' }),
  });
  await settle(60);
  first.els.toggle.checked = true;
  await first.els.toggle.fire('change');
  await settle(120);
  const firstText = String(first.els['status-text'].textContent);
  assert.match(firstText, /reload applies this/i, 'the one residual case still says so');
  assert.equal((firstText.match(/reload/gi) || []).length, 1, 'said once');
});

test('popup: a page-owned graph gets a visible verdict, not a false Active', async () => {
  const popup = loadPopup({
    tabUrl: 'https://example.com/watch',
    runtimeSendMessage: async (msg) => {
      if (msg.type === 'GET_SITE_STATE') {
        return { ok: true, enabled: true, gainDb: 0, excluded: false, siteKey: 'example.com', seq: 1 };
      }
      return { ok: true };
    },
    tabsSendMessage: async (_tabId, msg) => {
      if (msg.type === 'GET_DOCUMENT_STATUS') {
        return {
          ok: true, siteKey: 'example.com', enabled: true, gainDb: 0,
          hookAlive: true, hookActive: false, hookPresent: true, unprocessed: 1,
          indicator: 'gray',
        };
      }
      return { ok: true };
    },
  });
  await settle(80);
  const text = String(popup.els['status-text'].textContent);
  assert.match(text, /own graph/i, 'the reason is stated');
  assert.match(text, /cannot be normalized/i, 'and so is the consequence');
  assert.equal(popup.els['status-pill'].textContent, 'Limited', 'the pill does not claim Active');
});

test('popup: exclusion and the re-enable both say a reload restores the page, once and quietly', async () => {
  const popup = loadPopup({
    tabUrl: 'https://www.tiktok.com/foryou',
    runtimeSendMessage: async (msg) => {
      if (msg.type === 'GET_SITE_STATE') {
        return { ok: true, enabled: true, gainDb: 4, excluded: true, siteKey: 'tiktok.com', seq: 1 };
      }
      if (msg.type === 'SET_SITE_STATE') {
        return {
          ok: true,
          enabled: true,
          gainDb: 4,
          excluded: Boolean(msg.set && msg.set.excluded),
          siteKey: 'tiktok.com',
          seq: 2,
        };
      }
      return { ok: true };
    },
    tabsSendMessage: async () => ({ ok: true }),
  });
  await settle(60);
  const text = () => String(popup.els['status-text'].textContent);
  assert.match(text(), /nothing runs/i, 'the excluded state still explains that nothing runs');
  assert.match(text(), /reload restores this page/i, 'and says a reload restores the page');

  // Undo: the live document cannot be re-normalized (its capture was released),
  // so the just-re-enabled state carries the same quiet instruction.
  await popup.els['exclude-btn'].fire('click');
  await settle(80);
  assert.equal(popup.els.toggle.disabled, false, 'the switch is usable again');
  assert.match(text(), /reload restores this page/i, 'the re-enabled state says it too');
  assert.equal((text().match(/reload/gi) || []).length, 1, 'said once, on one line');

  // Quiet means no new control: the popup is text-only about this.
  const html = src('popup.html');
  assert.ok(!/id\s*=\s*"[^"]*reload/i.test(html), 'no reload control was added');
});

test('popup: excluded state disables the controls and offers undo', async () => {
  const popup = loadPopup({
    tabUrl: 'https://www.tiktok.com/foryou',
    runtimeSendMessage: async (msg) => {
      if (msg.type === 'GET_SITE_STATE') {
        return { ok: true, enabled: true, gainDb: 4, excluded: true, siteKey: 'tiktok.com', seq: 1 };
      }
      return { ok: true, enabled: true, gainDb: 4, excluded: false, siteKey: 'tiktok.com', seq: 2 };
    },
    tabsSendMessage: async () => ({ ok: true }),
  });
  await settle(60);
  assert.equal(popup.els.toggle.disabled, true, 'Active switch disabled');
  assert.equal(popup.els['gain-slider'].disabled, true, 'gain slider disabled');
  assert.equal(popup.els['exclude-btn'].attrs['aria-pressed'], 'true');
  assert.equal(popup.els['exclude-btn'].attrs['aria-label'], 'Stop excluding this site');
  assert.match(String(popup.els['status-text'].textContent), /nothing runs/i, 'one quiet line of text');
  assert.equal(popup.intervals.length, 0, 'no status polling while excluded');
});

test('popup: clicking the exclude button persists only the exclusion flag', async () => {
  const popup = loadPopup({
    tabUrl: 'https://www.tiktok.com/foryou',
    runtimeSendMessage: async (msg) => {
      if (msg.type === 'GET_SITE_STATE') {
        return { ok: true, enabled: true, gainDb: 4, excluded: false, siteKey: 'tiktok.com', seq: 1 };
      }
      if (msg.type === 'SET_SITE_STATE') {
        return { ok: true, enabled: true, gainDb: 4, excluded: Boolean(msg.set && msg.set.excluded), siteKey: 'tiktok.com', seq: 2 };
      }
      return { ok: true };
    },
    tabsSendMessage: async () => ({ ok: true }),
  });
  await settle(60);
  assert.equal(popup.els['exclude-btn'].attrs['aria-pressed'], 'false');
  assert.equal(popup.els['exclude-btn'].attrs['aria-label'], 'Exclude this site');

  await popup.els['exclude-btn'].fire('click');
  await settle(60);
  const writes = popup.runtimeCalls.filter((m) => m.type === 'SET_SITE_STATE');
  assert.equal(writes.length, 1);
  assert.deepEqual(clone(writes[0].set), { excluded: true }, 'only the exclusion field is sent');
  assert.equal(popup.els.toggle.disabled, true, 'controls disable immediately');
  assert.equal(popup.els['exclude-btn'].attrs['aria-pressed'], 'true');

  await popup.els['exclude-btn'].fire('click');
  await settle(60);
  const again = popup.runtimeCalls.filter((m) => m.type === 'SET_SITE_STATE');
  assert.deepEqual(clone(again[again.length - 1].set), { excluded: false }, 'undo sends only the flag');
  assert.equal(popup.els.toggle.disabled, false, 'undo restores the switch');
  assert.equal(popup.els.toggle.checked, true, 'prior enabled state intact');
  assert.equal(popup.els['gain-slider'].value, '4', 'prior gain intact');
});

test('popup: the exclude control is a 16px inline SVG button in the site row', () => {
  const html = src('popup.html');
  const css = src('popup.css');
  const button = html.match(/<button[^>]*id="exclude-btn"[\s\S]*?<\/button>/);
  assert.ok(button, 'the button exists');
  assert.match(button[0], /<svg[^>]*width="16"[^>]*height="16"/, 'inline 16x16 SVG');
  assert.match(button[0], /aria-pressed="false"/);
  assert.match(button[0], /aria-label="Exclude this site"/);
  assert.ok(html.indexOf('id="exclude-btn"') > html.indexOf('id="status-pill"'), 'sits beside the status pill');
  assert.match(css, /#exclude-btn[\s\S]*?border-radius:\s*4px/);
  assert.match(css, /#exclude-btn[^{]*\{\s*[^}]*color:\s*var\(--muted\)/);
  assert.match(css, /#exclude-btn:hover[^{]*\{[^}]*var\(--ink\)/);
  assert.match(css, /#exclude-btn\[aria-pressed="true"\][^{]*\{[^}]*var\(--bad\)/);
});
