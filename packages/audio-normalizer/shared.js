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

  // One canonical host form, shared by every key helper. Order matters:
  // punycode first (the browser punycodes `location.hostname`, but a stored or
  // legacy key may not be), then port, then trailing dots — `example.com.:443`
  // must collapse to `example.com`, which fails if the dot is stripped before
  // the port.
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

    // A port strip must not eat an IPv6 group: only a single-colon authority
    // has a port.
    const portless = /^[^:]+:\d+$/.test(normalized)
      ? normalized.replace(/:\d+$/, '')
      : normalized;
    return portless.replace(/\.+$/, '');
  }

  // Canonical site key: the FULL normalized hostname. `alice.github.io`
  // and `bob.github.io` are different sites and must never share a toggle.
  // The old collapsed (eTLD+1) form survives ONLY as a read-only legacy
  // fallback (`getLegacySiteKey`) for data written before full keys existed.
  function getSiteKey(hostname) {
    return normalizeHostname(hostname);
  }

  // Read-only legacy fallback: the pre-full-key collapse (sibling subdomains
  // merged, ccTLD-aware). Never used for new writes; reads consult it only
  // when no full-key record exists, and the first write migrates to the full
  // key. `alice.github.io` collapses to `github.io` here — that is the bug
  // being retired, kept solely to find old rows.
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

  // Per-site top-level storage keys: `site:<siteKey>` holds that site's
  // { enabled, gainDb, seq, mirror } in ONE value. The documented
  // `chrome.storage.local.set` granularity is the top-level key ("Any other
  // key/value pairs in storage will not be affected"), so a write to
  // `site:youtube.com` can never touch `site:example.com` — cross-site
  // clobber is impossible by construction, unlike a whole-map
  // read-modify-write of `siteSettings`. A single `set` carrying the whole
  // per-site record means settings/mirror/sequence can never diverge across
  // separate writes.
  var SITE_KEY_PREFIX = 'site:';

  function siteStorageKey(siteKey) {
    const normalized = getSiteKey(siteKey);
    if (!normalized) return '';
    return SITE_KEY_PREFIX + normalized;
  }

  // Read-only legacy fallback for per-site records written before full keys
  // existed (`site:github.io` covering every `*.github.io` host). The
  // background migrates a hit to the full key on its next write; the content
  // script never writes.
  function legacySiteStorageKey(siteKey) {
    const normalized = getLegacySiteKey(siteKey);
    if (!normalized) return '';
    return SITE_KEY_PREFIX + normalized;
  }

  function isSiteStorageKey(key) {
    return typeof key === 'string' && key.indexOf(SITE_KEY_PREFIX) === 0;
  }

  // Exclusion is a property of a HOST, and it covers that host's subdomains:
  // excluding `tiktok.com` must also exclude `www.tiktok.com`, and a rule on
  // `www.tiktok.com` must never reach `tiktok.com`. Both sides are normalized
  // through `getSiteKey` first (ports, case, trailing dots, brackets).
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

  // Parent hosts, nearest first, self excluded. The contract's suffix rule has
  // no label floor: `localhost` covers `foo.localhost` and `com` covers
  // `example.com`, so every parent is listed. A single-label host has none.
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

  // Content-script match pattern for a host. `*.` also covers the bare host
  // in Chrome's pattern grammar. A wildcard host is only valid for a real
  // domain: localhost, IPv4 and IPv6 keys get an exact-host pattern (a
  // rejected pattern would cost the whole registration).
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

  // Exclusion covers subdomains, so the pattern must too: `*://*.host/*`.
  function siteExcludeMatchPattern(siteKey) {
    return matchPatternFor(siteKey, true);
  }

  // Injection is per exact host: a record for `example.com` must not arm the
  // content script on `sub.example.com`, which is a different site here.
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
      // Missing field = not excluded: every record written before exclusion
      // existed reads as `excluded: false`, so no migration is needed.
      excluded: Boolean(raw.excluded),
      // `seen` = this host has been enabled at least once, and that fact is
      // never forgotten by a later disable. It is what makes enabling live on
      // an already-loaded page: a seen host loads with the page hook present
      // (passive) so a later enable needs no navigation. Derived on read, so
      // no migration is needed: a record that predates the field is seen
      // exactly when it is enabled (it was enabled once by definition).
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
    // Normalised existence: a raw key counts when it matches the FULL key or
    // the legacy collapsed key. Full-key matches win for values (they are the
    // newer, more specific truth); legacy matches keep pre-full-key users
    // whole. `siteSettings['www.youtube.com']` is still found when reading
    // `youtube.com` (bare host: full and legacy coincide there).
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
      // Legacy data only ever recorded enables, so an enabled legacy entry was
      // used once and is seen; a legacy disabled entry is not.
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
      // Merge when two raw keys collapse to one site (finding 4): the second
      // raw entry must not wipe the first's fields. Precedence is
      // last-explicit-field-wins — a field present in the later raw entry
      // overwrites, an absent field preserves the earlier value. The `true`
      // shorthand asserts only `enabled:true` and preserves gain.
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
    // Legacy whole-map read helper: the maps it reads are keyed by the OLD
    // collapsed form, so the lookup consults the collapsed key. The returned
    // `siteKey` is the new canonical FULL key. Full-key records (per-site
    // storage) never reach this helper — they are preferred before it.
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

  // Recurrence-path closure: the whole-map `siteToggles` mirror writer used
  // to live here (`saveSiteState`, a serialised read-modify-write of the
  // entire mirror map). It had zero callers in the product — the background
  // writes only per-site `site:<key>` records (plus the startup
  // `activeSites` clear), the content script performs zero storage writes,
  // and the popup sends field-level intents via messages — but as long as
  // the writer existed, any future popup-path call could re-create the
  // diverging state the owner reported (`siteToggles[site] = false` while a
  // per-site record says `enabled: true`, mirror newer). The writer is
  // therefore deleted; the mirror is now write-impossible from product code
  // and survives read-only as a migration fallback
  // (`migrateLegacyToRecord`, which repairs the diverge once by letting an
  // explicit toggle win `enabled`). Every legacy READ shape is preserved:
  // `get` keys, the `changes.siteToggles` listeners, and the migration
  // arguments. A structural test (`setting-loss.test.js`: "no product writer
  // can re-create a mirror/settings diverge") fails if any `siteToggles` /
  // `siteSettings` write ever returns to product code.

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
    // NOTE: `saveSiteState` (the whole-map `siteToggles` mirror writer) was
    // deleted to close the recurrence path — see the note above. It is
    // deliberately absent from this export, not an omission.
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
