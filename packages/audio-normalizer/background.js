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
 * @returns {Promise<{ record: { enabled: boolean, gainDb: number, seq: number, mirror: boolean, excluded: boolean }, fromLegacy: boolean }>}
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

/**
 * Exclusion outranks everything else: an excluded site is inactive whatever
 * `enabled`, browser site access, or a transient session override says.
 * The rule is the host's own record OR any parent host's (`h === key ||
 * h.endsWith('.' + key)`), so excluding `tiktok.com` also covers
 * `www.tiktok.com`.
 * @param {string} siteKey
 * @returns {Promise<boolean>}
 */
async function isSiteExcluded(siteKey) {
  if (!siteKey) return false;
  const keys = [siteKey].concat(backgroundShared.ancestorSiteKeys(siteKey));
  for (const key of keys) {
    try {
      const { record } = await readSiteRecord(key);
      if (record.excluded === true) return true;
    } catch {
      // Unknown truth is not exclusion: the content script's own read is the
      // backstop, and failing closed here would break a working site on a
      // storage hiccup.
    }
  }
  return false;
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
  /** @type {Map<string, { enabled: boolean, gainDb: number, seq: number, mirror: boolean, excluded: boolean }>} */
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
 * @returns {Promise<{ matches: string[], excludeMatches: string[] }>}
 */
async function deriveContentScriptRegistration() {
  const all = /** @type {Record<string, unknown>} */ (await chrome.storage.local.get(null));
  const records = collectPerSiteRecords(all);
  /** @type {string[]} */
  const activeHosts = [];
  /** @type {string[]} */
  const excludedHosts = [];
  for (const [siteKey, record] of records) {
    if (record.excluded) {
      excludedHosts.push(siteKey);
      continue;
    }
    if (record.enabled) activeHosts.push(siteKey);
  }
  const matches = backgroundShared.siteHostMatchPatterns(activeHosts)
    .concat(backgroundShared.siteExcludeMatchPatterns(Array.from(collectLegacyEnabledSiteKeys(all, records))));
  return {
    matches,
    excludeMatches: backgroundShared.siteExcludeMatchPatterns(excludedHosts),
  };
}

/**
 * Bring `chrome.scripting` in line with stored truth. Registration failure is
 * never fatal: it is logged and the remaining two layers (the content-script
 * gate and the background's own injection refusal) still hold, so a browser
 * that rejects a pattern degrades to "the script runs and immediately stops"
 * rather than to "nothing works".
 */
async function syncContentScriptRegistration() {
  try {
    if (!chrome.scripting || typeof chrome.scripting.registerContentScripts !== 'function') return;
    const { matches, excludeMatches } = await deriveContentScriptRegistration();
    const existing = typeof chrome.scripting.getRegisteredContentScripts === 'function'
      ? await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] })
      : [];
    if (matches.length === 0) {
      // Nothing can be active: leave no registration behind at all.
      const known = typeof chrome.scripting.getRegisteredContentScripts === 'function'
        ? (await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] })).length > 0
        : true;
      if (known) await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
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
    if (existing.length > 0) {
      await chrome.scripting.updateContentScripts([descriptor]);
    } else {
      await chrome.scripting.registerContentScripts([descriptor]);
    }
  } catch (e) {
    console.warn('[bg] content-script registration failed, gate layer still enforces:', String(e));
  }
}

// Coalesced re-registration: a burst of writes (toggle + gain + exclusion)
// costs one registration pass, not one per write.
let registrationSyncTimer = null;
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
        if (tab.url && tab.id && tabMatchesSiteKey(tab.url, siteKey)) {
          chrome.tabs.sendMessage(tab.id, {
            type: 'TOGGLE_CHANGED',
            siteKey,
            enabled: current.enabled,
            gainDb: current.gainDb,
            // Live teardown: the content script stops on this flag without a
            // storage read. Exclusion outranks `enabled` at the tab.
            excluded: current.excluded,
          }, { frameId: 0 }).catch(() => {});
        }
      });
    })();
  });
}

async function hasInjectedContentScript(tabId) {
  try {
    // Target the top frame only (frameId 0: RESEARCH §5.3). Without frameId
    // every frame answers and the sender gets one arbitrary answer.
    const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_DOCUMENT_STATUS' }, { frameId: 0 });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
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

async function injectTabScripts(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: INJECTABLE_FILES,
  });
}

async function prepareCurrentTabActivation(tabId, siteKey) {
  if (!tabId) {
    return { state: 'pending' };
  }

  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { state: 'pending' };
  }

  if (!canAccessTabUrl(tab?.url)) {
    return { state: 'restricted', message: 'Enabled. Reload on a supported page.' };
  }

  if (getTabSiteKey(tab) !== siteKey) {
    return { state: 'pending' };
  }

  // Layer 3, enable path: an excluded host is never injected.
  if (await isSiteExcluded(siteKey)) {
    return { state: 'idle' };
  }

  try {
    if (!await hasInjectedContentScript(tabId)) {
      await injectTabScripts(tabId);
    }
  } catch {
    return { state: 'unavailable', message: 'Enabled. Reload if this page stays unavailable.' };
  }

  return { state: 'pending' };
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
  if (await isSiteExcluded(entry.siteKey)) {
    return false;
  }

  try {
    if (!await hasInjectedContentScript(tabId)) {
      await injectTabScripts(tabId);
    }

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
  if (await isSiteExcluded(siteKey || getTabSiteKey(tab))) {
    return { ok: true, activation: { state: 'idle' } };
  }

  try {
    if (!await hasInjectedContentScript(tabId)) {
      await injectTabScripts(tabId);
    }
  } catch {
    return { ok: true, activation: { state: 'unavailable', message: 'Enabled. Waiting for this page.' } };
  }

  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'SOFT_RECHECK_DOCUMENT' }, { frameId: 0 });
  } catch {
    return { ok: true, activation: { state: 'unavailable', message: 'Enabled. Waiting for this page.' } };
  }
}

async function syncExistingTabsForSite(siteKey) {
  if (!siteKey) {
    return;
  }

  // Layer 3, batch path (enable, startup re-inject, un-exclude): an excluded
  // host is never injected, not even with the ISOLATED pair.
  if (await isSiteExcluded(siteKey)) {
    return;
  }

  const tabs = await chrome.tabs.query({});
  const matchingTabs = tabs.filter((tab) => tab.id && getTabSiteKey(tab) === siteKey);

  await Promise.all(matchingTabs.map(async (tab) => {
    if (!tab.id || !canAccessTabUrl(tab.url)) {
      return;
    }

    const isInjected = await hasInjectedContentScript(tab.id);
    if (isInjected) {
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
          });
          // Single top-level key, single set: settings + mirror + sequence
          // can never diverge.
          await writeSiteRecord(siteKey, next);
          return { seq: nextSeq, nextEnabled, gainDb: next.gainDb, excluded: next.excluded };
        });
        if (outcome.nextEnabled) {
          await syncExistingTabsForSite(siteKey);
        }
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

        /** @type {{ seq: number, enabled: boolean, gainDb: number, enabledApplied: boolean, excluded: boolean, exclusionChanged: boolean, previousExcluded: boolean }} */
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
          };
        });

        // Exclusion beats enablement: activation is refused for an excluded
        // host (layer 3), whatever the intent said.
        const shouldActivateCurrentTab = applied.enabledApplied && applied.enabled && !applied.excluded;
        const activation = shouldActivateCurrentTab
          ? await prepareCurrentTabActivation(message.tabId, siteKey)
          : { state: 'idle' };
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
        if (shouldActivateCurrentTab && persist) {
          await syncExistingTabsForSite(siteKey);
        }
        // Live teardown / revive for tabs that are already open. The storage
        // broadcast (TOGGLE_CHANGED, carrying `excluded`) reaches frames whose
        // listeners are still armed; an un-exclude must also re-inject, because
        // the torn-down frames have no listeners left to hear it.
        if (persist && applied.exclusionChanged && !applied.excluded && applied.enabled) {
          await syncExistingTabsForSite(siteKey);
        }
        console.log('[bg]', persist ? 'stored:' : 'transient:', siteKey, JSON.stringify(applied));
        return {
          ok: true,
          enabled: applied.enabled,
          gainDb: applied.gainDb,
          excluded: applied.excluded,
          siteKey,
          seq: applied.seq,
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
      case 'INJECT_PAGE_HOOK': {
        const tabId = _sender?.tab?.id;
        if (!tabId) throw new Error('No tab ID for page hook injection.');
        // Layer 3: the MAIN-world patch is never written into an excluded
        // host. This is the last line for every injection path — enable,
        // startup re-inject, activation retry and SPA revive all arrive here.
        const hookSiteKey = getTabSiteKey(_sender?.tab);
        if (hookSiteKey && await isSiteExcluded(hookSiteKey)) {
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
    // `enabled` and `excluded` both move the injection surface, so both
    // re-register; a gain-only change never does.
    if (!oldRec
      || oldRec.enabled !== newRec.enabled
      || oldRec.excluded !== newRec.excluded) {
      scheduleRegistrationSync();
    }
    if (oldRec && oldRec.enabled === newRec.enabled
      && oldRec.gainDb === newRec.gainDb
      && oldRec.excluded === newRec.excluded) continue;
    scheduleSiteBroadcast(siteKey);
  }
});
