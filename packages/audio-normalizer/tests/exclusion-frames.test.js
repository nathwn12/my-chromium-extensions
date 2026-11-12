const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
function src(name) { return fs.readFileSync(path.join(ROOT, name), 'utf8'); }
const sharedApi = require(path.join(ROOT, 'shared.js'));

async function settle(ms = 50) { await new Promise((r) => setTimeout(r, ms)); }
function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
function hostOf(url) { return sharedApi.getSiteKey(sharedApi.extractHostname(url)); }

// ---------- fake chrome.storage.local ----------
function createFakeStorage(initial = {}) {
  let store = clone(initial);
  let listeners = [];
  return {
    _store: () => clone(store),
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

// ---------- a REAL frame graph: executeScript(func) runs the given function
// inside the frame's own world, exactly as the browser does, and
// executeScript(files) runs the product files there. ----------
function createTabWorld(frames) {
  // frames: [{ frameId, url }] — frame 0 is the top frame.
  const world = frames.map((frame) => ({
    frameId: frame.frameId,
    url: frame.url,
    listeners: [],
    runtimeListeners: [],
    storageListeners: [],
    storageDeliveries: 0,
    removedListeners: [],
    posted: [],
    timeouts: new Map(),
    intervals: new Map(),
    gate: undefined,
    sandbox: null,
    // Page-world cost counters: what a live document would actually pay.
    pageListeners: 0,
    liveObservers: 0,
    contexts: [],
    worklets: 0,
    observers: 0,
    hookInstalled: false,
    listenerSet: [],
    // Media the page holds, and how many times one element was captured.
    mediaElements: [],
    mediaSourceCalls: 0,
    mediaSourceByElement: new WeakMap(),
    workletMessages: [],
  }));

  const scriptingCalls = [];
  const tabId = 7;
  // The worker's own message dispatcher, so a frame's `chrome.runtime.sendMessage`
  // really reaches background.js (the real loop, not a stub that answers {ok:true}).
  let deliver = null;
  function useDeliver(fn) { deliver = fn; }

  function ensureSandbox(frame) {
    if (frame.sandbox) return frame.sandbox;
    let nextTimer = 1;
    // A page world real enough for page-hook.js to install itself and be
    // counted. Listeners are tracked live (added and removed), observers live,
    // and every AudioContext is kept so "closed" can be told from "live".
    const pageListener = (type, fn) => {
      if (frame.listenerSet.some((entry) => entry.type === type && entry.fn === fn)) return;
      frame.listenerSet.push({ type, fn });
      frame.pageListeners = frame.listenerSet.length;
    };
    const pageUnlistener = (type, fn) => {
      frame.listenerSet = frame.listenerSet.filter((entry) => !(entry.type === type && entry.fn === fn));
      frame.pageListeners = frame.listenerSet.length;
    };
    class PageAudioNode {
      connect() { return undefined; }
      disconnect() {}
    }
    class PageMediaElement extends PageAudioNode {
      constructor() {
        super();
        this.muted = false;
        this.paused = true;
        this.tagName = 'VIDEO';
        this.src = '';
        // Playback position, so a toggle can be proved not to lose it.
        this.currentTime = 42.5;
      }
      addEventListener(type, fn) { pageListener(type, fn); }
      removeEventListener() {}
      play() { this.paused = false; this.currentTime += 0.5; return Promise.resolve(); }
      querySelectorAll() { return []; }
    }
    class PageAudioContext {
      constructor() {
        frame.contexts.push(this);
        this.state = 'running';
        this.sampleRate = 48000;
        this.destination = { _eid: 99999 };
        this.audioWorklet = { addModule: async () => {} };
      }
      async resume() {}
      async suspend() {}
      close() { this.state = 'closed'; return Promise.resolve(); }
      createGain() { const node = new PageAudioNode(); node.context = this; return node; }
      createMediaElementSource(el) {
        // The platform rule the whole design turns on: one source per element,
        // ever. A second attempt throws, exactly like Chromium.
        frame.mediaSourceCalls += 1;
        const before = frame.mediaSourceByElement.get(el) || 0;
        frame.mediaSourceByElement.set(el, before + 1);
        if (before > 0) {
          const err = new Error('HTMLMediaElement already connected previously');
          err.name = 'InvalidStateError';
          throw err;
        }
        return { connect() {}, disconnect() {}, _eid: 1 };
      }
      addEventListener(type, fn) { pageListener(type, fn); }
      removeEventListener(type, fn) { pageUnlistener(type, fn); }
    }
    class PageWorkletNode {
      constructor() {
        frame.worklets += 1;
        this.port = { postMessage: (msg) => frame.workletMessages.push(msg) };
      }
      connect() { return undefined; }
      disconnect() {}
      set onprocessorerror(value) { this._ope = value; }
      get onprocessorerror() { return this._ope; }
    }
    class PageMutationObserver {
      constructor(cb) {
        frame.observers += 1;
        frame.liveObservers += 1;
        this._cb = cb;
        this._live = true;
      }
      observe() {}
      disconnect() {
        if (!this._live) return;
        this._live = false;
        frame.liveObservers -= 1;
      }
    }
    const documentElement = {
      _attrs: {},
      getAttribute(k) { return Object.hasOwn(this._attrs, k) ? this._attrs[k] : null; },
      setAttribute(k, v) { this._attrs[k] = String(v); },
      removeAttribute(k) { delete this._attrs[k]; },
    };
    const sandbox = {
      console,
      setTimeout: (fn, ms) => {
        const id = nextTimer++;
        frame.timeouts.set(id, ms);
        const handle = setTimeout(() => {
          if (!frame.timeouts.has(id)) return;
          frame.timeouts.delete(id);
          try { fn(); } catch {}
        }, ms);
        if (handle.unref) handle.unref();
        return id;
      },
      clearTimeout: (id) => { frame.timeouts.delete(id); },
      setInterval: (fn, ms) => {
        const id = nextTimer++;
        frame.intervals.set(id, ms);
        const handle = setInterval(() => { if (frame.intervals.has(id)) { try { fn(); } catch {} } }, ms);
        if (handle.unref) handle.unref();
        return id;
      },
      clearInterval: (id) => { frame.intervals.delete(id); },
      Promise, JSON, Object, Array, String, Number, Boolean, Date, Math, Error, URL,
      location: { href: frame.url, hostname: hostOf(frame.url) },
      chrome: {
        storage: {
          local: { get: (...a) => storageApi.get(...a), set: (...a) => storageApi.set(...a) },
          // FRAME-LOCAL delivery, like the real extension: every frame owns its
          // own listener list and receives `storage.onChanged` independently.
          // The tab world fans a change out to each frame's own list (see
          // `useStorage`), so a listener registered in one frame is never the
          // one that runs for another.
          onChanged: {
            addListener: (fn) => { frame.storageListeners.push(fn); },
            removeListener: (fn) => {
              frame.storageListeners = frame.storageListeners.filter((entry) => entry !== fn);
              frame.removedListeners.push(fn);
            },
          },
        },
        runtime: {
          onMessage: {
            addListener: (fn) => { frame.listeners.push(fn); frame.runtimeListeners.push(fn); },
            removeListener: (fn) => { frame.removedListeners.push(fn); },
          },
          sendMessage: async (msg) => (deliver
            ? deliver(msg, { tab: { id: tabId, url: frame.url }, url: frame.url, frameId: frame.frameId })
            : { ok: true }),
          getURL: (p) => `chrome-extension://fake/${p}`,
        },
      },
      // `window` IS the sandbox (set below), exactly as in a real frame: a
      // page-world addEventListener lands in the frame's counter.
      addEventListener: (type, fn) => { pageListener(type, fn); },
      removeEventListener: (type, fn) => { pageUnlistener(type, fn); },
      postMessage: (msg) => frame.posted.push(msg),
      document: {
        hidden: false,
        // document_start: the content script may only arm a document it was
        // registered for, at load.
        readyState: 'loading',
        documentElement,
        querySelector: () => null,
        // The page's own media, in insertion order, as querySelectorAll would
        // return it. Empty unless a test parks elements on the frame.
        querySelectorAll: (selector) => (String(selector).includes('audio')
          ? frame.mediaElements.slice()
          : []),
        addEventListener: (type, fn) => { pageListener(type, fn); },
        removeEventListener: (type, fn) => { pageUnlistener(type, fn); },
      },
      // The page world page-hook.js patches and counts.
      AudioNode: PageAudioNode,
      HTMLMediaElement: PageMediaElement,
      Element: PageMediaElement,
      AudioContext: PageAudioContext,
      OfflineAudioContext: PageAudioContext,
      AudioWorkletNode: PageWorkletNode,
      MutationObserver: PageMutationObserver,
      DOMException: Error,
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    sandbox.TabNormalizerShared = sharedApi;
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    frame.sandbox = sandbox;
    return sandbox;
  }

  let storageApi = createFakeStorage({});
  function useStorage(storage) {
    storageApi = storage;
    // The browser delivers a storage change to every extension frame. Do the
    // same explicitly: one fan-out per frame, into that frame's OWN listener
    // list, so the frames share a store but never a listener.
    if (storage.__frameFanOut) return;
    storage.__frameFanOut = true;
    storage.onChanged.addListener((changes, area) => {
      for (const frame of world) {
        frame.storageDeliveries += 1;
        for (const fn of frame.storageListeners.slice()) {
          try { fn(clone(changes), area); } catch {}
        }
      }
    });
  }

  const scripting = {
    executeScript: async (opts) => {
      scriptingCalls.push({
        files: opts.files ? opts.files.slice() : null,
        funcName: opts.func ? opts.func.name : null,
        world: opts.world || 'ISOLATED',
        target: clone(opts.target),
        args: clone(opts.args),
      });
      const targets = opts.target && opts.target.allFrames
        ? world
        : world.filter((f) => !opts.target || !opts.target.frameIds || opts.target.frameIds.includes(f.frameId));
      const results = [];
      for (const frame of targets) {
        const sandbox = ensureSandbox(frame);
        if (opts.func) {
          // Real per-frame execution: compile the function INSIDE the frame's
          // own context so `globalThis` and `location` are that frame's.
          const fn = vm.runInContext(`(${opts.func.toString()})`, sandbox);
          const result = fn.apply(sandbox, clone(opts.args) || []);
          // `gate` is the exclusion verdict ONLY; the presence probe also runs
          // as a function and must not overwrite it.
          if (opts.func.name === 'installFrameGate') frame.gate = result;
          if (opts.func.name === 'contentScriptPresence') frame.presence = result;
          // Teardown runs through here too: the hook is installed exactly when
          // the page world exposes its dispatcher.
          frame.hookInstalled = typeof sandbox.__tnHookV6 === 'function';
          results.push({ frameId: frame.frameId, result: clone(result) });
          continue;
        }
        try {
          for (const file of opts.files || []) {
            vm.runInContext(src(file), sandbox, { filename: `${file}#${frame.frameId}` });
            if (file === 'page-hook.js') {
              frame.hookInstalled = typeof sandbox.__tnHookV6 === 'function';
            }
          }
        } catch (error) {
          // A file that throws in this world leaves the frame unarmed; the
          // attempt is recorded so a test can tell "not injected" from
          // "injected and inert".
          frame.injectError = String((error && error.message) || error);
        }
        results.push({ frameId: frame.frameId, result: null });
      }
      return results;
    },
    getRegisteredContentScripts: async () => [],
    registerContentScripts: async () => {},
    updateContentScripts: async () => {},
    unregisterContentScripts: async () => {},
  };

  /**
   * Model a NAVIGATION: a brand-new document in the same frame. Registration is
   * what injects at document_start, and it now covers `seen || enabled` minus
   * `excluded` — so an excluded host and a never-seen off host get no content
   * script at all, while a seen-but-off host gets the pair and loads the hook
   * passively. Everything after injection (page hook, start) still runs through
   * the real worker, so "then navigate: normal" is the product path.
   */
  async function navigate(frameId) {
    const frame = world.find((entry) => entry.frameId === frameId);
    if (!frame) throw new Error(`no frame ${frameId}`);
    frame.sandbox = null;
    frame.listeners = [];
    frame.runtimeListeners = [];
    frame.storageListeners = [];
    frame.removedListeners = [];
    frame.posted = [];
    frame.timeouts = new Map();
    frame.intervals = new Map();
    frame.gate = undefined;
    frame.presence = undefined;
    frame.injectError = undefined;
    frame.pageListeners = 0;
    frame.liveObservers = 0;
    frame.contexts = [];
    frame.worklets = 0;
    frame.observers = 0;
    frame.listenerSet = [];
    frame.hookInstalled = false;
    // The document's own media, and the one-source counters, start fresh.
    frame.mediaElements = [];
    frame.mediaSourceCalls = 0;
    frame.mediaSourceByElement = new WeakMap();
    frame.workletMessages = [];

    const host = hostOf(frame.url);
    const all = await storageApi.get(null);
    const excludedHosts = Object.entries(all || {})
      .filter(([key, value]) => sharedApi.isSiteStorageKey(key) && value && typeof value === 'object' && value.excluded === true)
      .map(([key]) => sharedApi.siteKeyFromStorageKey(key));
    if (sharedApi.isHostExcluded(host, excludedHosts)) {
      frame.gate = { host, excluded: true };
      return frame;
    }
    frame.gate = { host, excluded: false };
    const perKey = sharedApi.siteStorageKey(host);
    const stored = perKey ? all[perKey] : null;
    const record = stored && typeof stored === 'object' ? sharedApi.normalizeSiteRecord(stored) : null;
    // Registration matches `seen || enabled`. No record at all, or a record that
    // is neither, means the browser injects nothing on this document.
    if (!record || !(record.seen || record.enabled)) return frame;
    const sandbox = ensureSandbox(frame);
    for (const file of ['shared.js', 'content-script.js']) {
      vm.runInContext(src(file), sandbox, { filename: `${file}#${frameId}@navigation` });
    }
    return frame;
  }

  return { world, scripting, tabId, useStorage, useDeliver, scriptingCalls, navigate };
}

// Load background.js against the frame graph.
function loadBackground(tabWorld, storage, tabUrl) {
  const runtimeListeners = [];
  const tabsSent = [];
  const tab = { id: tabWorld.tabId, url: tabUrl };
  tabWorld.useStorage(storage);
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
        onStartup: { addListener: () => {} },
        onInstalled: { addListener: () => {} },
        sendMessage: async () => ({ ok: true }),
      },
      tabs: {
        // Both API shapes: the promise form (teardown/query) and the callback
        // form (flushSiteBroadcast), exactly like the extension API supports.
        query: (query, callback) => {
          const tabs = [tab];
          if (typeof callback === 'function') {
            callback(tabs);
            return undefined;
          }
          return Promise.resolve(tabs);
        },
        get: async () => ({ ...tab }),
        sendMessage: async (id, msg, options) => {
          tabsSent.push({ tabId: id, msg, options });
          // Deliver like the browser: frameId targets one frame, no options
          // reaches every frame; no receiver rejects.
          const targets = options && typeof options.frameId === 'number'
            ? tabWorld.world.filter((f) => f.frameId === options.frameId)
            : tabWorld.world;
          let answered = false;
          let answer;
          for (const frame of targets) {
            for (const fn of frame.runtimeListeners) {
              if (frame.removedListeners.includes(fn)) continue;
              // eslint-disable-next-line no-loop-func
              await new Promise((resolve) => {
                let done = false;
                const sendResponse = (value) => { if (done) return; done = true; answered = true; answer = value; resolve(); };
                let ret;
                try {
                  ret = fn(clone(msg), {}, sendResponse);
                } catch {
                  resolve();
                  return;
                }
                if (ret !== true) resolve();
              });
            }
          }
          if (!answered) throw new Error('Could not establish connection. Receiving end does not exist.');
          return answer;
        },
        onUpdated: { addListener: () => {} },
        onRemoved: { addListener: () => {} },
      },
      scripting: tabWorld.scripting,
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
  const sendMessage = (message, sender = {}) => new Promise((resolve) => {
    const ret = runtimeListeners[0](message, sender, resolve);
    if (ret !== true) resolve(undefined);
  });
  tabWorld.useDeliver(sendMessage);
  return { sandbox, sendMessage, tabsSent };
}

// ---------- content-script-only frame (for async-race tests) ----------
function loadContentFrame(href, storage) {
  const runtimeListeners = [];
  const removedRuntime = [];
  const posted = [];
  const postedToPage = [];
  const timeouts = new Map();
  const intervals = new Map();
  let nextTimer = 1;
  const sandbox = {
    console,
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
    Promise, JSON, Object, Array, String, Number, Boolean, Date, Math, Error, URL,
    location: { href, hostname: hostOf(href) },
    chrome: {
      storage: {
        local: { get: (...a) => storage.get(...a), set: (...a) => storage.set(...a) },
        onChanged: { addListener: (fn) => storage.onChanged.addListener(fn), removeListener: () => {} },
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
      addEventListener: () => {},
      removeEventListener: () => {},
      postMessage: (msg) => posted.push(msg),
    },
    document: {
      hidden: false,
      documentElement: { setAttribute: () => {}, removeAttribute: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.TabNormalizerShared = sharedApi;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src('content-script.js'), sandbox, { filename: 'content-script.js' });
  const sendMessage = (message) => new Promise((resolve) => {
    const live = runtimeListeners.filter((fn) => !removedRuntime.includes(fn));
    if (typeof live[0] !== 'function') {
      resolve({ ok: false, error: 'no receiver' });
      return;
    }
    const ret = live[0](message, {}, resolve);
    if (ret !== true) resolve(undefined);
  });
  return {
    sandbox,
    sendMessage,
    posted,
    postedToPage,
    timeouts,
    intervals,
    liveListeners: () => runtimeListeners.filter((fn) => !removedRuntime.includes(fn)),
  };
}

// ============ finding 1: exclusion is decided per FRAME ============
test('frame-level: an excluded cross-origin frame gets no listener and no patch, the top frame works', async () => {
  const storage = createFakeStorage({
    'site:example.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: false },
    'site:tiktok.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: true },
  });
  // Top frame example.com, embedded frame from the excluded tiktok.com.
  const tab = createTabWorld([
    { frameId: 0, url: 'https://example.com/page' },
    { frameId: 3, url: 'https://www.tiktok.com/embed' },
  ]);
  const bg = loadBackground(tab, storage, 'https://example.com/page');

  // A navigation is what arms a document now: registration injects the pair,
  // and each frame's gate decides for its OWN host.
  await tab.navigate(0);
  await tab.navigate(3);
  await settle(200);

  const [top, inner] = tab.world;
  assert.ok(top.listeners.length > 0, 'top frame armed');
  assert.equal(inner.listeners.length, 0, 'excluded iframe installed NOTHING');
  assert.equal(inner.intervals.size, 0, 'excluded iframe runs no timer');
  assert.deepEqual(inner.posted, [], 'excluded iframe talks to no page code');
  assert.equal(inner.gate?.excluded, true, 'the frame gate decided on the FRAME hostname');
  assert.equal(top.gate?.excluded, false);

  // The gate ran for the frame that was injected: the worker runs it in the
  // target frame's MAIN world immediately before the hook file.
  const gateCall = tab.scriptingCalls.find((c) => c.funcName === 'installFrameGate');
  assert.ok(gateCall, 'the gate is injected as a function with the exclusion list');
  assert.deepEqual(gateCall.target, { tabId: 7, frameIds: [0] }, 'for the frame being injected');
  assert.deepEqual(gateCall.args, [['tiktok.com']], 'the list is passed as an argument');
  assert.equal(gateCall.world, 'MAIN');
  // The excluded frame never asked for a hook, so it never got a gate either.
  assert.equal(
    tab.scriptingCalls.some((c) => c.funcName === 'installFrameGate' && c.target.frameIds?.includes(3)),
    false,
    'the excluded iframe is never a target',
  );
  void bg;
});

test('frame-level: the MAIN hook is refused for an excluded frame and allowed for its embedder', async () => {
  const storage = createFakeStorage({
    'site:example.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: false },
    'site:tiktok.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: true },
  });
  const tab = createTabWorld([
    { frameId: 0, url: 'https://example.com/page' },
    { frameId: 3, url: 'https://www.tiktok.com/embed' },
  ]);
  const bg = loadBackground(tab, storage, 'https://example.com/page');

  const inner = await bg.sendMessage(
    { type: 'INJECT_PAGE_HOOK' },
    { tab: { id: 7, url: 'https://example.com/page' }, url: 'https://www.tiktok.com/embed', frameId: 3 },
  );
  assert.equal(inner.ok, false, 'the iframe gets no MAIN hook');
  assert.deepEqual(
    tab.scriptingCalls.filter((c) => c.files && c.files.includes('page-hook.js')),
    [],
    'no page-hook file was injected anywhere',
  );

  const top = await bg.sendMessage(
    { type: 'INJECT_PAGE_HOOK' },
    { tab: { id: 7, url: 'https://example.com/page' }, url: 'https://example.com/page', frameId: 0 },
  );
  void top;
  const hookCalls = tab.scriptingCalls.filter((c) => c.files && c.files.includes('page-hook.js'));
  assert.equal(hookCalls.length, 1, 'the embedder still gets its hook');
  assert.deepEqual(hookCalls[0].target.frameIds, [0], 'into its own frame only');
  const gate = tab.scriptingCalls.find((c) => c.funcName === 'installFrameGate' && c.world === 'MAIN');
  assert.ok(gate, 'the MAIN world gate ran first');
  assert.deepEqual(gate.target.frameIds, [0], 'for the requesting frame only');
});

// ============ finding 5: a host is never in both lists ============
test('registration: an excluded parent removes its descendants from matches', async () => {
  const storage = createFakeStorage({
    'site:a.example.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: false },
    'site:example.com': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: true },
    'site:other.test': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: false },
  });
  const registered = new Map();
  const tab = createTabWorld([{ frameId: 0, url: 'https://other.test/' }]);
  const scripting = {
    ...tab.scripting,
    getRegisteredContentScripts: async () => Array.from(registered.values()),
    registerContentScripts: async (scripts) => { for (const s of scripts) registered.set(s.id, clone(s)); },
    updateContentScripts: async (scripts) => { for (const s of scripts) registered.set(s.id, clone(s)); },
    unregisterContentScripts: async () => registered.clear(),
  };
  const bg = loadBackground({ ...tab, scripting }, storage, 'https://other.test/');

  // Trigger derivation through the storage-change path (the same one install uses).
  await storage.set({ 'site:brand-new.test': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: false } });
  await settle(60);
  const registration = Array.from(registered.values())[0];
  assert.ok(registration, 'a registration exists');
  assert.ok(!registration.matches.includes('*://*.a.example.com/*'), 'descendant of an excluded key is not a match');
  assert.ok(!registration.matches.includes('*://a.example.com/*'), 'nor its exact form');
  assert.ok(!registration.matches.includes('*://example.com/*'), 'the excluded key itself is not a match');
  assert.deepEqual(registration.excludeMatches, ['*://*.example.com/*']);
  assert.deepEqual(
    registration.matches,
    ['*://other.test/*', '*://brand-new.test/*'],
    'only genuinely active hosts; the descendant is covered by the parent exclusion alone',
  );
  // The excluded parent's wildcard covers the descendant, so the host appears
  // in NO match list of its own and only under excludeMatches.
  assert.ok(registration.excludeMatches.includes('*://*.example.com/*'));
  assert.equal(
    registration.matches.filter((m) => m.includes('a.example.com')).length,
    0,
    'a host is never in both lists',
  );
});

// ============ FINAL RULE: un-exclude applies on the next navigation ============
test('undo: un-excluding a parent does NOT re-arm an open tab; the next navigation does', async () => {
  const storage = createFakeStorage({
    'site:a.example.com': { enabled: true, gainDb: 2, seq: 1, mirror: true, excluded: false },
    'site:example.com': { enabled: true, gainDb: 0, seq: 2, mirror: true, excluded: true },
  });
  const tab = createTabWorld([{ frameId: 0, url: 'https://a.example.com/watch' }]);
  const bg = loadBackground(tab, storage, 'https://a.example.com/watch');
  const child = tab.world[0];

  const res = await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'example.com', set: { excluded: false } });
  await settle(80);
  assert.equal(res.excluded, false, 'the exclusion is undone in storage');

  // FINAL RULE: no injection into an already-loaded document, descendant or not.
  assert.deepEqual(
    tab.scriptingCalls.filter((c) => c.files && c.files.includes('content-script.js')),
    [],
    'nothing is injected into the open tab',
  );
  assert.equal(child.sandbox, null, 'and the document is left exactly as it was');

  // The next navigation arms it, through registration.
  await tab.navigate(0);
  await settle(200);
  assert.ok(child.listeners.length > 0, 'the navigation arms the frame');
  assert.equal(child.gate?.excluded, false, 'with a fresh gate verdict');
});

test('undo: a stale self-cache cannot block a fresh navigation (gate runs before the files)', async () => {
  const storage = createFakeStorage({
    'site:a.example.com': { enabled: true, gainDb: 2, seq: 1, mirror: true, excluded: false },
  });
  const tab = createTabWorld([{ frameId: 0, url: 'https://a.example.com/watch' }]);
  const bg = loadBackground(tab, storage, 'https://a.example.com/watch');
  const frame = tab.world[0];

  await tab.navigate(0);
  await settle(150);
  assert.ok(frame.listeners.length > 0, 'armed');
  assert.equal(frame.gate?.excluded, false, 'fresh gate verdict');

  // A stale positive cache in the frame's world, then the next navigation: the
  // gate the worker runs in that world before the files must overwrite it.
  vm.runInContext(
    'globalThis.__tabNormalizerExclusionCache = { hosts: ["a.example.com"] }; delete globalThis.__tabNormalizerFrameGate;',
    frame.sandbox,
  );
  await tab.navigate(0);
  await settle(200);

  assert.equal(frame.gate?.excluded, false, 'the gate overwrote the stale cache');
  assert.ok(frame.listeners.length > 0, 'and the frame is armed rather than frozen');
  void bg;
});

// ============ finding 1 (storage half): a read error injects nothing ============
test('background: a storage read error keeps the extension inactive (fail closed)', async () => {
  const storage = createFakeStorage({
    'site:example.com': { enabled: false, gainDb: 0, seq: 1, mirror: false, excluded: false },
  });
  const realGet = storage.get.bind(storage);
  let failReads = true;
  storage.get = async (keys) => {
    if (failReads) throw new Error('storage unavailable');
    return realGet(keys);
  };
  const tab = createTabWorld([{ frameId: 0, url: 'https://example.com/page' }]);
  const bg = loadBackground(tab, storage, 'https://example.com/page');

  const res = await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'example.com', tabId: 7, set: { enabled: true } });
  assert.equal(res.ok, false, 'the write itself fails, and nothing is injected');
  assert.deepEqual(
    tab.scriptingCalls.filter((c) => c.files),
    [],
    'no content script and no hook on an unreadable store',
  );

  failReads = false;
  const ok = await bg.sendMessage({ type: 'GET_SITE_STATE', siteKey: 'example.com' });
  assert.equal(ok.ok, true, 'and it recovers once storage answers');
});

// ============ finding 7: an async read that resolves after teardown ============
// A frame that is already armed starts a read (storage change), the exclusion
// broadcast tears it down, and THEN the read lands. It must schedule nothing.
test('race: a storage read resolving after teardown schedules nothing', async () => {
  const base = createFakeStorage({
    'site:www.tiktok.com': { enabled: true, gainDb: 3, seq: 1, mirror: true, excluded: false },
  });
  let readCount = 0;
  let releaseSecondRead = null;
  let parked = null;
  const storage = {
    onChanged: base.onChanged,
    async get(keys) {
      readCount += 1;
      // First read: the bootstrap. Second: the sync started by a storage
      // change. Park exactly that one.
      if (readCount === 2) {
        parked = new Promise((resolve) => { releaseSecondRead = resolve; });
        await parked;
      }
      return base.get(keys);
    },
    async set(items) { return base.set(items); },
  };

  const frame = loadContentFrame('https://www.tiktok.com/foryou', storage);
  await settle(60);
  assert.ok(frame.liveListeners().length > 0, 'armed by the first read');

  // A storage change starts the second (parked) read.
  await base.set({ 'site:www.tiktok.com': { enabled: true, gainDb: 4, seq: 2, mirror: true, excluded: false } });
  await settle(20);
  assert.ok(releaseSecondRead, 'the second read is parked');

  // Exclusion arrives and tears the frame down while that read is in flight.
  await frame.sendMessage({ type: 'TOGGLE_CHANGED', siteKey: 'www.tiktok.com', enabled: true, excluded: true });
  await settle(20);
  assert.equal(frame.liveListeners().length, 0, 'torn down');

  frame.posted.length = 0;
  releaseSecondRead();
  await settle(80);

  assert.equal(frame.liveListeners().length, 0, 'the late read did not re-arm anything');
  assert.equal(frame.intervals.size, 0, 'and started no SPA timer');
  assert.equal(frame.timeouts.size, 0, 'and left no timeout');
  assert.deepEqual(
    frame.postedToPage.filter((m) => m.type === 'START'),
    [],
    'and never asked the worker to start the hook',
  );
  assert.deepEqual(
    frame.postedToPage.filter((m) => m.type === 'SET_GAIN'),
    [],
    'and never touched gain',
  );
  assert.deepEqual(frame.posted, [], 'and the page still received nothing');
});

// ============ rule 6: the per-frame storage signal ============
test('per-frame signal: an embedded frame on an excluded host tears itself down, top host untouched', async () => {
  const storage = createFakeStorage({
    'site:top.test': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: false },
    'site:embed.test': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: false },
  });
  const tab = createTabWorld([
    { frameId: 0, url: 'https://top.test/' },
    { frameId: 3, url: 'https://embed.test/widget' },
  ]);
  const bg = loadBackground(tab, storage, 'https://top.test/');
  const liveRuntime = (frame) => frame.runtimeListeners.filter((fn) => !frame.removedListeners.includes(fn));

  // Each frame loads its own document; registration injects the ISOLATED pair
  // and each frame then decides for its OWN host, so both frames arm.
  await tab.navigate(0);
  await tab.navigate(3);
  await settle(250);
  const [top, embedded] = tab.world;
  assert.ok(liveRuntime(top).length > 0, 'top frame armed');
  assert.ok(liveRuntime(embedded).length > 0, 'embedded frame armed for its own host');
  assert.ok(top.intervals.size > 0, 'top frame runs its SPA watch');
  // Two genuinely separate frame worlds, not two views of one sandbox: their
  // content scripts are distinct instances and each owns its own signal.
  assert.notEqual(top.sandbox, embedded.sandbox, 'the frames are separate contexts');
  assert.ok(top.sandbox.__tabNormalizerContentScriptV5, 'the top frame has its own content script');
  assert.ok(embedded.sandbox.__tabNormalizerContentScriptV5, 'and so does the embedded frame');
  assert.notEqual(
    top.sandbox.__tabNormalizerContentScriptV5,
    embedded.sandbox.__tabNormalizerContentScriptV5,
    'they are different instances in different worlds',
  );
  assert.equal(top.storageListeners.length, 1, 'one signal in the top frame');
  assert.equal(embedded.storageListeners.length, 1, 'one signal in the embedded frame');
  const deliveriesBefore = [top.storageDeliveries, embedded.storageDeliveries];

  // Exclude the EMBEDDED host. The worker selects tabs by top-level host, so its
  // all-frame teardown never targets this tab: the only thing that reaches the
  // embedded frame is its own storage signal.
  await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'embed.test', set: { excluded: true } });
  await settle(200);

  // The change crossed the frame boundary into BOTH worlds; only the frame whose
  // own host it excludes acts on it.
  assert.ok(
    embedded.storageDeliveries > deliveriesBefore[1],
    'the change was delivered into the embedded frame',
  );
  assert.ok(top.storageDeliveries > deliveriesBefore[0], 'and into the top frame as well');
  assert.equal(top.storageListeners.length, 1, 'the top frame received it and kept its signal');

  assert.equal(embedded.storageListeners.length, 1, 'exactly one inert surface survives: the signal itself');
  assert.equal(liveRuntime(embedded).length, 0, 'every runtime listener is released');
  assert.equal(embedded.intervals.size, 0, 'no timer survives');
  assert.equal(embedded.timeouts.size, 0, 'and no timeout');
  assert.deepEqual(embedded.posted, [], 'and the page got nothing');

  // The dispose path asked the worker for the one teardown it cannot perform
  // itself, and the worker answered for THAT frame only.
  const destroys = tab.scriptingCalls.filter((c) => c.funcName === 'tnHookControl' && c.args && c.args[0] === 'destroy');
  assert.equal(destroys.length, 1, 'one frame-scoped teardown request');
  assert.deepEqual(destroys[0].target, { tabId: 7, frameIds: [3] }, 'for the embedded frame only');
  assert.equal(destroys[0].world, 'MAIN');

  // The allowed top frame is untouched.
  assert.ok(liveRuntime(top).length > 0, 'top frame keeps its listeners');
  assert.ok(top.intervals.size > 0, 'top frame keeps its SPA watch');
  assert.equal(
    tab.scriptingCalls.filter((c) => c.funcName === 'tnHookTeardownAll' && (!c.target || c.target.tabId === 7)).length,
    0,
    'no tab-wide hook teardown was ever pushed for this allowed tab',
  );
});


// ============ FINAL RULE: enabling never arms a live document ============
// Work begins on the next navigation, via registration. A document that was open
// when the state changed is only ever torn down.
const LIVE_COST = (frame) => ({
  pageListeners: frame.pageListeners,
  liveObservers: frame.liveObservers,
  liveAudioContexts: frame.contexts.filter((context) => context.state !== 'closed').length,
  timers: frame.timeouts.size + frame.intervals.size,
  runtimeListeners: frame.runtimeListeners.filter((fn) => !frame.removedListeners.includes(fn)).length,
  storageListeners: frame.storageListeners.length,
});
const NOTHING_RUNS = {
  pageListeners: 0,
  liveObservers: 0,
  liveAudioContexts: 0,
  timers: 0,
  runtimeListeners: 0,
  storageListeners: 1,
};

test('exclude -> enable on a live document leaves it torn down; a navigation arms it', async () => {
  const storage = createFakeStorage({
    'site:top.test': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: false },
  });
  const tab = createTabWorld([{ frameId: 0, url: 'https://top.test/' }]);
  const bg = loadBackground(tab, storage, 'https://top.test/');
  const frame = tab.world[0];

  // A document that loaded with the site enabled: the hook really runs here.
  await tab.navigate(0);
  await settle(200);
  assert.equal(frame.hookInstalled, true, 'the page hook is installed on a loaded document');
  assert.equal(frame.contexts.length, 1, 'and it pre-warmed one audio session');
  assert.ok(frame.observers >= 1, 'and its DOM observer');
  const workletsAfterArming = frame.worklets;

  // Exclude: teardown, no reload required.
  await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'top.test', tabId: 7, set: { excluded: true } });
  await settle(200);
  assert.equal(frame.hookInstalled, false, 'the hook is destroyed in this frame');
  assert.equal(frame.contexts[0].state, 'closed', 'and its session is released');

  // Enable again on the SAME document.
  await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'top.test', tabId: 7, set: { excluded: false } });
  await settle(250);

  assert.deepEqual(LIVE_COST(frame), NOTHING_RUNS, 're-enabling a live document starts nothing');
  assert.equal(frame.hookInstalled, false, 'no page hook was injected');
  assert.equal(frame.contexts.length, 1, 'and no audio session was created');
  assert.equal(frame.worklets, workletsAfterArming, 'and no worklet was created');

  // Then a navigation: registration arms it as before.
  await tab.navigate(0);
  await settle(250);
  assert.equal(frame.hookInstalled, true, 'a fresh navigation installs the hook');
  assert.equal(frame.contexts.length, 1, 'which pre-warms its audio session');
  assert.ok(frame.worklets >= 1, 'and routes through its worklet');
  assert.ok(frame.liveObservers >= 1, 'and watches the DOM');
  assert.ok(frame.pageListeners > 0, 'and binds its listeners');
});

test('first-ever enable on a live document arms nothing; a navigation arms it', async () => {
  const storage = createFakeStorage({
    'site:top.test': { enabled: false, gainDb: 0, seq: 1, mirror: false, excluded: false },
  });
  const tab = createTabWorld([{ frameId: 0, url: 'https://top.test/' }]);
  const bg = loadBackground(tab, storage, 'https://top.test/');
  const frame = tab.world[0];

  // The document loaded while the site was off and had NEVER been enabled:
  // registration does not match, so not even the ISOLATED pair runs.
  await tab.navigate(0);
  await settle(200);
  assert.equal(frame.sandbox, null, 'a never-seen off host gets no content script at all');
  assert.deepEqual(LIVE_COST(frame), {
    pageListeners: 0,
    liveObservers: 0,
    liveAudioContexts: 0,
    timers: 0,
    runtimeListeners: 0,
    storageListeners: 0,
  }, 'a host that loads off does no work at all');

  // The first-ever enable is the ONE case with no hook to start: the background
  // says so instead of claiming activation, and remembers `seen` for next time.
  const first = await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'top.test', tabId: 7, set: { enabled: true } });
  await settle(250);
  assert.equal(first.ok, true);
  assert.equal(first.seen, true, 'the first enable is remembered');
  assert.deepEqual(clone(first.activation), { state: 'reload', message: 'Enabled. Reload applies this.' },
    'one deferred notice, never a live claim');
  assert.equal(frame.sandbox, null, 'and nothing is injected into the already-loaded document');

  await tab.navigate(0);
  await settle(250);
  assert.equal(frame.hookInstalled, true, 'the next navigation arms it');
  assert.equal(frame.contexts.length, 1);
  assert.ok(frame.pageListeners > 0);
});

// ============ live toggle on a seen host ============
const ACTIVE_COST = (frame) => ({
  pageListeners: frame.pageListeners,
  liveObservers: frame.liveObservers,
  liveAudioContexts: frame.contexts.filter((context) => context.state !== 'closed').length,
  worklets: frame.worklets,
  mediaSourceCalls: frame.mediaSourceCalls,
});

test('seen host loaded off: the page hook is present and passive, nothing is processing', async () => {
  const storage = createFakeStorage({
    'site:top.test': { enabled: false, seen: true, gainDb: 0, seq: 2, mirror: false, excluded: false },
  });
  const tab = createTabWorld([{ frameId: 0, url: 'https://top.test/' }]);
  const bg = loadBackground(tab, storage, 'https://top.test/');
  const frame = tab.world[0];

  await tab.navigate(0);
  await settle(300);

  assert.equal(frame.hookInstalled, true, 'the MAIN hook is injected at document_start');
  assert.equal(typeof frame.sandbox.__tnHookV6, 'function', 'and answers the worker');
  assert.equal(frame.sandbox.__tnHookV6('status', {}).active, false, 'in reservation mode: not processing');
  assert.equal(frame.contexts.length, 0, 'no AudioContext is created while the site is off');
  assert.equal(frame.worklets, 0, 'no worklet node, so no normalizer work');
  assert.equal(frame.liveObservers, 0, 'no DOM observer while off');
  assert.equal(frame.mediaSourceCalls, 0, 'and no element is captured');

  // A host that was never seen still pays nothing (positive control for the
  // difference the reservation makes).
  const other = createFakeStorage({
    'site:quiet.test': { enabled: false, gainDb: 0, seq: 1, mirror: false, excluded: false },
  });
  const quietTab = createTabWorld([{ frameId: 0, url: 'https://quiet.test/' }]);
  loadBackground(quietTab, other, 'https://quiet.test/');
  await quietTab.navigate(0);
  await settle(200);
  assert.equal(quietTab.world[0].sandbox, null, 'a never-seen off host loads no hook and no content script');
  void bg;
});

test('seen host loaded off with a playing element: enable starts live, no navigation, position kept', async () => {
  const storage = createFakeStorage({
    'site:top.test': { enabled: false, seen: true, gainDb: 0, seq: 2, mirror: false, excluded: false },
  });
  const tab = createTabWorld([{ frameId: 0, url: 'https://top.test/' }]);
  const bg = loadBackground(tab, storage, 'https://top.test/');
  const frame = tab.world[0];

  await tab.navigate(0);
  await settle(200);
  assert.equal(frame.hookInstalled, true, 'passive hook present before the enable');

  // The page's own player, already playing, with a position to protect.
  const sandbox = frame.sandbox;
  const Media = vm.runInContext('HTMLMediaElement', sandbox);
  const media = new Media();
  media.currentTime = 137.25;
  media.paused = false;
  frame.mediaElements.push(media);
  const positionBefore = media.currentTime;
  const injectionsBefore = tab.scriptingCalls.filter((c) => c.files && c.files.includes('content-script.js')).length;
  const shotBefore = frame.sandbox;

  const res = await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'top.test', tabId: 7, set: { enabled: true } });
  await settle(400);

  assert.equal(res.ok, true);
  assert.deepEqual(clone(res.activation), { state: 'live' }, 'the enable is live, not deferred');
  assert.equal(frame.sandbox, shotBefore, 'the same document: no navigation, no re-injection');
  assert.equal(
    tab.scriptingCalls.filter((c) => c.files && c.files.includes('content-script.js')).length,
    injectionsBefore,
    'no content script was re-injected',
  );
  assert.equal(res.seen, true, 'the host is seen');

  // Started: one session, one capture, the worklet in the path.
  assert.equal(frame.contexts.filter((c) => c.state !== 'closed').length, 1, 'one audio session');
  assert.equal(frame.worklets, 1, 'one worklet node');
  assert.ok(frame.liveObservers >= 1, 'the DOM observer runs');
  assert.equal(frame.mediaSourceCalls, 1, 'the playing element was captured exactly once');
  assert.equal(media.__tnAttached, true, 'and is routed by us');
  assert.equal(media.muted, false, 'never left muted');
  assert.equal(media.currentTime, positionBefore, 'playback position untouched');
  assert.equal(frame.sandbox.__tnHookV6('status', {}).active, true, 'the hook reports Active');
  // Cold first start: no prior program exists, so no reset-program is minted
  // (a reset is only for a re-enabled program; resetting at attach is forbidden).
  assert.equal(
    frame.workletMessages.filter((m) => m && m.type === 'reset-program').length,
    0,
    'no program reset on a cold first start',
  );
});

test('off/on/off on a seen host: bypass, no teardown, no reload, one source per element', async () => {
  const storage = createFakeStorage({
    'site:top.test': { enabled: true, seen: true, gainDb: 0, seq: 1, mirror: true, excluded: false },
  });
  const tab = createTabWorld([{ frameId: 0, url: 'https://top.test/' }]);
  const bg = loadBackground(tab, storage, 'https://top.test/');
  const frame = tab.world[0];

  await tab.navigate(0);
  await settle(400);
  const sandbox = frame.sandbox;
  const Media = vm.runInContext('HTMLMediaElement', sandbox);
  const media = new Media();
  media.currentTime = 61;
  await media.play();
  frame.mediaElements.push(media);
  await settle(300);
  assert.equal(media.__tnAttached, true, 'element captured while enabled');
  assert.equal(frame.mediaSourceCalls, 1);
  const positionBefore = media.currentTime;
  const resetsBeforeDisable = frame.workletMessages.filter((m) => m && m.type === 'reset-program').length;

  // DISABLE: bypass, not teardown.
  await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'top.test', tabId: 7, set: { enabled: false } });
  await settle(300);
  assert.equal(frame.sandbox, sandbox, 'same document');
  assert.equal(typeof frame.sandbox.__tnHookV6, 'function', 'the hook is kept, not destroyed');
  assert.equal(frame.sandbox.__tnHookV6('status', {}).active, false, 'nothing is processing');
  assert.equal(frame.contexts.filter((c) => c.state !== 'closed').length, 1, 'the session is kept');
  assert.equal(frame.mediaSourceCalls, 1, 'nothing was released or re-captured');
  assert.equal(frame.liveObservers, 0, 'the DOM observer is disconnected while off');
  assert.equal(frame.sandbox.__tnHookV6('status', {}).alive, true, 'the dispatcher outlives the disable');
  assert.equal(media.muted, false, 'the element is audible and unprocessed');
  assert.equal(media.currentTime, positionBefore, 'position untouched');

  // ENABLE AGAIN: live, on the same session.
  const injectionsBefore = tab.scriptingCalls.filter((c) => c.files && c.files.includes('content-script.js')).length;
  const again = await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'top.test', tabId: 7, set: { enabled: true } });
  await settle(400);
  assert.deepEqual(clone(again.activation), { state: 'live' });
  assert.equal(
    tab.scriptingCalls.filter((c) => c.files && c.files.includes('content-script.js')).length,
    injectionsBefore,
    'no re-injection on a live re-enable',
  );
  assert.equal(frame.contexts.filter((c) => c.state !== 'closed').length, 1, 'still one session, never a second');
  assert.equal(frame.mediaSourceCalls, 1, 'still one source for the element');
  assert.equal(frame.sandbox.__tnHookV6('status', {}).active, true, 'processing resumed');
  const resetsAfter = frame.workletMessages.filter((m) => m && m.type === 'reset-program').length;
  assert.equal(resetsAfter - resetsBeforeDisable, 1, 'exactly one reset-program generation for the re-enable');
  assert.equal(media.currentTime, positionBefore, 'and the position never moved');
});

test('a page-claimed element gets a verdict: no second capture, never muted, no double audio', async () => {
  const storage = createFakeStorage({
    'site:top.test': { enabled: true, seen: true, gainDb: 0, seq: 1, mirror: true, excluded: false },
  });
  const tab = createTabWorld([{ frameId: 0, url: 'https://top.test/' }]);
  const bg = loadBackground(tab, storage, 'https://top.test/');
  const frame = tab.world[0];

  await tab.navigate(0);
  await settle(400);
  const sandbox = frame.sandbox;
  const Media = vm.runInContext('HTMLMediaElement', sandbox);
  const claimed = new Media();
  // The page wired this element into its own graph before we could: the one
  // source is spent, and a second attempt throws InvalidStateError.
  frame.mediaSourceByElement.set(claimed, 1);
  frame.mediaElements.push(claimed);
  await claimed.play();
  await settle(400);

  assert.equal(frame.mediaSourceCalls, 1, 'exactly one capture attempt for the claimed element');
  assert.equal(claimed.__tnAttached !== true, true, 'it is left unmanaged, never adopted');
  assert.equal(claimed.muted, false, 'and never muted by us — the page keeps its audio');
  assert.equal(claimed.__tnWebAudio, true, 'the verdict is recorded instead of retried in a loop');
  assert.equal(claimed.currentTime >= 42.5, true, 'the page still plays it');
  assert.equal(frame.sandbox.__tnHookV6('status', {}).unprocessed, 1, 'and the verdict reaches the popup');

  // A toggle does not retry the impossible capture, and does not build a second
  // graph for it.
  await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'top.test', tabId: 7, set: { enabled: false } });
  await settle(200);
  await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'top.test', tabId: 7, set: { enabled: true } });
  await settle(400);
  assert.equal(frame.mediaSourceCalls, 1, 'no second createMediaElementSource, ever');
  assert.equal(frame.contexts.filter((c) => c.state !== 'closed').length, 1, 'one audio graph, not two');
});

test('registration: a seen host is registered while off, and exclusion still wins over seen', async () => {
  const storage = createFakeStorage({
    'site:seen-off.test': { enabled: false, seen: true, gainDb: 0, seq: 2, mirror: false, excluded: false },
    'site:seen-excluded.test': { enabled: false, seen: true, gainDb: 0, seq: 3, mirror: false, excluded: true },
    'site:never.test': { enabled: false, gainDb: 0, seq: 1, mirror: false, excluded: false },
  });
  const registered = new Map();
  const tab = createTabWorld([{ frameId: 0, url: 'https://elsewhere.test/' }]);
  const scripting = {
    ...tab.scripting,
    getRegisteredContentScripts: async () => Array.from(registered.values()),
    registerContentScripts: async (scripts) => { for (const s of scripts) registered.set(s.id, clone(s)); },
    updateContentScripts: async (scripts) => { for (const s of scripts) registered.set(s.id, clone(s)); },
    unregisterContentScripts: async () => registered.clear(),
  };
  loadBackground({ ...tab, scripting }, storage, 'https://elsewhere.test/');
  await storage.set({ 'site:churn.test': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: false } });
  await settle(80);

  const [registration] = Array.from(registered.values());
  assert.ok(registration, 'a registration exists');
  assert.ok(registration.matches.includes('*://seen-off.test/*'), 'the seen-but-off host is registered');
  assert.ok(registration.matches.includes('*://churn.test/*'), 'the enabled host is registered');
  assert.ok(!registration.matches.includes('*://never.test/*'), 'a never-seen off host is not');
  assert.ok(!registration.matches.includes('*://seen-excluded.test/*'), 'exclusion beats seen');
  assert.ok(registration.excludeMatches.includes('*://*.seen-excluded.test/*'), 'and it is in excludeMatches');
});

test('exclude on a live document still tears down within the task', async () => {
  const storage = createFakeStorage({
    'site:top.test': { enabled: true, gainDb: 0, seq: 1, mirror: true, excluded: false },
  });
  const tab = createTabWorld([{ frameId: 0, url: 'https://top.test/' }]);
  const bg = loadBackground(tab, storage, 'https://top.test/');
  const frame = tab.world[0];

  await tab.navigate(0);
  await settle(200);
  assert.equal(frame.hookInstalled, true, 'armed to begin with');

  await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'top.test', tabId: 7, set: { excluded: true } });
  await settle(120);
  assert.equal(frame.hookInstalled, false, 'torn down without a reload');
  assert.equal(frame.contexts.length, 1, 'the pre-warmed session is released, not replaced');
  assert.equal(frame.contexts[0].state, 'closed', 'and closed');
  assert.equal(frame.intervals.size, 0, 'no interval survives');
  assert.equal(
    frame.runtimeListeners.filter((fn) => !frame.removedListeners.includes(fn)).length,
    0,
    'no runtime listener survives',
  );
  assert.equal(frame.storageListeners.length, 1, 'only the one inert surface');
  // The hook's bounded resume races are self-clearing and untracked by design;
  // once they expire the frame holds no timer at all.
  await settle(600);
  assert.equal(frame.timeouts.size + frame.intervals.size, 0, 'and no timer remains');
});
