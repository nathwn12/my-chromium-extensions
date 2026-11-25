'use strict';

/* global require, __dirname */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const readSource = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));

/** Snapshots at call time and holds reads behind deterministic gates. */
function makeStorage(initial = {}, opts = {}) {
  const data = clone(initial);
  let failWrites = opts.failWrites || null;
  let oneShot = null;
  let hold = null;

  return {
    async get(keys) {
      const snapshot = {};
      if (keys && typeof keys === 'object' && !Array.isArray(keys)) {
        for (const [key, fallback] of Object.entries(keys)) {
          snapshot[key] = key in data ? clone(data[key]) : clone(fallback);
        }
      } else if (typeof keys === 'string') {
        snapshot[keys] = clone(data[keys]);
      }
      const gates = [];
      if (oneShot) {
        gates.push(oneShot.promise);
        oneShot = null;
      }
      if (hold) gates.push(hold.promise);
      for (const gate of gates) await gate;
      return snapshot;
    },
    async set(items) {
      if (failWrites) throw new Error(failWrites);
      Object.assign(data, clone(items));
    },
    gateNextGet() {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      oneShot = { promise, release };
      return release;
    },
    holdReads() {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      hold = { promise, release };
      return () => { hold = null; release(); };
    },
    setFailWrites(message) { failWrites = message; },
    value(key) { return clone(data[key]); },
  };
}

function loadBackground(storage, opts = {}) {
  const listeners = [];
  const tab = { id: 1, url: 'https://music.youtube.com/watch?v=abc' };
  let tabGetCalls = 0;
  let releaseTabGet = null;
  const sandbox = {
    console,
    URL,
    TextEncoder,
    crypto: nodeCrypto.webcrypto,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async () => { throw new TypeError('Failed to fetch'); },
    chrome: {
      storage: {
        local: {
          get: (keys) => storage.get(keys),
          set: (items) => storage.set(items),
        },
        session: {
          get: async () => ({ slowedReverbRehydrated: true }),
          set: async () => {},
        },
        onChanged: { addListener: () => {} },
      },
      runtime: {
        onMessage: { addListener: (fn) => listeners.push(fn) },
        onStartup: { addListener: () => {} },
        onInstalled: { addListener: () => {} },
        getURL: (name) => name,
      },
      tabs: {
        query: async () => [tab],
        get: async (id) => {
          tabGetCalls += 1;
          if (opts.slowFirstTabGet && tabGetCalls === 1) {
            await new Promise((resolve) => { releaseTabGet = resolve; });
          }
          return id === 1 ? tab : null;
        },
        sendMessage: async () => ({ ok: true }),
        onUpdated: { addListener: () => {} },
        onRemoved: { addListener: () => {} },
        onReplaced: { addListener: () => {} },
      },
      scripting: { executeScript: async () => [] },
    },
  };
  sandbox.self = sandbox;
  sandbox.importScripts = (...files) => {
    for (const file of files) vm.runInContext(readSource(file), sandbox, { filename: file });
  };
  vm.createContext(sandbox);
  vm.runInContext(readSource('background.js'), sandbox, { filename: 'background.js' });

  assert.equal(listeners.length, 1, 'background registered one onMessage listener');

  return {
    releaseTabGet() { if (releaseTabGet) releaseTabGet(); },
    send(message, sender = {}) {
      return new Promise((resolve) => {
        const returns = listeners[0](message, sender, resolve);
        if (returns !== true) resolve(undefined);
      });
    },
  };
}

const setSiteSettings = (slow, siteKey = 'music.youtube.com') => ({
  type: 'SET_SITE_SETTINGS', tabId: 1, siteKey, settings: { slow },
});

test('F1: interleaved same-key writes keep the latest accepted value', async () => {
  const storage = makeStorage();
  const worker = loadBackground(storage);
  const release = storage.gateNextGet();

  const first = worker.send(setSiteSettings(0.8));
  const second = worker.send(setSiteSettings(1.2));
  await Promise.resolve();
  release();
  const [replyFirst, replySecond] = await Promise.all([first, second]);

  assert.equal(replyFirst.ok, true, 'first write reply accepted');
  assert.equal(replySecond.ok, true, 'second write reply accepted');
  assert.equal(replySecond.pushed, true, 'push behavior preserved');
  assert.equal(storage.value('siteSettings')['music.youtube.com'].slow, 1.2,
    'latest accepted write must win after the earlier read resumes');
});

test('F2: concurrent writes to different hosts preserve both keys', async () => {
  const storage = makeStorage();
  const worker = loadBackground(storage);
  const release = storage.holdReads();

  const first = worker.send(setSiteSettings(0.8, 'music.youtube.com'));
  const second = worker.send(setSiteSettings(1.2, 'other.example.com'));
  await Promise.resolve();
  release();
  await Promise.all([first, second]);

  const all = storage.value('siteSettings');
  assert.equal(all['music.youtube.com'].slow, 0.8, 'first host key survives');
  assert.equal(all['other.example.com'].slow, 1.2, 'second host key survives');
});

test('F3: corrupt siteSettings destination refuses the write', async () => {
  const storage = makeStorage({ siteSettings: 'junk' });
  const worker = loadBackground(storage);

  const reply = await worker.send(setSiteSettings(0.77));

  assert.equal(reply.ok, false, 'corrupt container must not claim success');
  assert.equal(storage.value('siteSettings'), 'junk', 'corrupt container stays untouched');
});

test('F3b: corrupt siteToggles destination refuses the write', async () => {
  const storage = makeStorage({ siteToggles: 'junk' });
  const worker = loadBackground(storage);

  const reply = await worker.send({ type: 'SET_TAB_BYPASS', tabId: 1, bypass: true });

  assert.equal(reply.ok, false, 'corrupt container must not claim success');
  assert.equal(storage.value('siteToggles'), 'junk', 'corrupt container stays untouched');
});

test('failed write cannot poison a later serialized write', async () => {
  const storage = makeStorage();
  const worker = loadBackground(storage);

  storage.setFailWrites('disk full');
  const failed = await worker.send(setSiteSettings(0.8));
  assert.equal(failed.ok, false, 'first write reports storage failure');

  storage.setFailWrites(null);
  const recovered = await worker.send(setSiteSettings(1.2));
  assert.equal(recovered.ok, true, 'later write still succeeds');
  assert.equal(storage.value('siteSettings')['music.youtube.com'].slow, 1.2,
    'later write persists its value');
});


const popupState = { type: 'GET_POPUP_STATE', tabId: 1 };

test('rejected bypass write must not surface as active', async () => {
  const storage = makeStorage();
  const worker = loadBackground(storage);
  storage.setFailWrites('disk full');

  const reply = await worker.send({ type: 'SET_TAB_BYPASS', tabId: 1, bypass: true });
  assert.equal(reply.ok, false, 'write failure is acknowledged');

  const state = await worker.send(popupState);
  assert.equal(state.bypass, false, 'failed bypass must not become active state');
});

test('corrupt bypass container must not surface as active', async () => {
  const storage = makeStorage({ siteToggles: 'junk' });
  const worker = loadBackground(storage);

  const reply = await worker.send({ type: 'SET_TAB_BYPASS', tabId: 1, bypass: true });
  assert.equal(reply.ok, false, 'corrupt container is acknowledged');

  const state = await worker.send(popupState);
  assert.equal(state.bypass, false, 'refused bypass must not become active state');
});

test('opposite toggles keep request order when tab lookups resolve late', async () => {
  const storage = makeStorage();
  const worker = loadBackground(storage, { slowFirstTabGet: true });

  const first = worker.send({ type: 'SET_TAB_BYPASS', tabId: 1, bypass: true });
  const second = worker.send({ type: 'SET_TAB_BYPASS', tabId: 1, bypass: false });
  await Promise.resolve();
  worker.releaseTabGet();
  await Promise.all([first, second]);

  const toggles = storage.value('siteToggles');
  assert.equal(toggles['music.youtube.com'], true, 'later off request persists last');
  const state = await worker.send(popupState);
  assert.equal(state.bypass, false, 'later off request owns the final state');
});
