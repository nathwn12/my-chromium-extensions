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
  const listeners = [];
  return {
    _store: () => clone(store),
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
    onChanged: { addListener(fn) { listeners.push(fn); } },
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
    removedListeners: [],
    posted: [],
    timeouts: new Map(),
    intervals: new Map(),
    gate: undefined,
    sandbox: null,
  }));

  const scriptingCalls = [];
  const tabId = 7;

  function ensureSandbox(frame) {
    if (frame.sandbox) return frame.sandbox;
    let nextTimer = 1;
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
          onChanged: {
            addListener: (fn) => { storageApi.onChanged.addListener(fn); frame.listeners.push(fn); },
            removeListener: (fn) => { frame.removedListeners.push(fn); },
          },
        },
        runtime: {
          onMessage: {
            addListener: (fn) => { frame.listeners.push(fn); frame.runtimeListeners.push(fn); },
            removeListener: (fn) => { frame.removedListeners.push(fn); },
          },
          sendMessage: async () => ({ ok: true }),
          getURL: (p) => `chrome-extension://fake/${p}`,
        },
      },
      window: {
        addEventListener: () => {},
        removeEventListener: () => {},
        postMessage: (msg) => frame.posted.push(msg),
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
    frame.sandbox = sandbox;
    return sandbox;
  }

  let storageApi = createFakeStorage({});
  function useStorage(storage) { storageApi = storage; }

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
          frame.gate = result;
          results.push({ frameId: frame.frameId, result: clone(result) });
          continue;
        }
        try {
          for (const file of opts.files || []) {
            vm.runInContext(src(file), sandbox, { filename: `${file}#${frame.frameId}` });
          }
        } catch {
          // A file that needs a full browser (page-hook patches AudioContext)
          // cannot run here; the ATTEMPT is what these tests assert.
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

  return { world, scripting, tabId, useStorage, scriptingCalls };
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
        query: async () => [tab],
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
  return { sandbox, sendMessage, tabsSent };
}

// ---------- content-script-only frame (for async-race tests) ----------
function loadContentFrame(href, storage) {
  const runtimeListeners = [];
  const removedRuntime = [];
  const posted = [];
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
        sendMessage: async () => ({ ok: true }),
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

  // Enable the top site: the explicit activation path injects ALL frames.
  await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'example.com', tabId: 7, set: { enabled: true } });
  await settle(80);

  const [top, inner] = tab.world;
  assert.ok(top.listeners.length > 0, 'top frame armed');
  assert.equal(inner.listeners.length, 0, 'excluded iframe installed NOTHING');
  assert.equal(inner.intervals.size, 0, 'excluded iframe runs no timer');
  assert.deepEqual(inner.posted, [], 'excluded iframe talks to no page code');
  assert.equal(inner.gate?.excluded, true, 'the frame gate decided on the FRAME hostname');
  assert.equal(top.gate?.excluded, false);

  // The gate ran in every frame before the files were injected.
  const gateCall = tab.scriptingCalls.find((c) => c.funcName === 'installFrameGate');
  assert.ok(gateCall, 'the gate is injected as a function with the exclusion list');
  assert.equal(gateCall.target.allFrames, true, 'every frame, not just the top');
  assert.deepEqual(gateCall.args, [['tiktok.com']], 'the list is passed as an argument');
  assert.equal(gateCall.world, 'ISOLATED');
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

// ============ finding 4: undo revives open descendants ============
test('undo: un-excluding a parent re-injects its open subdomain tabs without a reload', async () => {
  const storage = createFakeStorage({
    'site:a.example.com': { enabled: true, gainDb: 2, seq: 1, mirror: true, excluded: false },
    'site:example.com': { enabled: true, gainDb: 0, seq: 2, mirror: true, excluded: true },
  });
  // The open tab IS the subdomain: it was torn down with its own cached key.
  const tab = createTabWorld([{ frameId: 0, url: 'https://a.example.com/watch' }]);
  // Model the torn-down child: a stale cache naming itself, no listeners.
  const child = tab.world[0];
  child.sandbox = null;
  const bg = loadBackground(tab, storage, 'https://a.example.com/watch');

  const res = await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'example.com', set: { excluded: false } });
  await settle(80);
  assert.equal(res.excluded, false);

  const injected = tab.scriptingCalls.filter((c) => c.files && c.files.includes('content-script.js'));
  assert.ok(injected.length > 0, 'the descendant tab is re-injected, not just the exact key');
  assert.equal(injected[0].target.allFrames, true);
  const gate = tab.scriptingCalls.find((c) => c.funcName === 'installFrameGate');
  assert.deepEqual(gate.args, [[]], 'the gate is rewritten with the now-empty list');
  assert.ok(child.listeners.length > 0, 'the child is active again');
  assert.equal(child.gate?.excluded, false, 'and its stale cache was replaced');
});

test('undo: a stale self-cache cannot block a re-injection (gate runs before reinject)', async () => {
  const storage = createFakeStorage({
    'site:a.example.com': { enabled: true, gainDb: 2, seq: 1, mirror: true, excluded: false },
  });
  const tab = createTabWorld([{ frameId: 0, url: 'https://a.example.com/watch' }]);
  const frame = tab.world[0];
  const bg = loadBackground(tab, storage, 'https://a.example.com/watch');

  // First injection: the frame arms itself and keeps its instance.
  await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'a.example.com', tabId: 7, set: { enabled: true } });
  await settle(80);
  assert.ok(frame.listeners.length > 0, 'armed');

  // A stale positive cache in the frame's world, then a re-injection.
  vm.runInContext(
    'globalThis.__tabNormalizerExclusionCache = { hosts: ["a.example.com"] }; delete globalThis.__tabNormalizerFrameGate;',
    frame.sandbox,
  );
  await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'a.example.com', tabId: 7, set: { gainDb: 3 } }).catch(() => {});
  // Re-inject explicitly the way undo does.
  await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'a.example.com', set: { excluded: true } });
  await settle(60);
  await bg.sendMessage({ type: 'SET_SITE_STATE', siteKey: 'a.example.com', set: { excluded: false } });
  await settle(100);

  // The gate the background injects overwrites the stale cache, so the frame
  // ends up armed rather than frozen.
  assert.equal(frame.gate?.excluded, false, 'fresh gate verdict');
  assert.ok(frame.listeners.length > 0, 'the frame is armed again');
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
  assert.deepEqual(frame.posted.filter((m) => m.type === 'START'), [], 'and never started the hook');
  assert.deepEqual(frame.posted.filter((m) => m.type === 'SET_GAIN'), [], 'and never touched gain');
});
