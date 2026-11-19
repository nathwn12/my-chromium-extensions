(function (root, factory) {
  const api = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  /** @type {Record<string, unknown>} */ (root).TabNormalizerShared = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULT_GAIN_DB = 0;
  const MIN_GAIN_DB = -12;
  const MAX_GAIN_DB = 12;
  const GAIN_STEP_DB = 0.5;

  function extractHostname(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }

  function normalizeHostname(hostname) {
    let normalized = String(hostname || '').trim().toLowerCase();
    if (!normalized) return '';

    if (/[^\x00-\x7F]/.test(normalized)) {
      try {
        normalized = new URL(`http://${normalized}`).hostname;
      } catch {}
    }

    const bracketedIpv6 = normalized.match(/^\[(.+)\](?::\d+)?$/);
    if (bracketedIpv6) {
      return bracketedIpv6[1].replace(/\.+$/, '');
    }

    const portless = /^[^:]+:\d+$/.test(normalized)
      ? normalized.replace(/:\d+$/, '')
      : normalized;
    return portless.replace(/\.+$/, '');
  }

  function getSiteKey(hostname) {
    return normalizeHostname(hostname);
  }

  function getLegacySiteKey(hostname) {
    const normalized = normalizeHostname(hostname);
    if (!normalized) return '';

    if (normalized === 'localhost' || /^[\d.:]+$/.test(normalized)) {
      return normalized;
    }

    const parts = normalized.split('.').filter(Boolean);
    if (parts.length <= 2) {
      return normalized;
    }

    const suffix = parts.slice(-2).join('.');
    if (suffix === 'co.uk' || suffix === 'co.jp' || suffix === 'com.au' || suffix === 'com.br' || suffix === 'com.mx' || suffix === 'com.tr' || suffix === 'net.au' || suffix === 'org.au' || suffix === 'org.uk' || suffix === 'ac.uk') {
      if (parts.length >= 3) {
        return parts.slice(-3).join('.');
      }
    }

    return parts.slice(-2).join('.');
  }

  function migrateActiveSites(activeSites) {
    const next = {};

    for (const [rawKey, enabled] of Object.entries(activeSites || {})) {
      if (!enabled) continue;

      const siteKey = getLegacySiteKey(rawKey);
      if (!siteKey) continue;
      next[siteKey] = true;
    }

    return next;
  }

  function clampGainDb(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return DEFAULT_GAIN_DB;
    return Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, Math.round(numeric / GAIN_STEP_DB) * GAIN_STEP_DB));
  }

  function normalizeSiteSettings(value) {
    if (value === true) {
      return { enabled: true, gainDb: DEFAULT_GAIN_DB };
    }

    const raw = value && typeof value === 'object' ? value : {};
    return {
      enabled: Boolean(raw.enabled),
      gainDb: clampGainDb(raw.gainDb),
    };
  }

  var SITE_KEY_PREFIX = 'site:';

  function siteStorageKey(siteKey) {
    const normalized = getSiteKey(siteKey);
    if (!normalized) return '';
    return SITE_KEY_PREFIX + normalized;
  }

  function legacySiteStorageKey(siteKey) {
    const normalized = getLegacySiteKey(siteKey);
    if (!normalized) return '';
    return SITE_KEY_PREFIX + normalized;
  }

  function isSiteStorageKey(key) {
    return typeof key === 'string' && key.indexOf(SITE_KEY_PREFIX) === 0;
  }

  function hostMatchesSiteKey(hostname, siteKey) {
    const host = getSiteKey(hostname);
    const key = getSiteKey(siteKey);
    if (!host || !key) return false;
    return host === key || host.endsWith('.' + key);
  }

  function isHostExcluded(hostname, excludedKeys) {
    if (!Array.isArray(excludedKeys) || excludedKeys.length === 0) return false;
    for (const key of excludedKeys) {
      if (hostMatchesSiteKey(hostname, key)) return true;
    }
    return false;
  }

  function ancestorSiteKeys(hostname) {
    const host = getSiteKey(hostname);
    if (!host || /^[\d.:]+$/.test(host)) return [];
    const parts = host.split('.').filter(Boolean);
    const out = [];
    for (let i = 1; i < parts.length; i += 1) {
      out.push(parts.slice(i).join('.'));
    }
    return out;
  }

  function matchPatternFor(siteKey, wildcard) {
    const host = getSiteKey(siteKey);
    if (!host) return '';
    if (host === 'localhost' || /^[\d.]+$/.test(host)) {
      return `*://${host}/*`;
    }
    if (host.indexOf(':') !== -1) {
      return `*://[${host}]/*`;
    }
    return wildcard ? `*://*.${host}/*` : `*://${host}/*`;
  }

  function siteExcludeMatchPattern(siteKey) {
    return matchPatternFor(siteKey, true);
  }

  function siteHostMatchPattern(siteKey) {
    return matchPatternFor(siteKey, false);
  }

  function patternsFor(siteKeys, builder) {
    const out = [];
    const seen = new Set();
    for (const key of siteKeys || []) {
      const pattern = builder(key);
      if (!pattern || seen.has(pattern)) continue;
      seen.add(pattern);
      out.push(pattern);
    }
    return out;
  }

  function siteExcludeMatchPatterns(siteKeys) {
    return patternsFor(siteKeys, siteExcludeMatchPattern);
  }

  function siteHostMatchPatterns(siteKeys) {
    return patternsFor(siteKeys, siteHostMatchPattern);
  }

  function siteKeyFromStorageKey(key) {
    if (!isSiteStorageKey(key)) return '';
    return getSiteKey(key.slice(SITE_KEY_PREFIX.length));
  }

  /**
   * Normalize a per-site record. Ordering is last-accepted-write-wins: the
   * background applies an intent's fields to the live record and writes the
   * whole record back in one `set`; the later *arrival* wins, not the later
   * user action. `seq` is a durable per-site monotonic counter bumped on
   * every accepted write — audit and observability only, never an acceptance
   * gate; nothing is ever rejected on ordering grounds.
   * Accepted trade (deliberate): if two popups race the same field and one
   * message is delayed past a newer one, the later arrival wins rather than
   * the later action. There is no clock-free way to distinguish those; the
   * window is milliseconds between two simultaneously-open popups, and the
   * alternative (wall-clock per-field maxima) froze a field until the wall
   * clock caught up — potentially for years after a mistakenly future-dated
   * write — with no restart helping because the maxima persisted.
   * `mirror` is the popup-facing follower of `enabled` carried in the same
   * write so the two can never part across a crash. Legacy `at*` clock
   * fields are ignored when present and never written back.
   * @param {unknown} value
   */
  function normalizeSiteRecord(value) {
    const raw = /** @type {Record<string, unknown>} */ (value && typeof value === 'object' ? value : {});
    const enabled = Boolean(raw.enabled);
    const seqRaw = Number(raw.seq);
    const seq = Number.isFinite(seqRaw) && seqRaw >= 0 ? Math.floor(seqRaw) : 0;
    const mirrorRaw = Object.prototype.hasOwnProperty.call(raw, 'mirror')
      ? raw.mirror
      : enabled;
    return {
      enabled,
      gainDb: clampGainDb(raw.gainDb),
      seq,
      mirror: Boolean(mirrorRaw),
      excluded: Boolean(raw.excluded),
      seen: Boolean(raw.seen) || enabled,
    };
  }

  /**
   * One-time legacy migration into a per-site record (in-memory only; the
   * caller persists the returned record with a single per-site `set`).
   * Rule: an explicit `siteToggles` boolean wins for `enabled` — it is the
   * surface the user actually toggled — repairing the pre-fix historical
   * diverge (mirror-off while settings-on). Afterwards the per-site key
   * exists and is preferred over legacy on every read, so a stale mirror
   * entry can never resurrect over newer truth and no separate marker is
   * needed. Legacy `activeSites` enables are honoured. Returns null when no
   * legacy entry exists for the site.
   * Lossless rule: legacy keys are NORMALISED before matching, so a
   * `www.`/sibling-subdomain key is found when reading the canonical key.
   * A user with only `siteSettings['www.youtube.com']` keeps gain when
   * reading `youtube.com`.
   * @param {Record<string, unknown>} siteSettings
   * @param {Record<string, boolean>} activeSites
   * @param {Record<string, unknown>} siteToggles
   * @param {string} hostnameOrSiteKey
   */
  function migrateLegacyToRecord(siteSettings, activeSites, siteToggles, hostnameOrSiteKey) {
    const siteKey = getSiteKey(hostnameOrSiteKey);
    if (!siteKey) return null;
    const legacyKey = getLegacySiteKey(hostnameOrSiteKey);
    const toggles = siteToggles && typeof siteToggles === 'object' ? siteToggles : {};
    const settings = siteSettings && typeof siteSettings === 'object' ? siteSettings : {};
    const actives = activeSites && typeof activeSites === 'object' ? activeSites : {};
    let hasSettings = false;
    let hasToggle = false;
    let hasActive = false;
    /** @type {boolean | null} */
    let normalizedToggle = null;
    /** @type {boolean | null} */
    let legacyToggle = null;
    for (const [rawKey, value] of Object.entries(settings)) {
      try {
        if (getSiteKey(rawKey) === siteKey) { hasSettings = true; break; }
      } catch {}
    }
    if (!hasSettings) {
      for (const [rawKey, value] of Object.entries(settings)) {
        try {
          if (getLegacySiteKey(rawKey) === legacyKey) { hasSettings = true; break; }
        } catch {}
      }
    }
    for (const [rawKey, value] of Object.entries(toggles)) {
      try {
        if (typeof value !== 'boolean') continue;
        if (getSiteKey(rawKey) === siteKey) {
          hasToggle = true;
          normalizedToggle = value;
        } else if (normalizedToggle === null && getLegacySiteKey(rawKey) === legacyKey) {
          hasToggle = true;
          legacyToggle = value;
        }
      } catch {}
    }
    if (normalizedToggle === null && legacyToggle !== null) {
      normalizedToggle = legacyToggle;
    }
    for (const [rawKey, value] of Object.entries(actives)) {
      try {
        if (getSiteKey(rawKey) === siteKey && Boolean(value)) { hasActive = true; break; }
      } catch {}
    }
    if (!hasActive) {
      for (const [rawKey, value] of Object.entries(actives)) {
        try {
          if (getLegacySiteKey(rawKey) === legacyKey && Boolean(value)) { hasActive = true; break; }
        } catch {}
      }
    }
    if (!hasSettings && !hasToggle && !hasActive) return null;
    const base = getSiteConfig(siteSettings, activeSites, siteKey);
    let enabled = base.enabled;
    if (hasToggle && normalizedToggle !== null) {
      enabled = Boolean(normalizedToggle);
    }
    return normalizeSiteRecord({
      enabled,
      gainDb: base.gainDb,
      seq: 0,
      mirror: enabled,
      seen: enabled,
    });
  }

  function migrateSiteSettings(siteSettings, activeSites) {
    const next = {};

    for (const [rawKey, config] of Object.entries(siteSettings || {})) {
      const siteKey = getLegacySiteKey(rawKey);
      if (!siteKey) continue;
      const prev = next[siteKey];
      if (!prev) {
        next[siteKey] = normalizeSiteSettings(config);
        continue;
      }
      if (config === true) {
        next[siteKey] = { ...prev, enabled: true };
        continue;
      }
      const raw = (config && typeof config === 'object' ? config : {});
      const merged = { ...prev };
      if (Object.prototype.hasOwnProperty.call(raw, 'enabled')) merged.enabled = Boolean(raw.enabled);
      if (Object.prototype.hasOwnProperty.call(raw, 'gainDb')) merged.gainDb = clampGainDb(raw.gainDb);
      next[siteKey] = normalizeSiteSettings(merged);
    }

    for (const [rawKey, enabled] of Object.entries(activeSites || {})) {
      if (!enabled) continue;
      const siteKey = getLegacySiteKey(rawKey);
      if (!siteKey) continue;
      next[siteKey] = normalizeSiteSettings({
        ...next[siteKey],
        enabled: true,
      });
    }

    return next;
  }

  function getSiteConfig(siteSettings, activeSites, hostnameOrSiteKey) {
    const siteKey = getSiteKey(hostnameOrSiteKey);
    const legacyKey = getLegacySiteKey(hostnameOrSiteKey);
    const migrated = migrateSiteSettings(siteSettings, activeSites);

    if (!siteKey) {
      return { siteKey: '', enabled: false, gainDb: DEFAULT_GAIN_DB };
    }

    return {
      siteKey,
      ...normalizeSiteSettings(migrated[siteKey] ?? migrated[legacyKey]),
    };
  }

  function setSiteConfig(siteSettings, activeSites, hostnameOrSiteKey, updates) {
    const migrated = migrateSiteSettings(siteSettings, activeSites);
    const siteKey = getLegacySiteKey(hostnameOrSiteKey);

    if (!siteKey) {
      return migrated;
    }

    const current = normalizeSiteSettings(migrated[siteKey]);
    const next = normalizeSiteSettings({
      ...current,
      ...(updates && typeof updates === 'object' ? updates : {}),
    });

    migrated[siteKey] = next;
    return migrated;
  }

  function setSiteEnabled(activeSites, hostnameOrSiteKey, enabled) {
    const next = migrateActiveSites(activeSites);
    const siteKey = getLegacySiteKey(hostnameOrSiteKey);

    if (!siteKey) {
      return next;
    }

    if (enabled) {
      next[siteKey] = true;
    } else {
      delete next[siteKey];
    }

    return next;
  }

  /**
   * What this frame should do now.
   *
   * `reserve` is the live-toggle path's only new verb: a host the user has
   * enabled before (`seen`) loads the MAIN-world hook at `document_start` even
   * while it is off, so a later enable can start in place. It starts nothing —
   * the hook is loaded, patched and idle, which is why the page plays
   * unprocessed and pays no audio-graph cost.
   * @param {{ enabled: boolean, injected: boolean, hookAlive: boolean, seen?: boolean }} state
   */
  function getContentAction({ enabled, injected, hookAlive, seen }) {
    if (!enabled) {
      if (injected) return 'stop';
      return seen ? 'reserve' : 'idle';
    }

    if (!injected || !hookAlive) {
      return 'inject';
    }

    return 'start';
  }

  function getPopupIndicator({ enabled, hookAlive, hookActive, lastError }) {
    if (enabled && lastError) {
      return 'red';
    }

    if (enabled && hookAlive && hookActive) {
      return 'green';
    }

    return 'gray';
  }


  return {
    DEFAULT_GAIN_DB,
    clampGainDb,
    extractHostname,
    getSiteKey,
    getLegacySiteKey,
    migrateActiveSites,
    migrateSiteSettings,
    getSiteConfig,
    setSiteConfig,
    setSiteEnabled,
    getContentAction,
    getPopupIndicator,
    SITE_KEY_PREFIX,
    siteStorageKey,
    legacySiteStorageKey,
    isSiteStorageKey,
    siteKeyFromStorageKey,
    hostMatchesSiteKey,
    isHostExcluded,
    ancestorSiteKeys,
    siteExcludeMatchPattern,
    siteExcludeMatchPatterns,
    siteHostMatchPattern,
    siteHostMatchPatterns,
    normalizeSiteRecord,
    migrateLegacyToRecord,

  };
});
