importScripts('shared.js');

const backgroundShared = self.TabNormalizerShared;

const INJECTABLE_FILES = ['shared.js', 'content-script.js'];
const CONTENT_SCRIPT_ID = 'tab-normalizer-content-script';
const SUPPORTED_PROTOCOL_PATTERN = /^https?:$/i;
const RESTRICTED_URL_PATTERN = /^(chrome|chrome-extension|devtools|edge|about):/i;
const WEBSTORE_URL_PATTERN = /^https?:\/\/(chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)\b/i;
const pendingSessionStates = new Map();

// Per-site single-key storage: each site lives under ONE top-level key
// `site:<siteKey>` holding { enabled, gainDb, seq, mirror }.
// Platform fact (RESEARCH §2.1): `chrome.storage.local.set` guarantees only
// that "Any other key/value pairs in storage will not be affected" —
// top-level-key granularity. A write to `site:a.com` therefore cannot touch
// `site:b.com` by construction, unlike the old whole-map `siteSettings`
// read-modify-write where two contexts could clobber each other's sites.
// A single `set` carries the whole per-site record, so settings / mirror /
// sequence can never diverge across separate writes (defect 4) — there is no
// second write to crash between. This beats serialising (an in-memory queue):
// the queue is lost on service-worker restart (RESEARCH §1: "Any global
// variables you set will be lost"), spans no context but its own, and cannot
// help a popup direct-write racing the worker; per-site keys survive restart
// (disk) and work across contexts via the documented granularity.
// The queue below is kept only as best-effort same-worker serialisation for
// same-site concurrent handlers; cross-site safety and single-write
// divergence-freedom hold without it.
/** @type {Promise<unknown>} */
let storageWriteChain = Promise.resolve();
/**
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function withStorageWrite(task) {
  const run = storageWriteChain.then(task, task);
  storageWriteChain = run.catch(() => {});
  return run;
}

// Background is the ONLY owner of persisted state and the ONLY writer.
// The popup sends field-level intents (`{ siteKey, set: { gainDb } }` —
// only the field the user just changed). The background applies the
// intent's fields to the live record and writes the whole record back in
// one `set` (a partial `set` is a delete — see RESEARCH §10). Top-level
// `enabled`/`gainDb` on the message are legacy and are IGNORED
// when `set` is present; when `set` is absent they are treated as the intent
// for backward compatibility only.
// Ordering is last-accepted-write-wins: every accepted write bumps the
// per-site `seq` INSIDE the same single-key value (`seq = stored.seq + 1`)
// and returns it to the popup. `seq` is audit and observability only —
// never an acceptance gate. Nothing is ever rejected on ordering grounds.
// Accepted trade (deliberate): if two popups race the same field and one
// message is delayed past a newer one, the later *arrival* wins rather than
// the later *action*; there is no clock-free way to distinguish those, the
// window is milliseconds between two simultaneously-open popups, and the
// alternative (wall-clock per-field maxima) locked a field out until the
// wall clock caught up — potentially for years after a mistakenly
// future-dated write — with no restart helping because the maxima persisted.
// Do not reintroduce wall-clock comparison against stored maxima.
// Legacy `siteSeq` is read once to keep the audit counter monotonic across
// migration and never written; the per-site key's existence replaces any marker.
const SITE_SEQ_KEY = 'siteSeq';

/**
 * Read the stored per-site record, preferring the per-site key. Falls back
 * to legacy maps (`siteSettings` / `activeSites` / `siteToggles`) once and
 * migrates them in memory; the caller persists the migrated record with a
 * single per-site `set`. Never drops a stored setting: legacy values seed
 * the record, with an explicit `siteToggles` boolean winning `enabled` once
 * (the pre-fix historical diverge repair). Afterwards the per-site key
 * exists and is preferred, so a stale legacy mirror can never resurrect.
 * @param {string} siteKey normalized site key
 * @returns {Promise<{ record: { enabled: boolean, gainDb: number, seq: number, mirror: boolean, excluded: boolean, seen: boolean }, fromLegacy: boolean }>}
 */
async function readSiteRecord(siteKey) {
  const perKey = backgroundShared.siteStorageKey(siteKey);
  // Platform fact (measured Step 1 repro): an object-form key whose default
  // is `undefined` is dropped by the extension API's JSON marshal, so
  // `get({ [perKey]: undefined })` returns `{}` even when the key exists.
  // The array form is proven to return the value; missing keys are simply
  // absent and the `|| {}` fallbacks below preserve the old defaults.
  const stored = await chrome.storage.local.get([
    perKey,
    'activeSites',
    'siteSettings',
    'siteToggles',
    SITE_SEQ_KEY,
  ]);
  const existing = stored[perKey];
  if (existing && typeof existing === 'object') {
    return { record: backgroundShared.normalizeSiteRecord(existing), fromLegacy: false };
  }
  // Pre-full-key data lives under the collapsed per-site key
  // (`site:github.io`). Read it as a legacy fallback; callers persist the
  // migrated record under the FULL key on their next write (`fromLegacy`).
  // (`legacySiteStorageKey` is new in shared.js; the any-alias keeps this
  // file green until the type declaration catches up.)
  const sharedAny = /** @type {any} */ (backgroundShared);
  const legacyPerKey = typeof sharedAny.legacySiteStorageKey === 'function'
    ? sharedAny.legacySiteStorageKey(siteKey)
    : '';
  if (legacyPerKey && legacyPerKey !== perKey) {
    const legacyStored = await chrome.storage.local.get([legacyPerKey]);
    const legacyExisting = legacyStored[legacyPerKey];
    if (legacyExisting && typeof legacyExisting === 'object') {
      return { record: backgroundShared.normalizeSiteRecord(legacyExisting), fromLegacy: true };
    }
  }
  const migrated = backgroundShared.migrateLegacyToRecord(
    /** @type {Record<string, unknown>} */ (stored.siteSettings || {}),
    /** @type {Record<string, unknown>} */ (stored.activeSites || {}),
    /** @type {Record<string, unknown>} */ (stored.siteToggles || {}),
    siteKey,
  );
  if (migrated) {
    // Keep the audit counter monotonic across migration: adopt a persisted
    // legacy sequence maximum when present. `seq` is audit-only, never a
    // gate — this changes nothing about acceptance.
    const legacySeq = /** @type {Record<string, unknown>} */ (stored[SITE_SEQ_KEY] || {});
    const seqNum = Number(legacySeq[siteKey]);
    if (Number.isFinite(seqNum) && seqNum > migrated.seq) {
      migrated.seq = Math.floor(seqNum);
    }
    return { record: migrated, fromLegacy: true };
  }
  return {
    record: backgroundShared.normalizeSiteRecord({ enabled: false, seq: 0, mirror: false }),
    fromLegacy: false,
  };
}

/**
 * Persist one per-site record with a SINGLE `set` carrying a SINGLE
 * top-level key. No other key is touched.
 * @param {string} siteKey normalized site key
 * @param {{ enabled: boolean, gainDb: number, seq: number, mirror: boolean, excluded?: boolean }} record
 */
async function writeSiteRecord(siteKey, record) {
  const perKey = backgroundShared.siteStorageKey(siteKey);
  await chrome.storage.local.set({
    [perKey]: backgroundShared.normalizeSiteRecord(record),
  });
}

// Automatic reload on the one enable that has no hook to start (the first-ever
// enable of a host on an already-loaded document). The delay lets the popup
// paint its "Reloading to activate…" state before the document goes away; the
// reload itself is the ONLY navigation this extension ever performs, and it
// happens once per host, ever.
const FIRST_ENABLE_RELOAD_DELAY_MS = 500;
const RELOAD_NOTICE_MESSAGE = 'Enabled. Reload applies this.';
const RELOADING_MESSAGE = 'Reloading to activate…';

/**
 * Reload one tab, once. Answers false — never throws — when there is no tab to
 * reload or the platform refuses, so the caller can fall back to the notice.
 * @param {unknown} tabId
 * @returns {Promise<boolean>}
 */
async function reloadTabOnce(tabId) {
  if (typeof tabId !== 'number' || !Number.isFinite(tabId)) return false;
  if (!chrome.tabs || typeof chrome.tabs.reload !== 'function') return false;
  await new Promise((resolve) => setTimeout(resolve, FIRST_ENABLE_RELOAD_DELAY_MS));
  try {
    await Promise.resolve(chrome.tabs.reload(tabId));
    return true;
  } catch (e) {
    console.warn('[bg] first-enable reload failed, falling back to the notice:', String(e));
    return false;
  }
}

/**
 * The MAIN-world call the worker makes on the hook. Self-contained: Chrome
 * serializes it into the frame. It only reaches the hook through the dispatcher
 * and the token; a page calling the dispatcher without the token gets nothing.
 */
function tnHookControl(action, payload) {
  const entry = /** @type {any} */ (globalThis).__tnHookV6;
  if (typeof entry !== 'function') {
    return { ok: false, alive: false, active: false, error: 'No hook in this frame.' };
  }
  try {
    return entry(action, payload);
  } catch (e) {
    return { ok: false, alive: false, active: false, error: String((e && e.message) || e) };
  }
}

/**
 * Broadcast teardown into EVERY frame of a tab. Each frame forwards to its own
 * hook (if it has one) with the tab token; frames without a hook are no-ops.
 */
function tnHookTeardownAll(mode) {
  const entry = /** @type {any} */ (globalThis).__tnHookV6;
  if (typeof entry !== 'function') return { ok: true, stopped: 0 };
  try {
    entry(mode === 'destroy' ? 'destroy' : 'stop', null);
  } catch {}
  return { ok: true, stopped: 1 };
}

/**
 * Control a single frame's hook. Every call is an injection from the worker;
 * there is no page-reachable route to this decision.
 * @param {number} tabId
 * @param {number} frameId
 * @param {string} action
 * @param {Record<string, unknown>} payload
 */
async function controlHookFrame(tabId, frameId, action, payload) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: tnHookControl,
      args: [action, payload || {}],
      world: 'MAIN',
    });
    const result = (results || [])
      .map((entry) => entry && entry.result)
      .find((value) => value && typeof value === 'object');
    if (!result) return { ok: false, alive: false, active: false, error: 'No hook in this frame.' };
    return result;
  } catch (e) {
    return { ok: false, alive: false, active: false, error: String((e && e.message) || e) };
  }
}

/**
 * Worker-driven teardown for every frame of a tab, used when exclusion must
 * take effect immediately and reliably (the content script may be mid-read,
 * hung, or already detached).
 * @param {number} tabId
 * @param {'stop'|'destroy'} mode
 */
async function teardownTabHook(tabId, mode) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: tnHookTeardownAll,
      args: [mode],
      world: 'MAIN',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Teardown for every open tab whose host is the key or one of its descendants.
 * @param {string} siteKey
 * @param {{ includeDescendants?: boolean, mode?: 'stop'|'destroy' }} [options]
 */
async function teardownHooksForSite(siteKey, options = {}) {
  if (!siteKey) return;
  const includeDescendants = options.includeDescendants === true;
  const mode = options.mode === 'stop' ? 'stop' : 'destroy';
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  for (const tab of tabs) {
    if (!tab.id) continue;
    const tabKey = getTabSiteKey(tab);
    if (!tabKey) continue;
    const matches = tabKey === siteKey
      || (includeDescendants && backgroundShared.hostMatchesSiteKey(tabKey, siteKey));
    if (!matches) continue;
    await teardownTabHook(tab.id, mode);
  }
}

/**
 * Exclusion outranks everything else: an excluded site is inactive whatever
 * `enabled`, browser site access, or a transient session override says.
 * The rule is the host's own record OR any parent host's (`h === key ||
 * h.endsWith('.' + key)`), so excluding `tiktok.com` also covers
 * `www.tiktok.com`. Parents include the bare one (`com`, `localhost`).
 *
 * FAIL CLOSED: a storage read error, or a host that cannot be resolved at all,
 * answers "blocked" — an unknown truth is never permission to inject.
 * @param {string} siteKey
 * @returns {Promise<boolean>} true when the host must stay inactive
 */
async function isSiteBlocked(siteKey) {
  if (!siteKey) return true;
  const keys = [siteKey]
    .concat(backgroundShared.ancestorSiteKeys(siteKey))
    .map((key) => backgroundShared.siteStorageKey(key))
    .filter(Boolean);
  let stored;
  try {
    stored = await chrome.storage.local.get(keys);
  } catch {
    return true;
  }
  return keys.some((key) => {
    const value = stored[key];
    return Boolean(value && typeof value === 'object' && value.excluded === true);
  });
}

/**
 * The host keys that are currently excluded, as one read. `ok: false` means the
 * read failed: callers must then inject nothing (fail closed).
 * @returns {Promise<{ ok: boolean, hosts: string[] }>}
 */
async function readExcludedHosts() {
  try {
    const all = /** @type {Record<string, unknown>} */ (await chrome.storage.local.get(null));
    const records = collectPerSiteRecords(all);
    /** @type {string[]} */
    const hosts = [];
    for (const [siteKey, record] of records) {
      if (record.excluded) hosts.push(siteKey);
    }
    return { ok: true, hosts };
  } catch {
    return { ok: false, hosts: [] };
  }
}

/**
 * The frame gate. Chrome serializes this function and runs it inside every
 * target frame, in that frame's own world, BEFORE any product file. Its first
 * statement resolves the frame's own hostname, so an excluded cross-origin
 * iframe is decided by its OWN origin and never by its embedder's.
 *
 * It also stages the per-tab hook token for the MAIN-world file (which deletes
 * it on read) and drops any page-seeded control surface first, so a page cannot
 * pre-seed, hijack or replay the dispatcher. It touches no DOM, listener or
 * timer. Must stay self-contained: no closure over background.js scope.
 * @param {string[]} excludedHosts
 */
function installFrameGate(excludedHosts) {
  const host = String((typeof location !== 'undefined' && location.hostname) || '')
    .toLowerCase()
    .replace(/\.+$/, '');
  const hosts = Array.isArray(excludedHosts) ? excludedHosts.slice() : [];
  const excluded = Boolean(host) && hosts.some(
    (key) => key === host || host.endsWith('.' + key),
  );
  const report = { host, excluded };
  try {
    // Anything the page may have planted is removed before we write ours.
    try { delete globalThis.__tnHookV6; } catch {}
    globalThis.__tabNormalizerExclusionCache = { hosts };
    globalThis.__tabNormalizerFrameGate = report;
  } catch {}
  return report;
}

/**
 * Run {@link installFrameGate} in the given frames.
 * @param {chrome.scripting.InjectionTarget} target
 * @param {'ISOLATED'|'MAIN'} world
 * @returns {Promise<{ ok: boolean, error?: string, frames: Array<{ frameId?: number, host?: string, excluded?: boolean }> }>}
 */
async function injectFrameGate(target, world) {
  const excluded = await readExcludedHosts();
  if (!excluded.ok) {
    return { ok: false, error: 'Exclusion state unavailable; injection refused.', frames: [] };
  }
  try {
    const results = await chrome.scripting.executeScript({
      target,
      func: installFrameGate,
      args: [excluded.hosts],
      world,
    });
    const frames = (results || [])
      .filter((entry) => entry && entry.result && typeof entry.result === 'object')
      .map((entry) => ({ frameId: entry.frameId, ...entry.result }));
    return { ok: true, frames };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), frames: [] };
  }
}

/**
 * Extract the field-level intent from a SET_SITE_STATE message. New callers
 * send `set` with ONLY the changed fields (e.g. `{ gainDb: 6 }`). When `set`
 * is present, top-level `enabled`/`gainDb` are IGNORED — they
 * are a cached snapshot that would let a sibling popup overwrite unrelated
 * newer fields. When `set` is absent, fall back to top-level fields for
 * backward compatibility with older callers/tests.
 * @param {Record<string, unknown>} message
 */
function extractIntentSet(message) {
  const rawSet = /** @type {unknown} */ (message.set);
  if (rawSet && typeof rawSet === 'object') {
    const src = /** @type {Record<string, unknown>} */ (rawSet);
    /** @type {Record<string, unknown>} */
    const out = {};
    if (Object.prototype.hasOwnProperty.call(src, 'enabled')) out.enabled = Boolean(src.enabled);
    if (Object.prototype.hasOwnProperty.call(src, 'gainDb')) out.gainDb = backgroundShared.clampGainDb(src.gainDb);
    if (Object.prototype.hasOwnProperty.call(src, 'excluded')) out.excluded = Boolean(src.excluded);
    return out;
  }
  /** @type {Record<string, unknown>} */
  const legacy = {};
  if (Object.prototype.hasOwnProperty.call(message, 'enabled')) legacy.enabled = Boolean(message.enabled);
  if (Object.prototype.hasOwnProperty.call(message, 'gainDb')) legacy.gainDb = backgroundShared.clampGainDb(message.gainDb);
  if (Object.prototype.hasOwnProperty.call(message, 'excluded')) legacy.excluded = Boolean(message.excluded);
  return legacy;
}

/**
 * Migrate legacy `activeSites` enables into per-site keys, clearing ONLY
 * the entries actually consumed. An entry whose canonical site already has
 * a per-site record is left untouched (not consumed): clearing it would be
 * data loss with no migration to back it up. Safe across crashes: reads
 * prefer per-site keys, so a crash between the per-site writes and the
 * partial clear leaves duplicates that the per-site key still outranks.
 */
async function migrateActiveSitesOnce() {
  return withStorageWrite(async () => {
    const stored = await chrome.storage.local.get({ activeSites: {}, siteSettings: {}, siteToggles: {}, siteSeq: {} });
    const activeSites = /** @type {Record<string, unknown>} */ (stored.activeSites || {});
    const activeKeys = Object.keys(activeSites).filter((k) => Boolean(activeSites[k]));
    if (activeKeys.length === 0) return { changed: false };
    /** @type {string[]} */
    const consumed = [];
    for (const rawKey of activeKeys) {
      const siteKey = backgroundShared.getSiteKey(rawKey);
      if (!siteKey) continue;
      const perKey = backgroundShared.siteStorageKey(siteKey);
      const existing = await chrome.storage.local.get([perKey]);
      const migrated = backgroundShared.migrateLegacyToRecord(
        /** @type {Record<string, unknown>} */ (stored.siteSettings || {}),
        /** @type {Record<string, unknown>} */ (stored.activeSites || {}),
        /** @type {Record<string, unknown>} */ (stored.siteToggles || {}),
        siteKey,
      );
      if (existing[perKey] && typeof existing[perKey] === 'object') {
        // Per-site already exists: only clear when it already reflects this
        // legacy entry (same enabled/gain) — i.e. the legacy was
        // consumed by an earlier migration (e.g. GET_SITE_STATE). Otherwise
        // leave it: clearing un-consumed data is data loss.
        if (!migrated) continue;
        const cur = backgroundShared.normalizeSiteRecord(existing[perKey]);
        if (cur.enabled !== migrated.enabled
          || cur.gainDb !== migrated.gainDb) continue;
        consumed.push(rawKey);
        continue;
      }
      if (migrated) {
        // Same legacy-sequence preservation as the ordinary read path
        // (readSiteRecord): adopt a persisted legacy sequence maximum so the
        // audit counter stays monotonic across migration. `seq` is audit-only.
        const legacySeq = /** @type {Record<string, unknown>} */ (stored.siteSeq || {});
        const seqNum = Number(legacySeq[siteKey]);
        if (Number.isFinite(seqNum) && seqNum > migrated.seq) {
          migrated.seq = Math.floor(seqNum);
        }
        await chrome.storage.local.set({ [perKey]: migrated });
        consumed.push(rawKey);
      }
    }
    if (consumed.length === 0) return { changed: false };
    // Remove ONLY consumed raw keys; any un-consumed entry survives.
    const nextActives = { ...activeSites };
    for (const k of consumed) delete nextActives[k];
    await chrome.storage.local.set({ activeSites: nextActives });
    return { changed: true };
  });
}

function canAccessTabUrl(url) {
  if (typeof url !== 'string' || !url || RESTRICTED_URL_PATTERN.test(url) || WEBSTORE_URL_PATTERN.test(url)) {
    return false;
  }

  try {
    return SUPPORTED_PROTOCOL_PATTERN.test(new URL(url).protocol);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Registration-time enforcement (layer 1).
//
// The content script is no longer a static `<all_urls>` manifest entry: it is
// registered dynamically and ONLY for hosts whose stored record can be active.
// A host with no record, or a disabled one, gets no injection at all — the
// twenty-four-hours-a-day `document_start` script on every page of every site
// is gone. Excluded hosts are additionally listed in `excludeMatches`, so a
// subdomain of an excluded host is refused by the browser itself.
//
// Re-registration is triggered by install, startup, and every storage change
// that moves `enabled` or `excluded` (see the `site:<key>` change loop at the
// bottom of this file). Gain changes never re-register: matches do not depend
// on gain.
// ---------------------------------------------------------------------------

/**
 * Every per-site record in storage, keyed by site key (full hostname).
 * @param {Record<string, unknown>} all
 */
function collectPerSiteRecords(all) {
  /** @type {Map<string, { enabled: boolean, gainDb: number, seq: number, mirror: boolean, excluded: boolean, seen: boolean }>} */
  const records = new Map();
  for (const [key, value] of Object.entries(all || {})) {
    if (!backgroundShared.isSiteStorageKey(key) || !value || typeof value !== 'object') continue;
    const siteKey = backgroundShared.siteKeyFromStorageKey(key);
    if (!siteKey) continue;
    records.set(siteKey, backgroundShared.normalizeSiteRecord(value));
  }
  return records;
}

/**
 * Legacy-only enables: a site switched on before per-site records existed and
 * never written since. They keep working, and they keep the WILDCARD match
 * (a collapsed `youtube.com` key legitimately covers every `*.youtube.com`
 * host through the legacy read fallback), so registration loses nothing.
 * @param {Record<string, unknown>} all
 * @param {Map<string, unknown>} records
 */
function collectLegacyEnabledSiteKeys(all, records) {
  /** @type {Set<string>} */
  const out = new Set();
  const siteSettings = /** @type {Record<string, unknown>} */ ((all && all.siteSettings) || {});
  const activeSites = /** @type {Record<string, unknown>} */ ((all && all.activeSites) || {});
  const siteToggles = /** @type {Record<string, unknown>} */ ((all && all.siteToggles) || {});
  /** @type {Set<string>} */
  const candidates = new Set();
  for (const raw of Object.keys(siteSettings)) {
    const k = backgroundShared.getSiteKey(raw);
    if (k) candidates.add(k);
  }
  for (const [raw, value] of Object.entries(activeSites)) {
    if (!Boolean(value)) continue;
    const k = backgroundShared.getSiteKey(raw);
    if (k) candidates.add(k);
  }
  for (const [raw, value] of Object.entries(siteToggles)) {
    if (typeof value !== 'boolean') continue;
    const k = backgroundShared.getSiteKey(raw);
    if (k) candidates.add(k);
  }
  for (const candidate of candidates) {
    if (records.has(candidate)) continue;
    const migrated = backgroundShared.migrateLegacyToRecord(siteSettings, activeSites, siteToggles, candidate);
    if (migrated && migrated.enabled) out.add(candidate);
  }
  return out;
}

/**
 * The content-script registration implied by stored truth.
 *
 * `matches` and `excludeMatches` are disjoint by construction: a key is
 * dropped from the active set when it IS an excluded key or a DESCENDANT of
 * one (the suffix rule covers both). A legacy-only key contributes a wildcard
 * match, which would overlap an excluded descendant — it falls back to its
 * exact host in that case, leaving the descendant to `excludeMatches` alone.
 * @returns {Promise<{ matches: string[], excludeMatches: string[], seq: number }>}
 */
async function deriveContentScriptRegistration() {
  // The stamp is carried with the derivation: an older read must never win.
  const all = /** @type {Record<string, unknown>} */ (await chrome.storage.local.get(null));
  const records = collectPerSiteRecords(all);
  /** @type {string[]} */
  const excludedHosts = [];
  for (const [siteKey, record] of records) {
    if (record.excluded) excludedHosts.push(siteKey);
  }
  const isCoveredByExclusion = (siteKey) => backgroundShared.isHostExcluded(siteKey, excludedHosts);

  /** @type {string[]} */
  const exactActive = [];
  for (const [siteKey, record] of records) {
    // `seen || enabled`: a host the user has enabled at least once keeps the
    // document_start pair so a later enable is live on the already-loaded page.
    // A never-seen host keeps the zero-cost path (no registration at all).
    if (record.excluded || !(record.enabled || record.seen)) continue;
    if (isCoveredByExclusion(siteKey)) continue;
    exactActive.push(siteKey);
  }
  /** @type {string[]} */
  const legacyWildcard = [];
  /** @type {string[]} */
  const legacyExact = [];
  for (const siteKey of collectLegacyEnabledSiteKeys(all, records)) {
    if (isCoveredByExclusion(siteKey)) continue;
    const wouldOverlap = excludedHosts.some((excludedKey) => (
      excludedKey !== siteKey && backgroundShared.hostMatchesSiteKey(excludedKey, siteKey)
    ));
    (wouldOverlap ? legacyExact : legacyWildcard).push(siteKey);
  }
  const matches = backgroundShared.siteHostMatchPatterns(exactActive)
    .concat(backgroundShared.siteHostMatchPatterns(legacyExact))
    .concat(backgroundShared.siteExcludeMatchPatterns(legacyWildcard));
  let seq = 0;
  for (const record of records.values()) {
    if (Number.isFinite(record.seq) && record.seq > seq) seq = record.seq;
  }
  return {
    matches,
    excludeMatches: backgroundShared.siteExcludeMatchPatterns(excludedHosts),
    seq,
  };
}

/**
 * Does the descriptor the browser actually holds already say what the records
 * derive? Reconciliation runs on every worker wake, so it must not rewrite an
 * identical descriptor (that is churn, not healing). Only the fields that decide
 * injection are compared.
 * @param {chrome.scripting.RegisteredContentScript|null} current
 * @param {chrome.scripting.RegisteredContentScript} wanted
 */
function registrationMatchesDerivation(current, wanted) {
  if (!current) return false;
  const sorted = (list) => Array.from(new Set(list || [])).sort();
  if (!Array.isArray(current.js) || current.js.join('|') !== (wanted.js || []).join('|')) return false;
  if (sorted(current.matches).join('|') !== sorted(wanted.matches).join('|')) return false;
  if (sorted(current.excludeMatches).join('|') !== sorted(wanted.excludeMatches).join('|')) return false;
  if (current.runAt !== wanted.runAt) return false;
  if (current.allFrames !== wanted.allFrames) return false;
  if (wanted.world && current.world && current.world !== wanted.world) return false;
  if (typeof current.matchOriginAsFallback === 'boolean'
    && current.matchOriginAsFallback !== wanted.matchOriginAsFallback) return false;
  return true;
}

/**
 * One registration pass. Runs INSIDE the chain: derivation is re-done here, the
 * last applied `seq` is checked, and the write happens before the lock is
 * released, so an older read cannot install a stale persistent descriptor.
 *
 * The remaining two layers (the content-script gate and the background's own
 * injection refusal) still hold, so registration trouble degrades the extension
 * rather than breaking it outright. What it must never do is keep a descriptor
 * the records contradict.
 *
 * FAIL CLOSED: when the write that would correct a descriptor rejects, the
 * descriptor is dropped before the error is rethrown. An uncorrectable
 * registration must never keep matching a host the records exclude; the bounded
 * retry (and the next wake) rebuild it.
 */
async function applyRegistrationOnce() {
  if (!chrome.scripting || typeof chrome.scripting.registerContentScripts !== 'function') return;
  const derived = await deriveContentScriptRegistration();
  if (derived.seq < lastAppliedRegistrationSeq) return;
  const { matches, excludeMatches } = derived;
  const existing = typeof chrome.scripting.getRegisteredContentScripts === 'function'
    ? await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] })
    : [];
  const current = (existing || []).find((entry) => entry && entry.id === CONTENT_SCRIPT_ID) || null;
  if (matches.length === 0) {
    const known = typeof chrome.scripting.getRegisteredContentScripts === 'function'
      ? existing.length > 0
      : true;
    if (known) await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    lastAppliedRegistrationSeq = derived.seq;
    registrationRetryCount = 0;
    return;
  }
  /** @type {chrome.scripting.RegisteredContentScript} */
  const descriptor = {
    id: CONTENT_SCRIPT_ID,
    js: INJECTABLE_FILES,
    matches,
    excludeMatches,
    runAt: 'document_start',
    allFrames: true,
    matchOriginAsFallback: true,
    world: 'ISOLATED',
    persistAcrossSessions: true,
  };
  if (registrationMatchesDerivation(current, descriptor)) {
    // Already reconciled: this wake has nothing to write.
    lastAppliedRegistrationSeq = derived.seq;
    registrationRetryCount = 0;
    return;
  }
  try {
    if (current) {
      await chrome.scripting.updateContentScripts([descriptor]);
    } else {
      await chrome.scripting.registerContentScripts([descriptor]);
    }
  } catch (error) {
    // FAIL CLOSED, and say so when the platform will not let us be closed: with
    // BOTH the correcting write and the removal rejected, no API is left to
    // remove a descriptor that may still match an excluded host. That is an
    // OS-level failure — reported loudly ONCE (not once per retry) and left to
    // the bounded retry and the next wake, which is where it heals.
    let removalError = null;
    try {
      if (typeof chrome.scripting.unregisterContentScripts === 'function') {
        await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
      }
    } catch (e) {
      removalError = e;
    }
    if (removalError && !registrationRemovalFailureReported) {
      registrationRemovalFailureReported = true;
      console.error(
        '[bg] REGISTRATION STUCK: the content-script descriptor could not be updated and could not be removed,'
        + ' so it may still match an excluded host until a later worker wake repairs it.',
        String(error),
        String(removalError),
      );
    }
    throw error;
  }
  lastAppliedRegistrationSeq = derived.seq;
  registrationRetryCount = 0;
  registrationRemovalFailureReported = false;
}

async function runRegistrationPass() {
  try {
    await applyRegistrationOnce();
  } catch (e) {
    // A failed first registration would leave enabled sites with no
    // document-start script at all, so it is retried with bounded backoff and
    // re-armed by the next storage change, startup or alarm.
    console.warn('[bg] content-script registration failed, will retry:', String(e));
    scheduleRegistrationRetry();
  }
}

/**
 * Every registration sync goes through ONE promise chain (a mutex). Two
 * concurrent syncs used to race their storage reads: an older derivation could
 * land after a newer one and persist a descriptor that outlives the worker.
 */
function syncContentScriptRegistration() {
  const run = registrationChain.then(runRegistrationPass, runRegistrationPass);
  registrationChain = run.catch(() => {});
  return run;
}

function scheduleRegistrationRetry() {
  if (registrationRetryTimer) return;
  if (registrationRetryCount >= REGISTRATION_RETRY_MAX) return;
  const delay = REGISTRATION_RETRY_BASE_MS * Math.pow(2, registrationRetryCount);
  registrationRetryCount += 1;
  registrationRetryTimer = setTimeout(() => {
    registrationRetryTimer = null;
    void syncContentScriptRegistration();
  }, delay);
}

// Coalesced re-registration: a burst of writes (toggle + gain + exclusion)
// costs one registration pass, not one per write.
let registrationSyncTimer = null;
/** @type {Promise<unknown>} */
let registrationChain = Promise.resolve();
let lastAppliedRegistrationSeq = -1;
let registrationRetryCount = 0;
// Rule 7's documented limit: both the correcting write AND the removal rejected,
// so nothing API-level is left. Reported once per stuck incident, never per retry.
let registrationRemovalFailureReported = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let registrationRetryTimer = null;
const REGISTRATION_RETRY_BASE_MS = 250;
const REGISTRATION_RETRY_MAX = 5;
function scheduleRegistrationSync() {
  if (registrationSyncTimer) return;
  registrationSyncTimer = setTimeout(() => {
    registrationSyncTimer = null;
    void syncContentScriptRegistration();
  }, 0);
}

function getTabSiteKey(tab) {
  if (!canAccessTabUrl(tab?.url)) {
    return '';
  }

  return backgroundShared.getSiteKey(backgroundShared.extractHostname(tab.url));
}

// A tab matches a broadcast site key on the FULL key or the legacy
// collapsed key (pre-full-key tabs and records compare collapsed).
function tabMatchesSiteKey(tabUrl, siteKey) {
  if (typeof tabUrl !== 'string' || !siteKey) return false;
  const hostname = backgroundShared.extractHostname(tabUrl);
  return backgroundShared.getSiteKey(hostname) === siteKey
    || backgroundShared.getLegacySiteKey(hostname) === siteKey;
}

// Coalesced broadcast: one storage write (or a same-tick burst of them)
// produces exactly ONE broadcast per site with the re-read truth. Rapid
// slider persists collapse here instead of fanning out per write.
const pendingBroadcastSites = new Set();
let broadcastFlushTimer = null;
function scheduleSiteBroadcast(siteKey) {
  if (!siteKey) return;
  pendingBroadcastSites.add(siteKey);
  if (broadcastFlushTimer) return;
  broadcastFlushTimer = setTimeout(() => {
    broadcastFlushTimer = null;
    const sites = Array.from(pendingBroadcastSites);
    pendingBroadcastSites.clear();
    for (const site of sites) {
      flushSiteBroadcast(site);
    }
  }, 0);
}
function flushSiteBroadcast(siteKey) {
  chrome.tabs.query({}, (tabs) => {
    void (async () => {
      let current;
      try {
        const { record } = await readSiteRecord(siteKey);
        // Stale broadcast: stored truth moved on (e.g. re-enabled after
        // this disable change). Send the current truth. Fail closed: when
        // the re-read itself fails the truth is unknown, so send nothing
        // rather than a possibly stale captured change.
        current = record;
      } catch {
        // Fail closed on a read failure: no broadcast without truth.
        return;
      }
      tabs.forEach(tab => {
        if (!tab.url || !tab.id) return;
        const tabKey = getTabSiteKey(tab);
        // Ancestry: the record's key AND its descendants. Top-URL equality
        // alone missed `a.example.com` when `example.com` was excluded.
        if (!tabKey) return;
        if (tabKey !== siteKey && !backgroundShared.hostMatchesSiteKey(tabKey, siteKey)) return;
        // Every frame, no frameId filter: a cross-origin iframe of the
        // affected host does not share the tab's top-level URL, and exclusion
        // must reach it immediately instead of through its own storage read.
        chrome.tabs.sendMessage(tab.id, {
          type: 'TOGGLE_CHANGED',
          siteKey,
          enabled: current.enabled,
          gainDb: current.gainDb,
          // Live teardown: the content script stops on this flag without a
          // storage read. Exclusion outranks `enabled` at the tab.
          excluded: current.excluded,
        }).catch(() => {});
      });
    })();
  });
}


async function injectMainWorldScript(tabId, file, frameId) {
  // Frame-targeted MAIN-world injection: a video inside a cross-origin
  // iframe runs in its own frame, so the top-frame default never reaches it.
  // Content scripts run in every frame (all_frames) and their sender carries
  // the originating frameId — target exactly that frame. A missing frameId
  // means a tab-level call (no sender frame): default to frame 0 only then.
  const target = (typeof frameId === 'number' && Number.isFinite(frameId))
    ? { tabId, frameIds: [frameId] }
    : { tabId };
  // Frame gate first, in the MAIN world of the target frame: its own hostname
  // decides, not the embedder's. It also stages the per-tab token the hook file
  // consumes, and clears any page-seeded surface.
  const gate = await injectFrameGate(target, 'MAIN');
  if (!gate.ok) {
    return { ok: false, error: gate.error || 'Frame gate failed.' };
  }
  if (gate.frames.length > 0 && gate.frames.every((frame) => frame.excluded)) {
    return { ok: false, error: 'Frame is excluded; page hook not injected.' };
  }
  try {
    await chrome.scripting.executeScript({
      target,
      files: [file],
      world: 'MAIN',
    });
    return { ok: true };
  } catch (e) {
    // A frame that disappears mid-call (navigation, removal) is a routine
    // race: return an error object, never throw, so the caller reports
    // status instead of faulting the message channel.
    return { ok: false, error: String(e && e.message || e) };
  }
}

function contentScriptPresence() {
  return Boolean(/** @type {any} */ (globalThis).__tabNormalizerContentScriptV5);
}

/**
 * Inject the ISOLATED pair into exactly the frames that do not have it.
 *
 * Per-frame, by frameIds: the old code asked frame 0 and skipped the WHOLE tab
 * when it answered, so a detached embedded frame never revived. Presence is
 * read in the ISOLATED world of each frame (where the content script lives),
 * so a frame that gated itself out is correctly reported as missing.
 * @param {number} tabId
 */
async function injectMissingFrames(tabId) {
  const gate = await injectFrameGate({ tabId, allFrames: true }, 'ISOLATED');
  if (!gate.ok) {
    throw new Error(gate.error || 'Frame gate failed.');
  }
  const present = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: contentScriptPresence,
    world: 'ISOLATED',
  });
  /** @type {number[]} */
  const missing = [];
  for (const entry of present || []) {
    if (!entry || typeof entry.frameId !== 'number') continue;
    if (entry.result !== true) missing.push(entry.frameId);
  }
  if (missing.length === 0) return;
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: missing },
    files: INJECTABLE_FILES,
  });
}

async function injectTabScripts(tabId) {
  await injectMissingFrames(tabId);
}

async function getPendingSessionStates() {
  return Object.fromEntries(pendingSessionStates);
}

async function setPendingSessionState(tabId, value) {
  if (!tabId) return;

  const key = String(tabId);
  if (value) {
    pendingSessionStates.set(key, value);
  } else {
    pendingSessionStates.delete(key);
  }
}

async function tryApplyPendingSessionState(tabId, tab) {
  if (!tabId) return false;

  const pending = await getPendingSessionStates();
  const entry = pending[String(tabId)];
  if (!entry) return false;

  if (!canAccessTabUrl(tab?.url)) {
    return false;
  }

  if (getTabSiteKey(tab) !== entry.siteKey) {
    return false;
  }

  // Exclusion outranks a transient session override.
  if (await isSiteBlocked(entry.siteKey)) {
    return false;
  }

  try {
    await injectTabScripts(tabId);

    await chrome.tabs.sendMessage(tabId, {
      type: 'SET_DOCUMENT_STATE',
      siteKey: entry.siteKey,
      enabled: Boolean(entry.enabled),
      gainDb: entry.gainDb,
      // Genuine transient: the tab installs a session override for this and
      // only this flagged shape. Ordinary persisted saves arrive unflagged and
      // read storage instead.
      transient: true,
    }, { frameId: 0 });
    return true;
  } catch (error) {
    console.warn('[bg] pending session apply failed:', tabId, String(error));
    return false;
  }
}

async function softRecheckDocument(tabId, siteKey) {
  if (!tabId) {
    return { ok: false, error: 'Missing tabId.' };
  }

  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, error: 'Tab unavailable.' };
  }

  if (!canAccessTabUrl(tab?.url)) {
    return { ok: true, activation: { state: 'restricted', message: 'Enabled. Reload on a supported page.' } };
  }

  if (siteKey && getTabSiteKey(tab) !== siteKey) {
    return { ok: true, activation: { state: 'idle' } };
  }

  // Exclusion beats a soft wake: nothing is injected, nothing runs.
  if (await isSiteBlocked(siteKey || getTabSiteKey(tab))) {
    return { ok: true, activation: { state: 'idle' } };
  }

  // This never injects. It asks a document that already has the content script
  // to re-read its truth (stop or adjust); a document without one is reported
  // as "enabled, applies on reload" instead of being armed. No reload is
  // triggered from here: a slider soft-wake is not an enable, so the notice is
  // the honest answer (the automatic reload belongs to a first-ever enable).
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'SOFT_RECHECK_DOCUMENT' }, { frameId: 0 });
  } catch {
    return { ok: true, activation: { state: 'reload', message: RELOAD_NOTICE_MESSAGE } };
  }
}

/**
 * Inject the ISOLATED pair into open tabs of a site.
 * @param {string} siteKey
 * @param {{ includeDescendants?: boolean }} [options] descendants of the key
 *   count too — an undo at `example.com` must revive open `a.example.com` tabs,
 *   which were torn down with their own (now stale) exclusion cache.
 */
async function syncExistingTabsForSite(siteKey, options = {}) {
  if (!siteKey) {
    return;
  }

  // Layer 3, batch path (enable, startup re-inject, un-exclude): an excluded
  // host is never injected, not even with the ISOLATED pair.
  if (await isSiteBlocked(siteKey)) {
    return;
  }

  const includeDescendants = options.includeDescendants === true;
  const tabs = await chrome.tabs.query({});
  const matchingTabs = tabs.filter((tab) => {
    const tabSiteKey = getTabSiteKey(tab);
    if (!tab.id || !tabSiteKey) return false;
    if (tabSiteKey === siteKey) return true;
    return includeDescendants && backgroundShared.hostMatchesSiteKey(tabSiteKey, siteKey);
  });

  await Promise.all(matchingTabs.map(async (tab) => {
    if (!tab.id || !canAccessTabUrl(tab.url)) {
      return;
    }

    try {
      await injectTabScripts(tab.id);
    } catch (error) {
      console.warn('[bg] skipped tab injection:', tab.id, String(error));
    }
  }));
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tabId || (changeInfo.status !== 'complete' && typeof changeInfo.url !== 'string')) {
    return;
  }

  void tryApplyPendingSessionState(tabId, tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void setPendingSessionState(tabId, null);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) return false;

  console.log('[bg] received:', message.type, message.hostname);

  void (async () => {
    switch (message.type) {
      case 'TOGGLE_SITE': {
        const hostname = String(message.hostname || message.siteKey || '');
        if (!hostname) throw new Error('Missing hostname.');

        const siteKey = backgroundShared.getSiteKey(hostname);
        // Single owner: flip the live record, bump the audit counter inside
        // the same write. Last-accepted-write-wins: nothing is rejected on
        // ordering grounds; a delayed toggle that arrives later flips whatever
        // is live at arrival time (documented trade).
        /** @type {{ seq: number, nextEnabled: boolean, gainDb: number, excluded: boolean }} */
        const outcome = await withStorageWrite(async () => {
          const { record: storedRec } = await readSiteRecord(siteKey);
          const nextEnabled = !storedRec.enabled;
          const nextSeq = storedRec.seq + 1;
          const next = backgroundShared.normalizeSiteRecord({
            enabled: nextEnabled,
            gainDb: storedRec.gainDb,
            seq: nextSeq,
            mirror: nextEnabled,
            // A toggle never clears an exclusion: exclusion is only changed by
            // an explicit `excluded` intent.
            excluded: storedRec.excluded,
            // "Enabled once" is durable: a disable keeps it, which is what lets
            // the next enable land live on an already-loaded page.
            seen: storedRec.seen || nextEnabled,
          });
          // Single top-level key, single set: settings + mirror + sequence
          // can never diverge.
          await writeSiteRecord(siteKey, next);
          return { seq: nextSeq, nextEnabled, gainDb: next.gainDb, excluded: next.excluded };
        });
        // This legacy toggle only records state. Live application is the
        // per-site broadcast, which the storage change below emits.
        console.log('[bg] stored toggle:', siteKey, outcome.nextEnabled);
        return {
          ok: true,
          enabled: outcome.nextEnabled,
          gainDb: outcome.gainDb,
          excluded: outcome.excluded,
          siteKey,
          seq: outcome.seq,
        };
      }
      case 'SET_SITE_STATE': {
        const hostname = String(message.hostname || message.siteKey || '');
        if (!hostname) throw new Error('Missing hostname.');

        const siteKey = backgroundShared.getSiteKey(hostname);
        const persist = message.persist !== false;
        // Field-level intent only: `set` carries ONLY the changed fields.
        // Top-level snapshot fields are ignored when `set` is present, so a
        // sibling popup can never overwrite an unrelated newer field.
        const intent = extractIntentSet(/** @type {Record<string, unknown>} */ (message));

        /** @type {{ seq: number, enabled: boolean, gainDb: number, enabledApplied: boolean, excluded: boolean, exclusionChanged: boolean, previousExcluded: boolean, wasSeen: boolean, seen: boolean }} */
        const applied = await withStorageWrite(async () => {
          const { record: storedRec } = await readSiteRecord(siteKey);
          // Last-accepted-write-wins: every intent field applies to the live
          // record together or not at all — there is no per-field staleness
          // and no partial apply. Fields absent from the intent keep stored
          // values. Any legacy `at`/`actionAt` stamp on the message is
          // ignored (never compared, never persisted).
          let enabled = storedRec.enabled;
          let gainDb = storedRec.gainDb;
          let excluded = storedRec.excluded;
          let enabledApplied = false;
          if (Object.prototype.hasOwnProperty.call(intent, 'enabled')) {
            enabled = Boolean(intent.enabled);
            enabledApplied = true;
          }
          if (Object.prototype.hasOwnProperty.call(intent, 'gainDb')) gainDb = backgroundShared.clampGainDb(intent.gainDb);
          // Exclusion is a plain field of the same record: flipping it never
          // rewrites `enabled` or `gainDb`, so undo restores them untouched.
          const exclusionChanged = Object.prototype.hasOwnProperty.call(intent, 'excluded')
            && Boolean(intent.excluded) !== storedRec.excluded;
          if (Object.prototype.hasOwnProperty.call(intent, 'excluded')) {
            excluded = Boolean(intent.excluded);
          }
          const requestedEnabledChange = Object.prototype.hasOwnProperty.call(intent, 'enabled');
          const nextSeq = storedRec.seq + 1;
          const next = backgroundShared.normalizeSiteRecord({
            enabled,
            gainDb,
            seq: nextSeq,
            // The mirror follows `enabled` in the SAME per-site write; a
            // gain-only patch leaves it untouched.
            mirror: requestedEnabledChange ? enabled : storedRec.mirror,
            excluded,
            // First enable of this host is always remembered: from then on the
            // host loads with the passive hook and every later enable is live.
            seen: storedRec.seen || enabled,
          });

          if (persist) {
            // ONE top-level key, ONE set: the whole logical update lands
            // together or not at all. No crash window between settings,
            // mirror and sequence. Legacy maps are left untouched here;
            // reads prefer the per-site key, so stale legacy can never
            // resurrect (migrated lazily, `activeSites` cleared on startup
            // only for consumed entries).
            await writeSiteRecord(siteKey, next);
            await setPendingSessionState(message.tabId, null);
          }
          return {
            seq: persist ? nextSeq : storedRec.seq,
            enabled: next.enabled,
            gainDb: next.gainDb,
            enabledApplied,
            excluded: next.excluded,
            exclusionChanged,
            previousExcluded: storedRec.excluded,
            // Was this host already seen BEFORE this write? That is the one fact
            // that decides live vs reload for the enable.
            wasSeen: storedRec.seen,
            seen: next.seen,
          };
        });

        // Enabling a SEEN host is live: the document already holds the passive
        // page hook, and the broadcast below flips it on in place with no
        // navigation. The one residual reload case is the FIRST-ever enable of a
        // host, where no hook exists to start — that case reloads the tab once,
        // automatically, because a reload the user has to perform is not
        // acceptable. Disabling is live on both paths (STOP keeps the graph).
        if (!persist && message.tabId) {
          await setPendingSessionState(
            message.tabId,
            {
              siteKey,
              enabled: applied.enabled,
              gainDb: applied.gainDb,
            },
          );
        }
        // Exclusion is immediate and worker-driven: the hook in every affected
        // frame of every affected tab is destroyed before the popup hears back,
        // so a mid-read or hung content script cannot delay it. Un-excluding is
        // the one-way door: the captures are gone, so it applies on the next
        // navigation only.
        if (persist && applied.exclusionChanged && applied.excluded) {
          await teardownHooksForSite(siteKey, { includeDescendants: true, mode: 'destroy' });
        }
        // A persisted disable stops the worklet and keeps its dispatcher,
        // sessions and captured sources, so a re-enable revives it with one
        // control call instead of a reload.
        if (persist && applied.enabledApplied && !applied.enabled) {
          await teardownHooksForSite(siteKey, { mode: 'stop' });
        }
        console.log('[bg]', persist ? 'stored:' : 'transient:', siteKey, JSON.stringify(applied));
        // Exclusion beats enablement: nothing runs on this host, now or after a
        // reload. A seen host enables live (its document holds the passive
        // hook). The FIRST-ever enable of a host is the one case with no hook to
        // start, and it reloads this tab once, automatically.
        const firstEnable = persist
          && applied.enabledApplied
          && applied.enabled
          && !applied.excluded
          && !applied.wasSeen;
        let activation = applied.excluded
          ? { state: 'idle' }
          : (!applied.enabled
            ? { state: 'stop' }
            : (applied.wasSeen
              ? { state: 'live' }
              : { state: 'reload', message: RELOAD_NOTICE_MESSAGE }));
        if (firstEnable) {
          const reloading = await reloadTabOnce(message.tabId);
          if (reloading) activation = { state: 'reloading', message: RELOADING_MESSAGE };
        }
        return {
          ok: true,
          enabled: applied.enabled,
          gainDb: applied.gainDb,
          excluded: applied.excluded,
          siteKey,
          seq: applied.seq,
          seen: applied.seen,
          activation,
        };
      }
      case 'GET_SITE_STATE': {
        const hostname = String(message.hostname || message.siteKey || '');
        if (!hostname) return { ok: true, enabled: false, gainDb: 0 };
        const siteKey = backgroundShared.getSiteKey(hostname);

        const reconciled = await withStorageWrite(async () => {
          const { record, fromLegacy } = await readSiteRecord(siteKey);
          if (fromLegacy) {
            // Persist the migrated per-site record once so later reads hit
            // it directly; legacy is left for the startup clear and can never
            // override the per-site key afterwards.
            await writeSiteRecord(siteKey, record);
          }
          return record;
        });
        return {
          ok: true,
          enabled: reconciled.enabled,
          gainDb: reconciled.gainDb,
          excluded: reconciled.excluded,
          siteKey,
          seq: reconciled.seq,
        };
      }
      case 'CONTROL_HOOK': {
        const tabId = _sender?.tab?.id;
        if (!tabId) throw new Error('No tab for hook control.');
        const frameId = (typeof _sender?.frameId === 'number' && Number.isFinite(_sender.frameId))
          ? _sender.frameId
          : 0;
        const senderUrl = String(_sender?.url || _sender?.tab?.url || '');
        const siteKey = backgroundShared.getSiteKey(backgroundShared.extractHostname(senderUrl));
        const action = String(message.action || 'status');
        // The WORKER is the authority for exclusion. An excluded (or
        // unreadable) frame is torn down, never asked to start, and the page
        // has no way to reach this decision.
        if (await isSiteBlocked(siteKey)) {
          // Only the SENDER frame is destroyed. A frame on a blocked host inside
          // an allowed tab (an embedded frame the tab-level selection never
          // matches) must be able to end its own hook without tearing down the
          // allowed frames that share its tab.
          await controlHookFrame(tabId, frameId, 'destroy', {});
          return { ok: false, alive: false, active: false, error: 'Site is excluded.' };
        }
        const payload = message.payload && typeof message.payload === 'object'
          ? /** @type {Record<string, unknown>} */ (message.payload)
          : {};
        if (action === 'start' && payload.workletUrl === undefined) {
          payload.workletUrl = chrome.runtime.getURL('audio/normalizer-worklet.js');
        }
        return await controlHookFrame(tabId, frameId, action, payload);
      }
      case 'INJECT_PAGE_HOOK': {
        const tabId = _sender?.tab?.id;
        if (!tabId) throw new Error('No tab ID for page hook injection.');
        // Layer 3: the MAIN-world patch is never written into an excluded
        // frame. The SENDER FRAME's URL decides — not the tab's top-level URL,
        // which belongs to the embedder and would let an excluded cross-origin
        // iframe inherit the top host's permission. `injectMainWorldScript`
        // then runs the MAIN-world frame gate for the frame's own verdict.
        const senderUrl = String(_sender?.url || _sender?.tab?.url || '');
        const hookSiteKey = backgroundShared.getSiteKey(backgroundShared.extractHostname(senderUrl));
        if (await isSiteBlocked(hookSiteKey)) {
          return { ok: false, error: 'Site is excluded; page hook not injected.' };
        }
        // Sender-frame targeting: content scripts in iframes carry their
        // frameId; tab-level calls have none and default to frame 0.
        const senderFrameId = (typeof _sender?.frameId === 'number' && Number.isFinite(_sender.frameId))
          ? _sender.frameId
          : 0;
        const injected = await injectMainWorldScript(tabId, 'page-hook.js', senderFrameId);
        if (!injected?.ok) return { ok: false, error: injected?.error || 'Page hook injection failed.' };
        return { ok: true };
      }
      case 'SOFT_RECHECK_DOCUMENT': {
        return softRecheckDocument(message.tabId, String(message.siteKey || ''));
      }
      default:
        return { ok: false, error: `Unknown: ${message.type}` };
    }
  })()
    .then((r) => sendResponse(r))
    .catch((e) => {
      console.error('[bg] error:', e);
      sendResponse({ ok: false, error: String(e) });
    });

  return true;
});

chrome.runtime.onStartup.addListener(async () => {
  // Registration first: layer 1 must be correct before anything is injected.
  await syncContentScriptRegistration();
  // Finding 3: a rejected migration write must not abort re-injection. The
  // migration is isolated in its own try/catch that reports and continues;
  // the injection union below always runs, and its own failures are reported
  // per-site rather than aborting siblings.
  try {
    await migrateActiveSitesOnce();
  } catch (e) {
    console.warn('[bg] startup migration failed, continuing to re-inject:', String(e));
  }
  try {
    // Re-inject enabled sites: UNION of per-site truth and every legacy
    // shape. A legacy-enabled site is covered even when unrelated per-site
    // keys already exist (the old `if (enabledKeys.size === 0)` gate dropped
    // legacy sites as soon as any per-site key existed). Per-site outranks
    // legacy for the SAME site (readSiteRecord prefers it), so a disabled
    // per-site is never re-enabled by stale legacy — but a legacy-only site
    // is still injected.
    /** @type {Record<string, unknown>} */
    let all = {};
    try {
      all = await chrome.storage.local.get(null);
    } catch {
      all = await chrome.storage.local.get({ activeSites: {}, siteSettings: {}, siteToggles: {} });
    }
    const enabledKeys = new Set();
    for (const [key, value] of Object.entries(all || {})) {
      if (backgroundShared.isSiteStorageKey(key) && value && typeof value === 'object') {
        const rec = backgroundShared.normalizeSiteRecord(value);
        if (rec.enabled) enabledKeys.add(backgroundShared.siteKeyFromStorageKey(key));
      }
    }
    // Legacy union: normalise every legacy raw key, evaluate its effective
    // config (toggles win for enabled), add when enabled — regardless of
    // whether per-site keys exist for other sites.
    {
      const siteSettings = /** @type {Record<string, unknown>} */ (all.siteSettings || {});
      const activeSites = /** @type {Record<string, unknown>} */ (all.activeSites || {});
      const siteToggles = /** @type {Record<string, unknown>} */ (all.siteToggles || {});
      /** @type {Set<string>} */
      const candidates = new Set();
      for (const raw of Object.keys(siteSettings)) {
        const k = backgroundShared.getSiteKey(raw);
        if (k) candidates.add(k);
      }
      for (const [raw, v] of Object.entries(activeSites)) {
        if (!Boolean(v)) continue;
        const k = backgroundShared.getSiteKey(raw);
        if (k) candidates.add(k);
      }
      for (const [raw, v] of Object.entries(siteToggles)) {
        if (typeof v !== 'boolean') continue;
        const k = backgroundShared.getSiteKey(raw);
        if (k) candidates.add(k);
      }
      for (const candidate of candidates) {
        if (enabledKeys.has(candidate)) continue;
        // Per-site outranks legacy for the same site: skip legacy when a
        // per-site record already decides this site.
        const perKey = backgroundShared.siteStorageKey(candidate);
        if (perKey && all[perKey] && typeof all[perKey] === 'object') continue;
        const rec = backgroundShared.migrateLegacyToRecord(siteSettings, activeSites, siteToggles, candidate);
        if (rec && rec.enabled) enabledKeys.add(candidate);
      }
    }
    for (const key of enabledKeys) {
      try {
        await syncExistingTabsForSite(key);
      } catch (e) {
        console.warn('[bg] startup re-injection failed for', key, ':', String(e));
      }
    }
  } catch (e) {
    console.warn('[bg] startup re-injection failed:', String(e));
  }
});

// Install/update: the static `<all_urls>` entry is gone, so the dynamic
// registration is the only thing that injects at `document_start`. Populate it
// before the first navigation.
chrome.runtime.onInstalled?.addListener?.(() => {
  void syncContentScriptRegistration();
});

// Single storage listener: preserves the legacy `siteToggles` broadcast
// contract AND carries the per-site broadcast. Reads prefer the per-site key,
// so a delayed legacy mirror write that disagrees with the per-site record
// is stale and never broadcast as truth.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  // Legacy path (preserved): a `siteToggles` change nudges matching tabs,
  // but only when it agrees with the per-site/legacy stored truth.
  if (changes.siteToggles) {
    const newToggles = changes.siteToggles.newValue || {};
    const oldToggles = changes.siteToggles.oldValue || {};
    for (const siteKey of Object.keys(newToggles)) {
      if (newToggles[siteKey] !== oldToggles[siteKey]) {
        chrome.tabs.query({}, (tabs) => {
          void (async () => {
            const { record } = await readSiteRecord(backgroundShared.getSiteKey(siteKey) || siteKey);
            if (record.enabled !== Boolean(newToggles[siteKey])) return;
            tabs.forEach(tab => {
              if (tab.url && tab.id && tabMatchesSiteKey(tab.url, siteKey)) {
                chrome.tabs.sendMessage(tab.id, {
                  type: 'TOGGLE_CHANGED',
                  siteKey,
                  enabled: newToggles[siteKey],
                  gainDb: record.gainDb,
                  excluded: record.excluded,
                }, { frameId: 0 }).catch(() => {});
              }
            });
          })();
        });
      }
    }
  }
  // Per-site path: a `site:<key>` change broadcasts to the top frame only,
  // coalesced to one broadcast per site per tick (see scheduleSiteBroadcast).
  // A delayed `enabled:false` change must not overwrite a newer activation.
  // The `newRec` captured from the change record may already be stale by the
  // time the async `tabs.query` returns, so the flush re-reads the stored
  // truth and broadcasts that; fail closed (no broadcast) when the re-read
  // fails.
  for (const [key, change] of Object.entries(changes)) {
    if (!backgroundShared.isSiteStorageKey(key)) continue;
    const siteKey = backgroundShared.siteKeyFromStorageKey(key);
    if (!siteKey) continue;
    const oldRec = change.oldValue && typeof change.oldValue === 'object'
      ? backgroundShared.normalizeSiteRecord(change.oldValue)
      : null;
    const newRec = change.newValue && typeof change.newValue === 'object'
      ? backgroundShared.normalizeSiteRecord(change.newValue)
      : null;
    if (!newRec) continue;
    // `enabled`, `excluded` and `seen` all move the injection surface, so all
    // three re-register; a gain-only change never does.
    if (!oldRec
      || oldRec.enabled !== newRec.enabled
      || oldRec.excluded !== newRec.excluded
      || oldRec.seen !== newRec.seen) {
      scheduleRegistrationSync();
    }
    // Worker-driven exclusion teardown: the storage change is authoritative and
    // does not depend on any content script being awake or listening.
    if (newRec.excluded && (!oldRec || oldRec.excluded !== true)) {
      void teardownHooksForSite(backgroundShared.siteKeyFromStorageKey(key), {
        includeDescendants: true,
        mode: 'destroy',
      });
    }
    if (oldRec && oldRec.enabled === newRec.enabled
      && oldRec.gainDb === newRec.gainDb
      && oldRec.excluded === newRec.excluded) continue;
    scheduleSiteBroadcast(siteKey);
  }
});
// ---------------------------------------------------------------------------
// Rule 7: registration is SELF-HEALING, not merely serialized.
//
// A service-worker wake evaluates this file, so reconciling here means a
// descriptor left behind by a worker that died mid-pass (or by an update that
// rejected) cannot outlive the next wake, let alone a restart. Install and
// startup keep their own passes for re-injection; this one only makes the
// stored registration match the stored records.
// ---------------------------------------------------------------------------
void syncContentScriptRegistration();
