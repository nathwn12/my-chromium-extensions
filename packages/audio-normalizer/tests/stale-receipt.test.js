'use strict';
// DELAYED STALE RECEIPT — production request path.
// Drives the real content-script.js: real sync -> real scheduleActivationRetry
// -> real postToPage -> real sendHookControl -> real applyHookStatus. Only the
// worker transport (chrome.runtime.sendMessage) is stubbed so replies can be
// resolved out of order, which is what a delayed worker/scripting reply does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
const shared = require('../shared.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function createStore(initial = {}) {
  const store = clone(initial);
  return {
    async get(keys) {
      if (keys === null || keys === undefined) return clone(store);
      if (typeof keys === 'string') return { [keys]: clone(store[keys]) };
      if (Array.isArray(keys)) {
        const out = {};
        for (const key of keys) out[key] = clone(store[key]);
        return out;
      }
      return {};
    },
    onChanged: { addListener() {} },
  };
}

async function loadEnabledContent() {
  const store = createStore({
    'site:example.com': { enabled: true, gainDb: 0, seq: 1, mirror: true },
  });
  const deferred = [];
  const runtimeListeners = [];
  const sandbox = {
    console, setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval: () => {},
    Promise, JSON, Object, Array, String, Number, Boolean, Date, Math, Error, URL,
    location: { href: 'https://example.com/watch' },
    chrome: {
      storage: {
        local: { get: (...a) => store.get(...a), set: async () => {} },
        onChanged: { addListener: (fn) => store.onChanged.addListener(fn) },
      },
      runtime: {
        onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
        sendMessage: async (msg) => {
          if (msg && msg.type === 'CONTROL_HOOK') {
            return new Promise((resolve) => {
              deferred.push({ action: msg.action, msg: clone(msg), resolve });
            });
          }
          // No MAIN-world injection here: keeps the load-time control sequence
          // to the activation retry's START then SET_GAIN only.
          if (msg && msg.type === 'INJECT_PAGE_HOOK') {
            return { ok: false, error: 'test: injection suppressed' };
          }
          return { ok: true };
        },
        getURL: (p) => `chrome-extension://test-id/${p}`,
      },
    },
    window: { addEventListener() {}, removeEventListener() {}, postMessage() {} },
    document: {
      hidden: false,
      readyState: 'loading',
      documentElement: { setAttribute() {}, removeAttribute() {}, getAttribute() { return null; } },
      addEventListener() {},
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.TabNormalizerShared = shared;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('content-script.js'), sandbox, { filename: 'content-script.js' });
  await sleep(60);
  const sendMessage = (message) => new Promise((resolve) => {
    if (typeof runtimeListeners[0] !== 'function') {
      resolve({ ok: false, error: 'no receiver' });
      return;
    }
    const ret = runtimeListeners[0](message, {}, resolve);
    if (ret !== true) resolve(undefined);
  });
  return { deferred, sendMessage };
}

const noSource = {
  ok: true, alive: true, active: true, processing: false, unprocessed: 0, error: '',
};
const oldProcessing = {
  ok: true, alive: true, active: true, processing: true, unprocessed: 0, error: '',
};

test('production path: delayed stale START reply cannot reassert over newer SET_GAIN receipt', async () => {
  const h = await loadEnabledContent();
  assert.deepEqual(
    h.deferred.map((d) => d.action),
    ['start', 'setGain'],
    'activation retry issued real START then SET_GAIN control requests',
  );

  // Newer request (setGain) confirms the current target has no attached source.
  h.deferred[1].resolve(clone(noSource));
  await sleep(20);
  // Older START reply arrives late, carrying a processing receipt from the
  // previous target/session.
  h.deferred[0].resolve(clone(oldProcessing));
  await sleep(20);

  const status = await h.sendMessage({ type: 'GET_DOCUMENT_STATUS' });
  assert.equal(
    status.processing,
    false,
    'stale processing reply must not repaint the popup Active over newer confirmed state',
  );
});

test('normal ordering keeps the latest receipt and preserves a valid current one', async () => {
  const h = await loadEnabledContent();
  assert.deepEqual(h.deferred.map((d) => d.action), ['start', 'setGain']);

  // Older START reply arrives first with a real processing receipt.
  h.deferred[0].resolve(clone(oldProcessing));
  await sleep(20);
  // Newer SET_GAIN reply confirms no attached source.
  h.deferred[1].resolve(clone(noSource));
  await sleep(20);

  const status = await h.sendMessage({ type: 'GET_DOCUMENT_STATUS' });
  assert.equal(status.processing, false, 'newest receipt wins in normal order');
  assert.equal(status.hookAlive, true, 'valid current receipt preserved');
  assert.equal(status.hookActive, true, 'armed state preserved');
});

test('stale not-alive reply cannot drop a newer valid receipt or trigger resync', async () => {
  const h = await loadEnabledContent();
  assert.deepEqual(h.deferred.map((d) => d.action), ['start', 'setGain']);

  // Newer SET_GAIN reply confirms the hook is alive on the current target.
  h.deferred[1].resolve(clone(noSource));
  await sleep(20);
  const before = h.deferred.length;

  // Older START reply arrives late claiming the hook is not alive.
  h.deferred[0].resolve({ ok: false, alive: false, active: false, error: 'gone' });
  await sleep(20);

  assert.equal(h.deferred.length, before, 'no spurious liveness resync from the stale reply');
  const status = await h.sendMessage({ type: 'GET_DOCUMENT_STATUS' });
  assert.equal(status.hookAlive, true, 'newer valid receipt is preserved');
});
