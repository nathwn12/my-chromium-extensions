'use strict';

/* global require, __dirname, process, setImmediate */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const src = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');

const IDS = [
  'page-title', 'reset-btn', 'status-pill', 'status-text', 'power-toggle',
  'slow-slider', 'slow-readout', 'intensity-slider', 'intensity-readout',
];

function createPopup(opts = {}) {
  const els = {};
  for (const id of IDS) {
    els[id] = {
      value: '',
      checked: false,
      textContent: '',
      disabled: false,
      dataset: {},
      _handlers: {},
      addEventListener(type, fn) {
        (this._handlers[type] = this._handlers[type] || []).push(fn);
      },
      fire(type) {
        for (const fn of this._handlers[type] || []) fn({});
      },
    };
  }

  let now = 9000;
  const persistCalls = [];
  const box = {
    console,
    URL,
    document: { getElementById: (id) => els[id] || null },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout,
    clearTimeout,
    Date: { now: () => now },
    chrome: {
      tabs: {
        query: async () => [{ id: 1, url: 'https://music.youtube.com/watch?v=abc' }],
        sendMessage: async (_id, message) => {
          if (message.type === 'GET_LIVE_STATUS') {
            return { ok: true, eligible: true, bypass: false, attachedCount: 1 };
          }
          if (message.type === 'APPLY_LIVE_SETTINGS') {
            if (opts.rejectLivePush) throw new Error('no receiver');
            return { ok: true };
          }
          return { ok: true };
        },
      },
      runtime: {
        sendMessage: async (message) => {
          if (message.type === 'GET_POPUP_STATE') {
            return { ok: true, eligible: true, bypass: false,
              settings: { slow: 1, reverbIntensity: 0, volume: null }, siteKey: 'music.youtube.com' };
          }
          if (message.type === 'SET_SITE_SETTINGS') {
            persistCalls.push(message);
            return opts.onPersist ? opts.onPersist(message) : { ok: true };
          }
          return { ok: true };
        },
      },
      storage: {
        local: {
          get: async () => ({ siteToggles: {} }),
          set: async () => {},
        },
      },
    },
  };
  vm.createContext(box);
  vm.runInContext(src('shared.js'), box, { filename: 'shared.js' });
  vm.runInContext(src('popup.js'), box, { filename: 'popup.js' });
  return { els, persistCalls, setNow: (value) => { now = value; } };
}

const settle = async () => {
  for (let i = 0; i < 15; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function withRejections(run) {
  const rejections = [];
  const handler = (error) => rejections.push(String(error && error.message ? error.message : error));
  process.on('unhandledRejection', handler);
  try {
    return { value: await run(), rejections };
  } finally {
    process.off('unhandledRejection', handler);
  }
}

function changeSlow(popup, value, now) {
  popup.setNow(now);
  popup.els['slow-slider'].value = String(value);
  popup.els['slow-slider'].fire('change');
}

test('save rejection reports an error receipt and no unhandled rejection', async () => {
  const { value: popup, rejections } = await withRejections(async () => {
    const p = createPopup({ onPersist: async () => { throw new Error('storage rejected'); } });
    await settle();
    changeSlow(p, 1.25, 9500);
    await settle();
    return p;
  });

  assert.deepEqual(rejections, []);
  assert.equal(popup.els['status-pill'].textContent, 'Error');
  assert.equal(popup.els['status-pill'].dataset.state, 'error');
  assert.match(popup.els['status-text'].textContent, /save/i);
  assert.equal(popup.els['slow-readout'].textContent, '1.25x');
});

test('unsuccessful save reply reports an error receipt', async () => {
  const { value: popup, rejections } = await withRejections(async () => {
    const p = createPopup({ onPersist: async () => ({ ok: false }) });
    await settle();
    changeSlow(p, 1.15, 9500);
    await settle();
    return p;
  });

  assert.deepEqual(rejections, []);
  assert.equal(popup.els['status-pill'].dataset.state, 'error');
  assert.match(popup.els['status-text'].textContent, /save/i);
});

test('late rejection from an older save does not clobber a newer success', async () => {
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const { value: popup, rejections } = await withRejections(async () => {
    const p = createPopup({
      onPersist: async () => {
        calls += 1;
        if (calls === 1) {
          await gate;
          throw new Error('storage rejected');
        }
        return { ok: true };
      },
    });
    await settle();
    changeSlow(p, 1.10, 9500);
    await settle();
    changeSlow(p, 1.20, 9600);
    await settle();
    releaseFirst();
    await settle();
    return p;
  });

  assert.equal(calls, 2);
  assert.deepEqual(rejections, []);
  assert.equal(popup.els['status-pill'].dataset.state, 'connected');
  assert.equal(popup.els['status-text'].textContent, 'Active');
});

test('live push failure stays a push failure, not a save receipt', async () => {
  const { value: popup, rejections } = await withRejections(async () => {
    const p = createPopup({ rejectLivePush: true });
    await settle();
    changeSlow(p, 1.05, 9500);
    await settle();
    return p;
  });

  assert.deepEqual(rejections, []);
  assert.equal(popup.els['status-pill'].dataset.state, 'connected');
  assert.equal(popup.els['status-text'].textContent, 'Active');
  assert.equal(popup.persistCalls.length, 1);
});
