'use strict';

/* global require, __dirname, setImmediate */

/*
 * test/background-section-import.test.js - local saved-section import, Node only.
 *
 * The real background.js runs in a vm context whose importScripts executes the
 * real shared.js and player-actions.js. The path under test is the worker's own
 * code: the packaged payload file, its SHA-256 marker, the one serialized save
 * chain SAVE_PLAYER_SECTION already uses, and the hidden summary.
 *
 * Every id below is synthetic. No browser, no DOM library, no audio.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const PLAYER_ACTIONS_KEY = 'playerActions';
const MARKER_KEY = 'devSectionImport';
const SUMMARY_KEY = 'devSectionImportSummary';
const LIMIT = 100;

function readSource(name) {
  return fs.readFileSync(path.join(ROOT, name), 'utf8');
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function hashOf(text) {
  return nodeCrypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function syntheticSections(count) {
  const sections = [];
  for (let index = 0; index < count; index += 1) {
    const id = String(index + 1).padStart(3, '0');
    sections.push({
      videoId: 'vid-' + id,
      startSeconds: index * 10,
      endSeconds: index * 10 + 5,
    });
  }
  return sections;
}

function olderSections(count) {
  const sections = [];
  for (let index = 0; index < count; index += 1) {
    const id = String(index + 1).padStart(3, '0');
    sections.push({ videoId: 'old-' + id, startSeconds: index, endSeconds: null });
  }
  return sections;
}

function digestOf(sections) {
  const canonical = sections
    .slice()
    .sort((left, right) => (left.videoId < right.videoId ? -1 : left.videoId > right.videoId ? 1 : 0))
    .map((entry) => [entry.videoId, entry.startSeconds, entry.endSeconds]);
  return nodeCrypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

/** chrome.storage.local with the real API shapes. */
function createStorage(initial) {
  const data = clone(initial || {});
  const setCalls = [];
  const failWrites = { message: null };
  const readsByKey = new Map();
  let gate = null;

  function snapshot(keys) {
    if (keys === null || keys === undefined) return clone(data);
    if (typeof keys === 'string') return { [keys]: clone(data[keys]) };
    if (Array.isArray(keys)) {
      const out = {};
      for (const key of keys) out[key] = clone(data[key]);
      return out;
    }
    const out = {};
    for (const [key, fallback] of Object.entries(keys || {})) {
      out[key] = key in data ? clone(data[key]) : clone(fallback);
    }
    return out;
  }

  return {
    failWrites,
    setCalls,
    readCount(key) {
      return readsByKey.get(key) || 0;
    },
    async get(keys) {
      const value = snapshot(keys);
      for (const key of Object.keys(value)) readsByKey.set(key, (readsByKey.get(key) || 0) + 1);
      if (gate) await gate;
      return value;
    },
    async set(items) {
      if (failWrites.message) throw new Error(failWrites.message);
      const copy = clone(items);
      setCalls.push(copy);
      Object.assign(data, copy);
    },
    hold() {
      let release;
      gate = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        gate = null;
        release();
      };
    },
    raw() {
      return clone(data);
    },
    playerActions() {
      return clone(data[PLAYER_ACTIONS_KEY]);
    },
    value(key) {
      return clone(data[key]);
    },
    sections() {
      const value = data[PLAYER_ACTIONS_KEY];
      return clone(value && Array.isArray(value.sections) ? value.sections : []);
    },
  };
}

/** Loads the real service worker with only the chrome surface it touches. */
function loadBackground(storage, options) {
  const opts = options || {};
  const state = { payload: opts.payload === undefined ? null : opts.payload, tabs: opts.tabs || [] };
  const runtimeListeners = [];
  const injected = [];
  const fetches = [];

  const sandbox = {
    console,
    URL,
    TextEncoder,
    crypto: opts.crypto || nodeCrypto.webcrypto,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async (url) => {
      fetches.push(String(url));
      if (state.payload === null) throw new TypeError('Failed to fetch');
      return { ok: true, text: async () => state.payload };
    },
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
        onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
        onStartup: { addListener: () => {} },
        onInstalled: { addListener: () => {} },
        getURL: (name) => 'chrome-extension://slowed-reverb/' + name,
      },
      tabs: {
        query: async () => state.tabs.slice(),
        get: async () => {
          throw new Error('No tab with id.');
        },
        sendMessage: async () => {
          throw new Error('No receiver.');
        },
        onUpdated: { addListener: () => {} },
        onRemoved: { addListener: () => {} },
        onReplaced: { addListener: () => {} },
      },
      scripting: {
        executeScript: async (call) => {
          injected.push(clone(call));
          return [];
        },
      },
    },
  };
  sandbox.self = sandbox;
  sandbox.importScripts = (...files) => {
    for (const file of files) {
      vm.runInContext(readSource(file), sandbox, { filename: file });
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(readSource('background.js'), sandbox, { filename: 'background.js' });

  assert.equal(runtimeListeners.length, 1, 'background registered one onMessage listener');
  assert.equal(typeof sandbox.SlowedReverbPlayerActions, 'object', 'real player-actions.js loaded');

  const sendMessage = (message, sender = {}) =>
    new Promise((resolve) => {
      const sendResponse = (reply) => resolve(reply);
      const returns = runtimeListeners[0](message, sender, sendResponse);
      if (returns !== true) resolve(undefined);
    });

  return {
    sandbox,
    storage,
    injected,
    fetches,
    sendMessage,
    importSections: (entries) => sandbox.importPlayerSections(entries),
    runGate: () => sandbox.runDevSectionImport(),
    setPayload(text) {
      state.payload = text;
    },
    setTabs(tabs) {
      state.tabs = tabs;
    },
  };
}

const settle = async (rounds = 10) => {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

test('background: the import is a worker-global function with no message route', async () => {
  const storage = createStorage();
  const worker = loadBackground(storage);

  assert.equal(typeof worker.sandbox.importPlayerSections, 'function');
  const reply = plain(await worker.sendMessage({ type: 'IMPORT_PLAYER_SECTIONS', entries: syntheticSections(2) }));
  assert.deepEqual(reply, { ok: false, error: 'unknown_message' });
  assert.equal(storage.setCalls.length, 0);
});

test('background: the 36 source entries land in one write', async () => {
  const storage = createStorage();
  const worker = loadBackground(storage);
  const source = syntheticSections(36);

  const result = plain(await worker.importSections(source));

  assert.equal(result.ok, true);
  assert.equal(result.imported, 36);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.sections, source);
  assert.deepEqual(storage.sections(), source);
  assert.equal(storage.setCalls.length, 1);
});

test('background: one invalid entry rejects the whole batch and writes nothing', async () => {
  const destination = { videoId: 'keep-me', startSeconds: 1, endSeconds: null };
  const storage = createStorage({ playerActions: { sections: [destination] } });
  const worker = loadBackground(storage);
  const source = syntheticSections(36);
  source[20] = { videoId: 'vid-021', startSeconds: '0:10', endSeconds: 15 };

  const result = plain(await worker.importSections(source));

  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_entry');
  assert.equal(result.index, 20);
  assert.deepEqual(storage.sections(), [destination]);
  assert.equal(storage.setCalls.length, 0);
});

test('background: a destination entry wins its videoId conflict', async () => {
  const destination = { videoId: 'vid-001', startSeconds: 3, endSeconds: 9 };
  const storage = createStorage({ playerActions: { sections: [destination] } });
  const worker = loadBackground(storage);
  const incoming = [
    { videoId: 'vid-001', startSeconds: 99, endSeconds: 100 },
    { videoId: 'vid-002', startSeconds: 30, endSeconds: null },
  ];

  const result = plain(await worker.importSections(incoming));

  assert.equal(result.ok, true);
  assert.equal(result.imported, 1);
  assert.equal(result.skipped, 1);
  assert.deepEqual(storage.sections(), [destination, incoming[1]]);
});

test('background: a malformed stored section is refused, not sanitized away', async () => {
  const valid = { videoId: 'old-001', startSeconds: 1, endSeconds: null };
  const cases = [
    { label: 'a null entry', sections: [valid, null], index: 1 },
    { label: 'a bad time', sections: [valid, { videoId: 'old-002', startSeconds: '1:00', endSeconds: null }], index: 1 },
    { label: 'a duplicate id', sections: [valid, { videoId: 'old-001', startSeconds: 5, endSeconds: null }], index: 1 },
    { label: 'a forget', sections: [valid, { videoId: 'old-002', startSeconds: null, endSeconds: null }], index: 1 },
    { label: 'a non-list sections value', sections: 'nope' },
  ];

  for (const item of cases) {
    const storage = createStorage({ playerActions: { sections: item.sections, volume: 7 } });
    const worker = loadBackground(storage);
    const before = storage.raw();

    const result = plain(await worker.importSections([{ videoId: 'vid-001', startSeconds: 2, endSeconds: 3 }]));

    assert.equal(result.ok, false, item.label);
    assert.equal(result.error, 'invalid_destination', item.label);
    if ('index' in item) assert.equal(result.index, item.index, item.label);
    assert.deepEqual(storage.raw(), before, item.label);
    assert.equal(storage.setCalls.length, 0, item.label);
  }
});

test('background: a corrupt playerActions value is refused and kept', async () => {
  for (const value of ['nope', [], 0]) {
    const storage = createStorage({ playerActions: value });
    const worker = loadBackground(storage);
    const before = storage.raw();

    const result = plain(await worker.importSections([{ videoId: 'vid-001', startSeconds: 2, endSeconds: 3 }]));

    assert.equal(result.ok, false);
    assert.equal(result.error, 'invalid_destination');
    assert.deepEqual(storage.raw(), before);
    assert.equal(storage.setCalls.length, 0);
  }
});

test('background: existing destination entries are written back verbatim', async () => {
  const destination = { videoId: 'old-001', startSeconds: 1.5, endSeconds: null, note: 'kept' };
  const storage = createStorage({ playerActions: { sections: [destination] } });
  const worker = loadBackground(storage);
  const incoming = { videoId: 'vid-001', startSeconds: 2, endSeconds: 3 };

  const result = plain(await worker.importSections([incoming]));

  assert.equal(result.ok, true);
  assert.deepEqual(storage.sections(), [destination, incoming]);
});

test('background: an import that would pass 100 entries is rejected, not capped', async () => {
  const storage = createStorage({ playerActions: { sections: olderSections(LIMIT) } });
  const worker = loadBackground(storage);
  const before = storage.raw();

  const result = plain(await worker.importSections([{ videoId: 'vid-001', startSeconds: 1, endSeconds: 2 }]));

  assert.equal(result.ok, false);
  assert.equal(result.error, 'capacity_exceeded');
  assert.equal(result.count, LIMIT + 1);
  assert.equal(result.limit, LIMIT);
  assert.deepEqual(storage.raw(), before);
  assert.equal(storage.setCalls.length, 0);
});

test('background: an import that lands exactly on 100 entries is accepted', async () => {
  const storage = createStorage({ playerActions: { sections: olderSections(64) } });
  const worker = loadBackground(storage);

  const result = plain(await worker.importSections(syntheticSections(36)));

  assert.equal(result.ok, true);
  assert.equal(result.imported, 36);
  const sections = storage.sections();
  assert.equal(sections.length, LIMIT);
  assert.equal(sections[0].videoId, 'old-001');
  assert.equal(sections[LIMIT - 1].videoId, 'vid-036');
});

test('background: other playerActions fields survive the import', async () => {
  const stored = {
    playerActions: {
      sections: [{ videoId: 'vid-001', startSeconds: 4, endSeconds: null }],
      volume: 42,
      favorites: ['vid-002'],
      repeat: { mode: 'one' },
    },
  };
  const storage = createStorage(stored);
  const worker = loadBackground(storage);

  const result = plain(await worker.importSections([{ videoId: 'vid-003', startSeconds: 7, endSeconds: 8 }]));

  assert.equal(result.ok, true);
  assert.deepEqual(storage.playerActions(), {
    sections: [
      { videoId: 'vid-001', startSeconds: 4, endSeconds: null },
      { videoId: 'vid-003', startSeconds: 7, endSeconds: 8 },
    ],
    volume: 42,
    favorites: ['vid-002'],
    repeat: { mode: 'one' },
  });
});

test('background: importing the same 36 again changes nothing', async () => {
  const storage = createStorage();
  const worker = loadBackground(storage);
  const source = syntheticSections(36);

  await worker.importSections(source);
  const again = plain(await worker.importSections(source));

  assert.equal(again.ok, true);
  assert.equal(again.imported, 0);
  assert.equal(again.skipped, 36);
  assert.deepEqual(storage.sections(), source);
  assert.equal(storage.setCalls.length, 1);
});

test('background: the import shares the one serialized save chain', async () => {
  const storage = createStorage();
  const worker = loadBackground(storage);
  const release = storage.hold();

  const saved = worker.sendMessage({
    type: 'SAVE_PLAYER_SECTION',
    entry: { videoId: 'vid-save', startSeconds: 12, endSeconds: null },
  });
  await settle();
  assert.equal(storage.readCount(PLAYER_ACTIONS_KEY), 1, 'the save read started');

  const imported = worker.importSections(syntheticSections(36));
  await settle();
  assert.equal(storage.readCount(PLAYER_ACTIONS_KEY), 1, 'the import waits behind the save');

  release();
  const saveReply = plain(await saved);
  const importReply = plain(await imported);

  assert.deepEqual(saveReply.sections.map((item) => item.videoId), ['vid-save']);
  assert.equal(importReply.ok, true);
  const ids = storage.sections().map((item) => item.videoId);
  assert.equal(ids.length, 37);
  assert.equal(ids[0], 'vid-save');
  assert.equal(ids.includes('vid-036'), true);
  assert.equal(storage.setCalls.length, 2);
});

test('background: two entries for one videoId in one batch are rejected', async () => {
  const storage = createStorage();
  const worker = loadBackground(storage);
  const source = [
    { videoId: 'vid-001', startSeconds: 1, endSeconds: 2 },
    { videoId: 'vid-001', startSeconds: 5, endSeconds: 6 },
  ];

  const result = plain(await worker.importSections(source));

  assert.equal(result.ok, false);
  assert.equal(result.error, 'duplicate_entry');
  assert.equal(result.index, 1);
  assert.deepEqual(storage.sections(), []);
  assert.equal(storage.setCalls.length, 0);
});

test('background: a failed write reports storage_failed and the chain keeps working', async () => {
  const storage = createStorage();
  const worker = loadBackground(storage);
  storage.failWrites.message = 'QUOTA_BYTES quota exceeded';

  const failed = plain(await worker.importSections(syntheticSections(36)));

  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'storage_failed');
  assert.match(failed.detail, /QUOTA/);
  assert.deepEqual(storage.sections(), []);

  storage.failWrites.message = null;
  const saved = plain(
    await worker.sendMessage({
      type: 'SAVE_PLAYER_SECTION',
      entry: { videoId: 'vid-after', startSeconds: 1, endSeconds: null },
    }),
  );

  assert.equal(saved.ok, true);
  assert.deepEqual(storage.sections().map((item) => item.videoId), ['vid-after']);
});

// The local startup gate

test('gate: a packaged file merges onto the destination and reports a receipt', async () => {
  const destination = [
    { videoId: 'vid-001', startSeconds: 3, endSeconds: 9 },
    { videoId: 'old-001', startSeconds: 1, endSeconds: null },
  ];
  const source = syntheticSections(36);
  const text = JSON.stringify({ source: 'synthetic', sections: source });
  const storage = createStorage({ playerActions: { sections: destination } });
  const worker = loadBackground(storage, {
    payload: text,
    tabs: [{ id: 7, url: 'https://music.youtube.com/' }],
  });

  const summary = plain(await worker.runGate());

  assert.equal(summary.ok, true);
  assert.equal(summary.imported, 35);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.before, 2);
  assert.equal(summary.total, 37);
  const merged = storage.sections();
  assert.equal(merged.length, 37);
  assert.deepEqual(merged[0], destination[0]);
  assert.deepEqual(merged[1], destination[1]);
  assert.equal(summary.digest, digestOf(merged));
  assert.equal(JSON.stringify(summary).includes('vid-'), false, 'the receipt carries no ids');
  assert.equal(worker.injected.length, 1);
  assert.deepEqual(plain(worker.injected[0].target), { tabId: 7 });
  assert.equal(JSON.parse(worker.injected[0].args[0]).digest, summary.digest);
  assert.equal(storage.value(MARKER_KEY).hash, hashOf(text));
});

test('gate: the same packaged hash is a no-op on the next start', async () => {
  const text = JSON.stringify({ sections: syntheticSections(3) });
  const storage = createStorage();
  const first = loadBackground(storage, { payload: text, tabs: [] });
  await first.runGate();
  const writesAfterFirst = storage.setCalls.length;
  const second = loadBackground(storage, { payload: text, tabs: [] });

  const skipped = await second.runGate();

  assert.equal(skipped, null);
  assert.equal(storage.setCalls.length, writesAfterFirst);
  assert.equal(second.injected.length, 0);
});

test('gate: a malformed file writes no sections and reports the failure', async () => {
  const storage = createStorage({
    playerActions: { sections: [{ videoId: 'keep', startSeconds: 1, endSeconds: 2 }] },
  });
  const worker = loadBackground(storage, { payload: '{', tabs: [{ id: 9, url: 'https://music.youtube.com/' }] });

  const summary = plain(await worker.runGate());

  assert.equal(summary.ok, false);
  assert.equal(summary.error, 'invalid_file');
  assert.deepEqual(storage.sections(), [{ videoId: 'keep', startSeconds: 1, endSeconds: 2 }]);
  assert.equal(worker.injected.length, 1);
});

test('gate: an invalid entry is refused whole and the receipt names the index', async () => {
  const storage = createStorage({
    playerActions: { sections: [{ videoId: 'keep', startSeconds: 1, endSeconds: 2 }] },
  });
  const source = syntheticSections(36);
  source[12] = { videoId: 'vid-013', startSeconds: null, endSeconds: null };
  const worker = loadBackground(storage, {
    payload: JSON.stringify({ sections: source }),
    tabs: [{ id: 9, url: 'https://music.youtube.com/' }],
  });

  const summary = plain(await worker.runGate());

  assert.equal(summary.ok, false);
  assert.equal(summary.error, 'invalid_entry');
  assert.equal(summary.index, 12);
  assert.deepEqual(storage.sections(), [{ videoId: 'keep', startSeconds: 1, endSeconds: 2 }]);
  assert.equal(storage.value(MARKER_KEY), undefined, 'a refused import is not marked');
});

test('gate: no eligible tab still records the receipt in storage', async () => {
  const storage = createStorage();
  const worker = loadBackground(storage, {
    payload: JSON.stringify({ sections: syntheticSections(2) }),
    tabs: [],
  });

  const summary = plain(await worker.runGate());

  assert.equal(summary.ok, true);
  assert.equal(worker.injected.length, 0);
  assert.equal(storage.value(SUMMARY_KEY).imported, 2);
});

test('gate: an absent file does nothing', async () => {
  const storage = createStorage();
  const worker = loadBackground(storage);

  const result = await worker.runGate();

  assert.equal(result, null);
  assert.deepEqual(storage.sections(), []);
  assert.equal(storage.setCalls.length, 0);
});
