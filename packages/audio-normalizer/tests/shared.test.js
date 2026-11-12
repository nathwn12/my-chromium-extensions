const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_GAIN_DB,
  clampGainDb,
  getContentAction,
  getPopupIndicator,
  getSiteConfig,
  getSiteKey,
  getLegacySiteKey,
  legacySiteStorageKey,
  siteStorageKey,
  migrateActiveSites,
  migrateSiteSettings,
  normalizeSiteRecord,
  setSiteConfig,
  setSiteEnabled,
} = require('../shared.js');

test('getSiteKey collapses localhost ports', () => {
  assert.equal(getSiteKey('localhost:3000'), 'localhost');
  assert.equal(getSiteKey('127.0.0.1:8080'), '127.0.0.1');
});

test('getSiteKey keeps the full hostname (no shared toggles)', () => {
  assert.equal(getSiteKey('www.youtube.com'), 'www.youtube.com');
  assert.equal(getSiteKey('music.youtube.com'), 'music.youtube.com');
  // The reported defect: GitHub Pages sites must not share one toggle.
  assert.equal(getSiteKey('alice.github.io'), 'alice.github.io');
  assert.equal(getSiteKey('bob.github.io'), 'bob.github.io');
  assert.notEqual(getSiteKey('alice.github.io'), getSiteKey('bob.github.io'));
});

test('getLegacySiteKey is the read-only collapsed fallback', () => {
  assert.equal(getLegacySiteKey('www.youtube.com'), 'youtube.com');
  assert.equal(getLegacySiteKey('music.youtube.com'), 'youtube.com');
  assert.equal(getLegacySiteKey('alice.github.io'), 'github.io');
  assert.equal(legacySiteStorageKey('alice.github.io'), 'site:github.io');
  assert.equal(siteStorageKey('alice.github.io'), 'site:alice.github.io');
});

test('migrateActiveSites keeps enabled site keys', () => {
  assert.deepEqual(migrateActiveSites({
    'www.youtube.com': true,
    'music.youtube.com': true,
    'ignored.example.com': false,
  }), {
    'youtube.com': true,
  });
});

test('migrateSiteSettings preserves gain and clamps values', () => {
  assert.deepEqual(migrateSiteSettings({
    'www.youtube.com': { enabled: true, gainDb: 9.2 },
  }, {
    'music.youtube.com': true,
  }), {
    'youtube.com': { enabled: true, gainDb: 9 },
  });
});

test('migrateSiteSettings defaults gain for legacy booleans', () => {
  assert.deepEqual(migrateSiteSettings({
    'www.youtube.com': true,
  }, {}), {
    'youtube.com': { enabled: true, gainDb: 0 },
  });
});

test('setSiteConfig updates a normalized site entry', () => {
  assert.deepEqual(setSiteConfig({}, {}, 'www.youtube.com', {
    enabled: true,
    gainDb: 2.25,
  }), {
    'youtube.com': { enabled: true, gainDb: 2.5 },
  });
});

test('getSiteConfig reads legacy and normalized state', () => {
  assert.deepEqual(getSiteConfig({
    'www.youtube.com': { enabled: false, gainDb: 1 },
  }, {
    'music.youtube.com': true,
  }, 'youtube.com'), {
    siteKey: 'youtube.com',
    enabled: true,
    gainDb: 1,
  });
});

test('setSiteEnabled toggles the normalized site key', () => {
  assert.deepEqual(setSiteEnabled({
    'www.youtube.com': true,
  }, 'music.youtube.com', false), {});
});

test('clampGainDb snaps and bounds gain values', () => {
  assert.equal(clampGainDb(-7), -7);
  assert.equal(clampGainDb(0.26), 0.5);
  assert.equal(clampGainDb(12.2), 12);
  assert.equal(clampGainDb('nope'), DEFAULT_GAIN_DB);
});

test('getSiteConfig defaults gain for missing sites', () => {
  assert.equal(getSiteConfig({}, {}, 'example.com').gainDb, DEFAULT_GAIN_DB);
});

test('unset sites are fully disabled with default gain', () => {
  assert.deepEqual(getSiteConfig({}, {}, 'example.com'), {
    siteKey: 'example.com',
    enabled: false,
    gainDb: 0,
  });
});

test('stored per-site settings round-trip unchanged', () => {
  const stored = setSiteConfig({}, {}, 'www.youtube.com', {
    enabled: true,
    gainDb: 3,
  });
  assert.deepEqual(stored, {
    'youtube.com': { enabled: true, gainDb: 3 },
  });
  assert.deepEqual(getSiteConfig(stored, {}, 'music.youtube.com'), {
    siteKey: 'music.youtube.com',
    enabled: true,
    gainDb: 3,
  });
});

test('disabling a site preserves its stored gain', () => {
  const enabled = setSiteConfig({}, {}, 'youtube.com', {
    enabled: true,
    gainDb: 4,
  });
  const disabled = setSiteConfig(enabled, {}, 'youtube.com', { enabled: false });
  assert.deepEqual(disabled, {
    'youtube.com': { enabled: false, gainDb: 4 },
  });
  assert.deepEqual(getSiteConfig(disabled, {}, 'youtube.com'), {
    siteKey: 'youtube.com',
    enabled: false,
    gainDb: 4,
  });
});

test('per-site settings survive the legacy activeSites migration', () => {
  const stored = setSiteConfig({}, { 'music.youtube.com': true }, 'youtube.com', {
    gainDb: 4,
  });
  assert.deepEqual(stored, {
    'youtube.com': { enabled: true, gainDb: 4 },
  });
  assert.deepEqual(getSiteConfig({}, { 'www.youtube.com': true }, 'youtube.com'), {
    siteKey: 'youtube.com',
    enabled: true,
    gainDb: 0,
  });
});

test('partial site updates never enable spuriously', () => {
  assert.deepEqual(setSiteConfig({}, {}, 'example.com', { enabled: true }), {
    'example.com': { enabled: true, gainDb: 0 },
  });
  assert.deepEqual(setSiteConfig({}, {}, 'example.com', { gainDb: -6 }), {
    'example.com': { enabled: false, gainDb: -6 },
  });
});

test('repeated disables converge to the same stored config', () => {
  const enabled = setSiteConfig({}, {}, 'youtube.com', {
    enabled: true,
    gainDb: 4,
  });
  const once = setSiteConfig(enabled, {}, 'youtube.com', { enabled: false });
  // Mirrors the runtime order on a popup disable: background SET_SITE_STATE
  // persists enabled:false, then the live-tab SET_DOCUMENT_STATE path
  // re-reads stored truth (content-script.js is read-only and performs no
  // storage write) and converges. The second application is a no-op.
  const twice = setSiteConfig(once, {}, 'youtube.com', { enabled: false });
  assert.deepEqual(twice, once);
  assert.deepEqual(twice, {
    'youtube.com': { enabled: false, gainDb: 4 },
  });
});

test('migrateSiteSettings merges two raw keys that normalise to one site', () => {
  // Precedence: last-explicit-field-wins; absent fields preserve the earlier
  // value; the `true` shorthand asserts only enabled.
  const merged = migrateSiteSettings({
    'youtube.com': { enabled: true, gainDb: 5 },
    'www.youtube.com': { enabled: true },
  }, {});
  assert.deepEqual(merged, {
    'youtube.com': { enabled: true, gainDb: 5 },
  });
  const overwritten = migrateSiteSettings({
    'youtube.com': { enabled: true, gainDb: 5 },
    'www.youtube.com': { gainDb: 7 },
  }, {});
  assert.equal(overwritten['youtube.com'].gainDb, 7, 'later explicit gain wins');
  assert.equal(overwritten['youtube.com'].enabled, true, 'absent enabled preserves earlier true');
});

test('normalizeSiteRecord ignores an unknown legacy field on a stored record', () => {
  // A record persisted by an older version may carry fields this version no
  // longer knows. They are ignored on read and never emitted on write.
  // `excluded` is the one field added since: it is emitted as `false` when a
  // stored record predates it (no migration needed).
  assert.deepEqual(normalizeSiteRecord({
    enabled: true,
    gainDb: 3,
    seq: 0,
    mirror: true,
    legacyField: true,
  }), {
    enabled: true,
    gainDb: 3,
    seq: 0,
    mirror: true,
    excluded: false,
  });
});

test('getContentAction and getPopupIndicator reflect hook state', () => {
  assert.equal(getContentAction({ enabled: false, injected: false, hookAlive: false }), 'idle');
  assert.equal(getContentAction({ enabled: true, injected: false, hookAlive: false }), 'inject');
  assert.equal(getPopupIndicator({ enabled: true, hookAlive: true, hookActive: true, lastError: '' }), 'green');
  assert.equal(getPopupIndicator({ enabled: true, hookAlive: false, hookActive: false, lastError: 'boom' }), 'red');
});
