importScripts('shared.js');

const backgroundShared = self.TabNormalizerShared;

const INJECTABLE_FILES = ['shared.js', 'content-script.js'];
const CONTENT_SCRIPT_ID = 'tab-normalizer-content-script';
const SUPPORTED_PROTOCOL_PATTERN = /^https?:$/i;
const RESTRICTED_URL_PATTERN = /^(chrome|chrome-extension|devtools|edge|about):/i;
const WEBSTORE_URL_PATTERN = /^https?:\/\/(chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)\b/i;
const pendingSessionStates = new Map();

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
  const legacyPerKey = backgroundShared.legacySiteStorageKey(siteKey);
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

const RELOAD_NOTICE_MESSAGE = 'Enabled. Reload applies this.';

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
    return Boolean(value && typeof value === 'object' && 'excluded' in value && value.excluded === true);
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
        if (!migrated) continue;
        const cur = backgroundShared.normalizeSiteRecord(existing[perKey]);
        if (cur.enabled !== migrated.enabled
          || cur.gainDb !== migrated.gainDb) continue;
        consumed.push(rawKey);
        continue;
      }
      if (migrated) {
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

/** @type {ReturnType<typeof setTimeout> | null} */
let registrationSyncTimer = null;
/** @type {Promise<unknown>} */
let registrationChain = Promise.resolve();
let lastAppliedRegistrationSeq = -1;
let registrationRetryCount = 0;
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

function tabMatchesSiteKey(tabUrl, siteKey) {
  if (typeof tabUrl !== 'string' || !siteKey) return false;
  const hostname = backgroundShared.extractHostname(tabUrl);
  return backgroundShared.getSiteKey(hostname) === siteKey
    || backgroundShared.getLegacySiteKey(hostname) === siteKey;
}

const pendingBroadcastSites = new Set();
/** @type {ReturnType<typeof setTimeout> | null} */
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
        current = record;
      } catch {
        return;
      }
      tabs.forEach(tab => {
        if (!tab.url || !tab.id) return;
        const tabKey = getTabSiteKey(tab);
        if (!tabKey) return;
        if (tabKey !== siteKey && !backgroundShared.hostMatchesSiteKey(tabKey, siteKey)) return;
        chrome.tabs.sendMessage(tab.id, {
          type: 'TOGGLE_CHANGED',
          siteKey,
          enabled: current.enabled,
          gainDb: current.gainDb,
          excluded: current.excluded,
        }).catch(() => {});
      });
    })();
  });
}


async function injectMainWorldScript(tabId, file, frameId) {
  const target = (typeof frameId === 'number' && Number.isFinite(frameId))
    ? { tabId, frameIds: [frameId] }
    : { tabId };
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

/**
 * Arm the CURRENT document after the first explicit enable of a site. Reuses
 * the same gated injection path a navigation uses; no reload, no new document.
 * An excluded site, a missing tab id, or a failed injection all answer false so
 * the caller keeps the notice instead of claiming a live effect it cannot prove.
 * @param {unknown} tabId
 * @param {string} siteKey
 * @returns {Promise<boolean>}
 */
async function armFirstEnableInPlace(tabId, siteKey) {
  if (typeof tabId !== 'number' || !Number.isFinite(tabId) || !chrome.scripting) return false;
  if (await isSiteBlocked(siteKey)) return false;
  try {
    await injectTabScripts(tabId);
    return true;
  } catch (error) {
    console.warn('[bg] first-enable in-place arm failed:', String(error));
    return false;
  }
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

  /** @type {chrome.tabs.Tab | null} */
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

  if (await isSiteBlocked(siteKey || getTabSiteKey(tab))) {
    return { ok: true, activation: { state: 'idle' } };
  }

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
            excluded: storedRec.excluded,
            seen: storedRec.seen || nextEnabled,
          });
          await writeSiteRecord(siteKey, next);
          return { seq: nextSeq, nextEnabled, gainDb: next.gainDb, excluded: next.excluded };
        });
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
        const intent = extractIntentSet(/** @type {Record<string, unknown>} */ (message));

        /** @type {{ seq: number, enabled: boolean, gainDb: number, enabledApplied: boolean, excluded: boolean, exclusionChanged: boolean, previousExcluded: boolean, wasSeen: boolean, seen: boolean }} */
        const applied = await withStorageWrite(async () => {
          const { record: storedRec } = await readSiteRecord(siteKey);
          let enabled = storedRec.enabled;
          let gainDb = storedRec.gainDb;
          let excluded = storedRec.excluded;
          let enabledApplied = false;
          if (Object.prototype.hasOwnProperty.call(intent, 'enabled')) {
            enabled = Boolean(intent.enabled);
            enabledApplied = true;
          }
          if (Object.prototype.hasOwnProperty.call(intent, 'gainDb')) gainDb = backgroundShared.clampGainDb(intent.gainDb);
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
            mirror: requestedEnabledChange ? enabled : storedRec.mirror,
            excluded,
            seen: storedRec.seen || enabled,
          });

          if (persist) {
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
            wasSeen: storedRec.seen,
            seen: next.seen,
          };
        });

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
        if (persist && applied.exclusionChanged && applied.excluded) {
          await teardownHooksForSite(siteKey, { includeDescendants: true, mode: 'destroy' });
        }
        if (persist && applied.enabledApplied && !applied.enabled) {
          await teardownHooksForSite(siteKey, { mode: 'stop' });
        }
        console.log('[bg]', persist ? 'stored:' : 'transient:', siteKey, JSON.stringify(applied));
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
        if (firstEnable && await armFirstEnableInPlace(message.tabId, siteKey)) {
          activation = { state: 'live' };
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
        if (await isSiteBlocked(siteKey)) {
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
        const senderUrl = String(_sender?.url || _sender?.tab?.url || '');
        const hookSiteKey = backgroundShared.getSiteKey(backgroundShared.extractHostname(senderUrl));
        if (await isSiteBlocked(hookSiteKey)) {
          return { ok: false, error: 'Site is excluded; page hook not injected.' };
        }
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
  await syncContentScriptRegistration();
  try {
    await migrateActiveSitesOnce();
  } catch (e) {
    console.warn('[bg] startup migration failed, continuing to re-inject:', String(e));
  }
  try {
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

chrome.runtime.onInstalled?.addListener?.(() => {
  void syncContentScriptRegistration();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
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
    if (!oldRec
      || oldRec.enabled !== newRec.enabled
      || oldRec.excluded !== newRec.excluded
      || oldRec.seen !== newRec.seen) {
      scheduleRegistrationSync();
    }
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
void syncContentScriptRegistration();
