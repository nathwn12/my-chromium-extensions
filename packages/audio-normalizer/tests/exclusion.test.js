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
  const listeners = [];
  const setCalls = [];
  return {
    _store: () => clone(store),
    _setCalls: setCalls,
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
    onChanged: { addListener(fn) { listeners.push(fn); } },
  };
}

// ---------- fake chrome.scripting with a live registration registry ----------
function createFakeScripting() {
  const registered = new Map();
  const calls = { execute: [], register: [], update: [], unregister: [] };
  let failNextRegister = null;
  const api = {
    executeScript: async (opts) => { calls.execute.push(clone(opts)); return []; },
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
  };
}

// ---------- background harness (real background.js through vm) ----------
function loadBackground(storage, { tabUrl = 'https://example.com/', scripting = createFakeScripting() } = {}) {
  const runtimeListeners = [];
  const tabsSent = [];
  const tab = { id: 7, url: tabUrl };
  let onStartupFn = null;
  let onInstalledFn = null;
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
function loadContentFrame(href, storage, { excludedCache = null } = {}) {
  const runtimeListeners = [];
  const removedRuntime = [];
  const windowListeners = {};
  const documentListeners = {};
  const removedWindowListeners = [];
  const posted = [];
  const timeouts = new Map();
  const intervals = new Map();
  let nextTimer = 1;
  const sandbox = {
    console,
    // Tracked AND real: product timers must actually fire in these tests, but
    // nothing may keep the process alive after a test ends.
    setTimeout: (fn, ms) => {
      const id = nextTimer++;
      timeouts.set(id, ms);
      const handle = setTimeout(() => {
        if (!timeouts.has(id)) return;
        timeouts.delete(id);
        try { fn(); } catch {}
      }, ms);
      if (handle.unref) handle.unref();
      return id;
    },
    clearTimeout: (id) => { timeouts.delete(id); },
    setInterval: (fn, ms) => {
      const id = nextTimer++;
      intervals.set(id, ms);
      const handle = setInterval(() => { if (intervals.has(id)) { try { fn(); } catch {} } }, ms);
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
          addListener: (fn) => { storage.onChanged.addListener(fn); },
          removeListener: () => {},
        },
      },
      runtime: {
        onMessage: {
          addListener: (fn) => runtimeListeners.push(fn),
          removeListener: (fn) => removedRuntime.push(fn),
        },
        sendMessage: async () => ({ ok: true }),
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
    const ret = runtimeListeners[0](message, {}, resolve);
    if (ret !== true) resolve(undefined);
  });
  const liveListeners = () => runtimeListeners.filter((fn) => !removedRuntime.includes(fn));
  return {
    sandbox,
    sendMessage,
    posted,
    timeouts,
    intervals,
    liveListeners,
    windowListeners,
    removedRuntime,
    removedWindowListeners,
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
  const record = { enabled: true, gainDb: 3, seq: 4, mirror: true, excluded: true };
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
  assert.deepEqual(sharedApi.ancestorSiteKeys('a.b.example.com'), ['b.example.com', 'example.com']);
  assert.deepEqual(sharedApi.ancestorSiteKeys('www.tiktok.com'), ['tiktok.com']);
  assert.deepEqual(sharedApi.ancestorSiteKeys('example.com'), []);
  assert.deepEqual(sharedApi.ancestorSiteKeys('localhost'), []);
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
    enabled: true, gainDb: 4.5, seq: 3, mirror: true, excluded: true,
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

  bg.scripting.calls.register.length = 0;
  bg.scripting.calls.update.length = 0;
  await bg.runStartup();
  await settle();
  assert.ok(bg.scripting.calls.register.length + bg.scripting.calls.update.length >= 1, 'startup re-registers');
});

test('registration failure is logged, not fatal, and the gate layer still works', async () => {
  const storage = createFakeStorage({
    'site:example.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: false },
  });
  const bg = loadBackground(storage);
  bg.scripting.failNextRegister('Invalid value for host_wildcard');
  await bg.runInstalled();
  assert.equal(bg.scripting.registered.size, 0, 'registration failed');
  const res = await bg.sendMessage({ type: 'GET_SITE_STATE', siteKey: 'example.com' });
  assert.equal(res.ok, true, 'the extension keeps answering after a registration failure');
  assert.equal(res.enabled, true);
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

test('gate: no cached exclusion (the cold-document case) falls through to the read', async () => {
  const storage = createFakeStorage({
    'site:tiktok.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: false },
  });
  const frame = loadContentFrame('https://www.tiktok.com/foryou', storage, {
    excludedCache: { hosts: [] },
  });
  await settle();
  assert.ok(frame.liveListeners().length > 0, 'unknown-yet is not excluded');
});

test('exclusion beats enablement in the content script (no hook, no START)', async () => {
  const storage = createFakeStorage({
    'site:tiktok.com': { enabled: true, gainDb: 3, seq: 1, mirror: true, excluded: true },
  });
  const injected = [];
  const frame = loadContentFrame('https://www.tiktok.com/foryou', storage);
  frame.sandbox.chrome.runtime.sendMessage = async (msg) => { injected.push(msg); return { ok: true }; };
  await settle();
  assert.deepEqual(injected.filter((m) => m.type === 'INJECT_PAGE_HOOK'), [], 'never asks for the page hook');
  assert.deepEqual(frame.posted.filter((m) => m.type === 'START'), [], 'never starts the hook');
  const status = await frame.sendMessage({ type: 'GET_DOCUMENT_STATUS' });
  assert.equal(status.enabled, false, 'exclusion forces disabled');
  assert.equal(status.excluded, true, 'status reports the exclusion');
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
  await frame.sendMessage({
    type: 'SET_DOCUMENT_STATE', siteKey: 'tiktok.com', enabled: true, gainDb: 3, transient: true,
  });
  await settle();
  assert.deepEqual(frame.posted.filter((m) => m.type === 'START'), [], 'transient enable cannot start an excluded site');
  const status = await frame.sendMessage({ type: 'GET_DOCUMENT_STATUS' });
  assert.equal(status.enabled, false);
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

  await frame.sendMessage({ type: 'TOGGLE_CHANGED', siteKey: 'www.tiktok.com', enabled: true, excluded: true });
  await settle();

  assert.ok(frame.posted.some((m) => m.type === 'STOP'), 'the MAIN-world patch is told to stop');
  assert.equal(frame.intervals.size, 0, 'every interval is cleared');
  assert.equal(frame.timeouts.size, 0, 'every timeout is cleared');
  assert.equal(frame.removedRuntime.length, 1, 'the runtime listener is removed');
  assert.ok(frame.removedWindowListeners.length >= 4, 'window listeners are removed');
  assert.equal(frame.liveListeners().length, 0, 'the frame is inert');
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
  assert.ok(frame.posted.some((m) => m.type === 'STOP'), 'the subdomain frame is torn down too');
  assert.equal(frame.liveListeners().length, 0);
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
  assert.equal(broadcast.options?.frameId, 0);
});

// ============ popup control ============
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
