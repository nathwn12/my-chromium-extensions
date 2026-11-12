(() => {
  const existing = globalThis.__tabNormalizerContentScriptV5;
  if (existing?.reinject) {
    existing.reinject();
    return;
  }

  const CHANNEL = 'tab-normalizer-v5';
  const HOOK_TIMEOUT_MS = 1000;
  const HOOK_FRESH_MS = 3000;
  const INJECT_TIMEOUT_MS = 5000;
  const ACTIVATE_RETRY_COUNT = 5;
  const ACTIVATE_RETRY_MS = 250;
  const PENDING_ATTR = 'data-tab-normalizer-pending';

  const contentShared = globalThis.TabNormalizerShared;

  // ---------------------------------------------------------------------------
  // Backstop gate (layer 2).
  //
  // Registration-time exclusion (layer 1) keeps this file out of excluded
  // hosts entirely, so this gate only has to cover the paths a registration
  // cannot: a frame that was already open when the exclusion was written (the
  // storage broadcast seeds the cache below), registration lag, and a
  // re-injection of this file into a document whose cache already knows.
  //
  // It is deliberately read-free and create-free: `location.hostname` against
  // a cached key list, before any listener, observer or timer exists. Storage
  // cannot be read synchronously, so "unknown yet" is NEVER treated as
  // excluded — it falls through to the ordinary async read, which decides.
  // The cache is refreshed only by the storage broadcast that already exists;
  // there is no polling.
  // ---------------------------------------------------------------------------
  const exclusionCache = globalThis.__tabNormalizerExclusionCache
    || (globalThis.__tabNormalizerExclusionCache = { hosts: [] });

  function currentHost() {
    return contentShared.getSiteKey(
      String(location.hostname || '') || contentShared.extractHostname(location.href),
    );
  }

  function isExcludedByCache() {
    const host = currentHost();
    if (!host) return false;
    return contentShared.isHostExcluded(host, exclusionCache.hosts);
  }

  function rememberExclusion(siteKey, excluded) {
    const key = contentShared.getSiteKey(siteKey);
    if (!key) return;
    const hosts = exclusionCache.hosts.filter((entry) => entry !== key);
    if (excluded) hosts.push(key);
    exclusionCache.hosts = hosts;
  }

  if (isExcludedByCache()) {
    // Nothing is installed on purpose: not even the re-injection hook. An
    // excluded document carries no extension code at all until the background
    // re-injects after the exclusion is cleared.
    console.log('[cs] host excluded by registration cache, gated:', currentHost());
    return;
  }

  /** @type {{
   *   hostname: string, siteKey: string, enabled: boolean, gainDb: number,
   *   excluded: boolean,
   *   injected: boolean, hookAlive: boolean,
   *   hookActive: boolean, injecting: boolean, injectStartedAt: number,
   *   lastError: string, lastStatusAt: number,
   *   transient: ({ enabled: boolean, gainDb: number } | null),
   *   pendingProbe: ({ requestId: string, promise: Promise<boolean>, resolve: (v: boolean) => void, timeoutId: number } | null),
   *   popupProbe: (Promise<boolean> | null),
   *   syncInFlight: boolean, queuedSyncReason: string,
   *   activeSync: (Promise<void> | null), initialSyncDone: boolean,
   *   bootstrapped: boolean, activationRetryTimer: (number | null),
   *   activationRetryCount: number, spaWatchTimer: (number | null),
   *   storageChangeTimer: (number | null), detached: boolean
   * }} */
  const state = {
    hostname: '',
    siteKey: '',
    enabled: false,
    gainDb: contentShared.DEFAULT_GAIN_DB,
    excluded: false,
    injected: false,
    hookAlive: false,
    hookActive: false,
    injecting: false,
    injectStartedAt: 0,
    lastError: '',
    lastStatusAt: 0,
    transient: null,
    pendingProbe: null,
    popupProbe: null,
    syncInFlight: false,
    queuedSyncReason: '',
    activeSync: null,
    initialSyncDone: false,
    bootstrapped: false,
    activationRetryTimer: null,
    activationRetryCount: 0,
    spaWatchTimer: null,
    storageChangeTimer: null,
    detached: false,
  };

  // Every listener this frame owns, so teardown can release all of them (an
  // excluded frame must leave nothing behind that could do work).
  /** @type {Array<() => void>} */
  let listenerRemovers = [];

  globalThis.__tabNormalizerContentScriptV5 = {
    reinject: handleReinject,
  };

  refreshLocationState();
  console.log('[cs] loaded on:', state.hostname, location.href);
  ensureBootstrapListeners();
  if (state.siteKey) {
    scheduleSync('init');
  } else {
    console.log('[cs] no hostname, skipping');
  }

  function refreshLocationState() {
    state.hostname = contentShared.extractHostname(location.href);
    state.siteKey = contentShared.getSiteKey(state.hostname);
  }

  function ensureBootstrapListeners() {
    if (state.bootstrapped || !state.siteKey || state.detached) return;

    const onStorageChanged = (changes, area) => {
      if (area !== 'local') return;
      const perKey = state.siteKey ? contentShared.siteStorageKey(state.siteKey) : '';
      // A parent-host record governs this frame too (exclusion covers
      // subdomains), so its changes must not be filtered out.
      const relevantAncestorChange = contentShared.ancestorSiteKeys(state.siteKey)
        .some((key) => changes[contentShared.siteStorageKey(key)]);
      if (!changes.activeSites && !changes.siteSettings && !changes.siteToggles
        && !(perKey && changes[perKey]) && !relevantAncestorChange) return;
      // Keep the synchronous gate's cache in step with persisted truth: this
      // is the only refresh mechanism, there is no polling.
      for (const [key, change] of Object.entries(changes)) {
        if (!contentShared.isSiteStorageKey(key)) continue;
        rememberExclusion(
          contentShared.siteKeyFromStorageKey(key),
          Boolean(change.newValue && change.newValue.excluded),
        );
      }
      // Persisted truth changed. Drop the transient session override
      // only when this tab's effective config actually changed, so an
      // unrelated site's save never cuts a transient session short — but the
      // next storage change for THIS site always clears it, and an ordinary
      // persisted save then reads storage like any other tab.
      if (storageChangeAffectsThisSite(changes)) {
        state.transient = null;
      }
      if (state.storageChangeTimer) return;
      state.storageChangeTimer = setTimeout(() => {
        state.storageChangeTimer = null;
        console.log('[cs] storage changed, syncing');
        scheduleSync('storage');
      }, 50);
    };
    chrome.storage.onChanged.addListener(onStorageChanged);
    listenerRemovers.push(() => chrome.storage.onChanged.removeListener?.(onStorageChanged));

    const onRuntimeMessage = (message, _sender, sendResponse) => {
      if (message?.type === 'GET_DOCUMENT_STATUS') {
        void getDocumentStatus().then(sendResponse);
        return true;
      }
      if (message?.type === 'SET_DOCUMENT_STATE') {
        void handleSetDocumentState(message).then(sendResponse);
        return true;
      }
      if (message?.type === 'SOFT_RECHECK_DOCUMENT') {
        void handleSoftRecheckDocument().then(sendResponse);
        return true;
      }
      if (message?.type === 'CLEAR_SESSION_OVERRIDE') {
        state.transient = null;
        scheduleSync('clear-override');
        sendResponse({ ok: true });
        return true;
      }
      if (message?.type === 'TOGGLE_CHANGED') {
        // The stored per-site record is the authority. This broadcast is only
        // a nudge to re-read storage, never a snapshot that outranks it. Guard the
        // site: tabs.sendMessage reaches every frame (all_frames:true), so a
        // toggle for page A must never reset an embedded frame from site B.
        // Finding 3: fail-closed — act only on an exact `siteKey` match and
        // reject when it is absent. `intendedToggleSite && ...` let an absent
        // key through to STOP, so disabling page A reset foreign frames.
        // Finding 2: a delayed disable broadcast must never stop a
        // re-enabled tab. The disable path re-reads the stored truth first;
        // when storage says enabled the broadcast is stale and the tab
        // re-syncs instead of calling cleanupAndReset().
        const intendedToggleSite = typeof message.siteKey === 'string'
          ? contentShared.getSiteKey(message.siteKey)
          : '';
        if (!intendedToggleSite || intendedToggleSite !== state.siteKey) {
          sendResponse({ ok: false, error: 'site mismatch' });
          return true;
        }
        // Live teardown: exclusion beats everything, so it never waits for a
        // storage round trip. The MAIN-world patch cannot be removed (it is
        // already in the page) — STOP puts it in pass-through: worklet
        // disconnected, observer disconnected, 0 dB.
        if (message.excluded === true) {
          state.excluded = true;
          state.transient = null;
          teardown('excluded');
          sendResponse({ ok: true, excluded: true });
          return true;
        }
        if (message.excluded === false) {
          rememberExclusion(state.siteKey, false);
          state.excluded = false;
        }
        if (message.enabled) {
          scheduleSync('toggle-changed');
          sendResponse({ ok: true });
          return true;
        }
        void (async () => {
          try {
            const cfg = await readStoredConfig();
            if (cfg.enabled) {
              scheduleSync('toggle-changed-stale-disable');
            } else {
              state.transient = null;
              cleanupAndReset();
            }
          } catch {
            // Fail closed on a read failure: never stop a potentially live
            // hook on a message alone — re-sync instead.
            scheduleSync('toggle-changed-read-failed');
          }
          sendResponse({ ok: true });
        })();
        return true;
      }
      return false;
    };
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    listenerRemovers.push(() => chrome.runtime.onMessage.removeListener?.(onRuntimeMessage));

    const onPageMessage = (event) => {
      if (event.source !== window || event.data?.channel !== CHANNEL) return;
      handleHookMessage(event.data);
    };
    window.addEventListener('message', onPageMessage);
    listenerRemovers.push(() => window.removeEventListener('message', onPageMessage));

    const onVisibilityChange = () => {
      if (!document.hidden) scheduleSync('visibilitychange');
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    listenerRemovers.push(() => document.removeEventListener('visibilitychange', onVisibilityChange));

    const onPageShow = () => scheduleSync('pageshow');
    window.addEventListener('pageshow', onPageShow);
    listenerRemovers.push(() => window.removeEventListener('pageshow', onPageShow));

    const onFocus = () => scheduleSync('focus');
    window.addEventListener('focus', onFocus);
    listenerRemovers.push(() => window.removeEventListener('focus', onFocus));

    const onPopState = () => {
      refreshLocationState();
      if (state.siteKey) scheduleSync('popstate');
    };
    window.addEventListener('popstate', onPopState);
    listenerRemovers.push(() => window.removeEventListener('popstate', onPopState));

    const onHashChange = () => {
      refreshLocationState();
      if (state.siteKey) scheduleSync('hashchange');
    };
    window.addEventListener('hashchange', onHashChange);
    listenerRemovers.push(() => window.removeEventListener('hashchange', onHashChange));

    state.bootstrapped = true;
  }

  /**
   * Whether a storage change alters this tab's effective config. A per-site
   * `site:<key>` change for THIS site counts; missing maps are equal on both
   * sides, so only a real before/after difference for this siteKey counts
   * (legacy activeSites merges are evaluated exactly).
   * @param {Record<string, { oldValue?: unknown, newValue?: unknown }>} changes
   */
  function storageChangeAffectsThisSite(changes) {
    if (!state.siteKey) return true;
    try {
      const perKey = contentShared.siteStorageKey(state.siteKey);
      if (perKey && changes[perKey]) {
        const oldRec = changes[perKey].oldValue && typeof changes[perKey].oldValue === 'object'
          ? contentShared.normalizeSiteRecord(changes[perKey].oldValue)
          : null;
        const newRec = changes[perKey].newValue && typeof changes[perKey].newValue === 'object'
          ? contentShared.normalizeSiteRecord(changes[perKey].newValue)
          : null;
        if (!oldRec || !newRec) return true;
        return oldRec.enabled !== newRec.enabled
          || oldRec.gainDb !== newRec.gainDb
          || oldRec.excluded !== newRec.excluded;
      }
      // Legacy fallback: evaluate the effective config (settings + actives
      // + toggles, all normalised) on both sides. A `siteToggles` change for
      // THIS site counts exactly like a settings/active change.
      if (!changes.siteSettings && !changes.activeSites && !changes.siteToggles) return false;
      const oldSettings = changes.siteSettings ? (changes.siteSettings.oldValue || {}) : {};
      const newSettings = changes.siteSettings ? (changes.siteSettings.newValue || {}) : {};
      const oldActive = changes.activeSites ? (changes.activeSites.oldValue || {}) : {};
      const newActive = changes.activeSites ? (changes.activeSites.newValue || {}) : {};
      const oldToggles = changes.siteToggles ? (changes.siteToggles.oldValue || {}) : {};
      const newToggles = changes.siteToggles ? (changes.siteToggles.newValue || {}) : {};
      const oldMig = contentShared.migrateLegacyToRecord(oldSettings, oldActive, oldToggles, state.siteKey);
      const newMig = contentShared.migrateLegacyToRecord(newSettings, newActive, newToggles, state.siteKey);
      if (oldMig || newMig) {
        const o = oldMig || { enabled: false, gainDb: 0 };
        const n = newMig || { enabled: false, gainDb: 0 };
        return o.enabled !== n.enabled || o.gainDb !== n.gainDb;
      }
      const oldConfig = contentShared.getSiteConfig(oldSettings, oldActive, state.siteKey);
      const newConfig = contentShared.getSiteConfig(newSettings, newActive, state.siteKey);
      return oldConfig.enabled !== newConfig.enabled
        || oldConfig.gainDb !== newConfig.gainDb;
    } catch {
      return true;
    }
  }

  /**
   * Read this tab's effective stored config: the per-site `site:<key>` record
   * is the authority; legacy `siteSettings`/`activeSites` (+ explicit
   * `siteToggles` when present via the background migration) are the fallback
   * for data written before the per-site keys existed. Read-only: this file
   * performs NO storage write.
   *
   * Exclusion is read from this host's record OR any parent host's record
   * (the same `h === key || h.endsWith('.' + key)` rule), so one `get` with a
   * handful of keys resolves a parent-level exclusion without scanning
   * storage.
   * @returns {Promise<{ enabled: boolean, gainDb: number, excluded: boolean }>}
   */
  async function readStoredConfig() {
    const perKey = contentShared.siteStorageKey(state.siteKey);
    const ancestorKeys = contentShared.ancestorSiteKeys(state.siteKey)
      .map((key) => contentShared.siteStorageKey(key))
      .filter(Boolean);
    // Platform fact (measured Step 1 repro): an object-form `undefined`
    // default is dropped by the extension API's JSON marshal, so
    // `get({ [perKey]: undefined })` returns `{}` even when the key exists.
    // The array form is proven to return the value. Missing keys are simply
    // absent; the callees below tolerate undefined legacy maps.
    /** @type {string[]} */
    const keys = ['activeSites', 'siteSettings', 'siteToggles'];
    if (perKey) keys.push(perKey);
    for (const key of ancestorKeys) {
      if (key !== perKey) keys.push(key);
    }
    const stored = await chrome.storage.local.get(keys);

    // Parent-host exclusion first: it outranks every `enabled` below.
    const ancestorExcluded = ancestorKeys.some((key) => {
      const value = stored[key];
      return Boolean(value && typeof value === 'object' && value.excluded);
    });
    if (ancestorExcluded) {
      rememberExclusion(state.siteKey, true);
    }

    const withExcluded = (rec) => ({
      enabled: ancestorExcluded ? false : rec.enabled,
      gainDb: rec.gainDb,
      excluded: ancestorExcluded || rec.excluded,
    });

    const perValue = perKey ? stored[perKey] : undefined;
    if (perValue && typeof perValue === 'object') {
      const rec = contentShared.normalizeSiteRecord(perValue);
      rememberExclusion(state.siteKey, rec.excluded);
      return withExcluded(rec);
    }
    // Pre-full-key fallback (read-only here; the background migrates on its
    // next write): a collapsed per-site record (`site:github.io`) still
    // authorizes every full host it used to cover.
    // (`legacySiteStorageKey` is new in shared.js; the any-alias keeps this
    // file green until the type declaration catches up.)
    const sharedAny = /** @type {any} */ (contentShared);
    const legacyPerKey = typeof sharedAny.legacySiteStorageKey === 'function'
      ? sharedAny.legacySiteStorageKey(state.siteKey)
      : '';
    if (legacyPerKey && legacyPerKey !== perKey) {
      // The ancestor read above may already carry the legacy record; only a
      // miss costs a second read.
      let legacyValue = stored[legacyPerKey];
      if (legacyValue === undefined) {
        const legacyStored = await chrome.storage.local.get([legacyPerKey]);
        legacyValue = legacyStored[legacyPerKey];
      }
      if (legacyValue && typeof legacyValue === 'object') {
        const rec = contentShared.normalizeSiteRecord(legacyValue);
        rememberExclusion(state.siteKey, rec.excluded);
        return withExcluded(rec);
      }
    }
    // Lossless legacy fallback: normalise every legacy shape (settings,
    // actives AND toggles) before matching, so a `www.`-only entry is found
    // from the canonical key. Read-only — persistence belongs to the
    // background single writer.
    const migrated = contentShared.migrateLegacyToRecord(
      stored.siteSettings, stored.activeSites, stored.siteToggles, state.siteKey,
    );
    if (migrated) {
      return withExcluded(migrated);
    }
    const config = contentShared.getSiteConfig(stored.siteSettings, stored.activeSites, state.siteKey);
    return withExcluded({ enabled: config.enabled, gainDb: config.gainDb, excluded: false });
  }

  function startSpaWatch() {
    stopSpaWatch();
    let lastHref = location.href;
    state.spaWatchTimer = setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      refreshLocationState();
      if (state.siteKey) scheduleSync('spa-navigation');
    }, 5000);
  }

  function stopSpaWatch() {
    if (state.spaWatchTimer) {
      clearInterval(state.spaWatchTimer);
      state.spaWatchTimer = null;
    }
  }

  function handleReinject() {
    refreshLocationState();
    console.log('[cs] reinjected on:', state.hostname, location.href);
    // A re-injection is the background's decision (it refuses excluded hosts),
    // so re-arm rather than trust a possibly stale cache: drop the detached
    // state, re-install listeners and let the async read decide.
    if (state.detached) {
      state.detached = false;
      state.bootstrapped = false;
      state.initialSyncDone = false;
    }
    ensureBootstrapListeners();
    if (!state.siteKey) return;
    scheduleSync('reinject');
  }

  function isActivationPending() {
    return state.enabled && (state.injecting || state.syncInFlight || Boolean(state.pendingProbe));
  }

  /**
   * @param {string} reason
   */
  function scheduleSync(reason) {
    if (state.syncInFlight) {
      state.queuedSyncReason = reason;
      return;
    }

    state.activeSync = sync(reason).catch(() => {});
    void state.activeSync;
  }

  function clearActivationRetry() {
    if (state.activationRetryTimer) {
      clearTimeout(state.activationRetryTimer);
      state.activationRetryTimer = null;
    }
    state.activationRetryCount = 0;
  }

  function getWorkletUrl() {
    try {
      return chrome.runtime.getURL('audio/normalizer-worklet.js');
    } catch {
      return '';
    }
  }

  function postStart(reason) {
    // Worklet URL contract: the ISOLATED content script is the only party
    // that knows chrome.runtime.getURL, so every START carries it for the
    // MAIN-world hook (which cannot call chrome.runtime.getURL reliably).
    postToPage('START', { reason, gainDb: state.gainDb, workletUrl: getWorkletUrl() });
  }

  // Liveness re-sync: a hook that was injected but is no longer alive
  // (probe timeout, popup probe timeout, HOOK_STOPPED while still enabled)
  // must re-sync via the existing activation retry/backoff — never a busy
  // loop (scheduleActivationRetry caps at ACTIVATE_RETRY_COUNT).
  function scheduleLivenessResync(reason) {
    if (!state.enabled || !state.siteKey) return;
    if (!state.injected || state.hookAlive) return;
    scheduleActivationRetry(reason);
  }

  function scheduleActivationRetry(reason) {
    if (!state.enabled || !state.siteKey) return;

    clearActivationRetry();
    const tick = () => {
      state.activationRetryTimer = null;

      if (!state.enabled || !state.siteKey) {
        state.activationRetryCount = 0;
        return;
      }

      postToPage('START', { reason, gainDb: state.gainDb, workletUrl: getWorkletUrl() });
      postToPage('SET_GAIN', { gainDb: state.gainDb });

      state.activationRetryCount += 1;
      if (state.activationRetryCount < ACTIVATE_RETRY_COUNT && (!state.hookAlive || !state.hookActive)) {
        state.activationRetryTimer = setTimeout(tick, ACTIVATE_RETRY_MS);
      } else {
        state.activationRetryCount = 0;
      }
    };

    tick();
  }

  async function handleSetDocumentState(message) {
    // Single-writer rule: persistence lives only in background.js
    // (SET_SITE_STATE -> per-site `site:<key>`). This tab message is
    // read-only: it applies state to the live document and never writes
    // storage (zero `chrome.storage.local.set` calls are reachable from this
    // path; no migration write exists anywhere in this file).
    // Explicit site guard: a popup action names the site it is showing and a
    // frame ignores a mismatched key, so disabling page A can never disable
    // an embedded cross-origin iframe from site B. Fail-closed — only an
    // exact `siteKey` match applies; a matching `hostname` alone is rejected.
    const intendedSite = typeof message?.siteKey === 'string'
      ? contentShared.getSiteKey(message.siteKey)
      : '';
    if (!intendedSite || intendedSite !== state.siteKey) {
      return { ok: false, error: 'site mismatch' };
    }
    // Exclusion outranks every document-state path, transient or persisted:
    // an excluded frame is torn down and stays down. The popup disables its
    // controls in this state, so this only ever answers a stale caller.
    if (state.excluded) {
      teardown('excluded-document-state');
      return { ok: true, excluded: true };
    }
    // Genuine transient session state — the background flags its
    // pending-session apply with `transient: true` (`persist: false` is
    // accepted for the same contract). ONLY a flagged request installs the
    // session override: an ordinary persisted save arrives
    // unflagged and must leave this document reading storage like any other
    // tab, never installing a snapshot that later storage changes cannot
    // dislodge. A transient DISABLE installs the override too:
    // enabled:false outranks stored enabled:true for this tab's lifetime, and
    // only the next storage change for this site clears it.
    const isTransient = message.transient === true || message.persist === false;
    if (!isTransient) {
      state.transient = null;
      await sync('document-state');
      return { ok: true };
    }
    // Transient path: apply the message's fields to the live document without
    // touching storage. Missing fields fall back to stored defaults via a
    // single read; when the message names every field no storage is touched
    // (drag-preview live applies stay read-free). Nothing is persisted.
    let enabled;
    let gainDb;
    const hasEnabled = Object.prototype.hasOwnProperty.call(message, 'enabled');
    const hasGain = Object.prototype.hasOwnProperty.call(message, 'gainDb');
    if (hasEnabled && hasGain) {
      enabled = Boolean(message.enabled);
      gainDb = contentShared.clampGainDb(message.gainDb);
    } else {
      const base = await readStoredConfig();
      enabled = hasEnabled ? Boolean(message.enabled) : base.enabled;
      gainDb = hasGain ? contentShared.clampGainDb(message.gainDb) : base.gainDb;
    }
    state.transient = { enabled, gainDb };
    state.enabled = enabled;
    state.gainDb = gainDb;

    console.log('[cs] document-state (transient):', state.siteKey, 'enabled:', enabled, 'gainDb:', gainDb);

    const hookAlive = await evaluateHookHealth();
    const action = contentShared.getContentAction({ enabled, injected: state.injected, hookAlive });

    if (action === 'inject') {
      setPendingStart();
      inject();
      scheduleActivationRetry('document-state');
      startSpaWatch();
      return { ok: true };
    }

    if (action === 'start') {
      setPendingStart();
      postToPage('START', { reason: 'document-state', gainDb, workletUrl: getWorkletUrl() });
      postToPage('SET_GAIN', { gainDb });
      scheduleActivationRetry('document-state');
      startSpaWatch();
      console.log('[cs] sent START to hook');
      return { ok: true };
    }

    if (action === 'stop') {
      clearPendingStart();
      clearActivationRetry();
      stopSpaWatch();
      postToPage('STOP', { reason: 'document-state' });
      state.hookActive = false;
      state.hookAlive = false;
      state.lastError = '';
      return { ok: true };
    }

    clearPendingStart();
    if (state.injected) {
      startSpaWatch();
      postToPage('SET_GAIN', { gainDb });
      scheduleActivationRetry('document-state');
    }
    return { ok: true };
  }

  function cleanupAndReset() {
    clearPendingStart();
    clearActivationRetry();
    stopSpaWatch();
    postToPage('STOP', { reason: 'toggle-changed' });
    state.hookActive = false;
    state.hookAlive = false;
    state.lastError = '';
  }

  /**
   * Live teardown for an excluded host (layer 2, immediate path).
   *
   * Everything this frame owns is released: the SPA watch, the activation
   * retry chain, the storage debounce, any in-flight hook probe, and every
   * listener. `STOP` puts the already-injected MAIN-world patch into
   * pass-through: `bypassSession` disconnects the worklet and routes
   * input -> output directly, the DOM observer is disconnected, the recovery
   * burst is cancelled, and no gain is applied (0 dB by construction). The
   * patch itself cannot be removed from a live document — that needs a
   * reload — so "excluded" means neutralised, never un-patched.
   * @param {string} reason
   */
  function teardown(reason) {
    if (state.detached) return;
    state.detached = true;
    state.enabled = false;
    state.transient = null;

    clearPendingStart();
    clearActivationRetry();
    stopSpaWatch();
    if (state.storageChangeTimer) {
      clearTimeout(state.storageChangeTimer);
      state.storageChangeTimer = null;
    }
    // A probe in flight would otherwise keep its 1 s timeout alive and write
    // hook state after teardown.
    if (state.pendingProbe) {
      clearTimeout(state.pendingProbe.timeoutId);
      state.pendingProbe.resolve(false);
      state.pendingProbe = null;
    }
    state.popupProbe = null;

    postToPage('STOP', { reason });
    state.hookActive = false;
    state.hookAlive = false;
    state.lastError = '';

    for (const remove of listenerRemovers) {
      try {
        remove();
      } catch {}
    }
    listenerRemovers = [];
    state.bootstrapped = false;
    rememberExclusion(state.siteKey, true);
    console.log('[cs] torn down (excluded):', state.siteKey, reason);
  }

  async function handleSoftRecheckDocument() {
    const { enabled } = await getEffectiveDocumentState();
    if (!enabled) {
      return getDocumentStatus();
    }

    await sync('soft-recheck');
    return getDocumentStatus();
  }

  /**
   * @param {string} reason
   */
  async function sync(reason) {
    refreshLocationState();
    // A detached frame (excluded) owns no listeners and does no work until
    // the background re-injects it.
    if (state.detached) return;
    if (!state.siteKey) {
      clearPendingStart();
      clearActivationRetry();
      stopSpaWatch();
      state.enabled = false;
      state.hookAlive = false;
      state.hookActive = false;
      state.lastError = '';
      return;
    }

    if (state.syncInFlight) {
      state.queuedSyncReason = reason;
      return;
    }

    state.syncInFlight = true;

    try {
      // The per-site `site:<key>` record is the single authority; legacy maps
      // are the read fallback. This file performs NO storage write — migration
      // persistence belongs to the background's single writer; this context
      // only reads.
      const config = await readStoredConfig();
      // Exclusion outranks the transient session override AND stored
      // enablement: nothing runs on an excluded site, on any path.
      state.excluded = config.excluded === true;
      const enabled = config.excluded
        ? false
        : (state.transient ? state.transient.enabled : config.enabled);
      const gainDb = config.excluded
        ? contentShared.DEFAULT_GAIN_DB
        : (state.transient ? state.transient.gainDb : config.gainDb);

      if (config.excluded) {
        // Live teardown, not a plain "disabled": an excluded frame releases
        // its listeners entirely so it does no work at all.
        state.enabled = false;
        state.gainDb = gainDb;
        teardown('excluded-sync');
        return;
      }

      state.enabled = enabled;
      state.gainDb = gainDb;

      console.log('[cs] sync:', state.siteKey, 'enabled:', enabled, 'gainDb:', gainDb, 'injected:', state.injected, 'hookAlive:', state.hookAlive, 'reason:', reason);

      const hookAlive = enabled ? await evaluateHookHealth() : state.hookAlive;
      const action = contentShared.getContentAction({ enabled, injected: state.injected, hookAlive });

      if (action === 'inject') {
        setPendingStart();
        inject();
        scheduleActivationRetry(reason);
        startSpaWatch();
        return;
      }

      if (action === 'start') {
        setPendingStart();
        postToPage('START', { reason, gainDb, workletUrl: getWorkletUrl() });
        postToPage('SET_GAIN', { gainDb });
        scheduleActivationRetry(reason);
        startSpaWatch();
        console.log('[cs] sent START to hook');
        return;
      }

      if (action === 'stop') {
        clearPendingStart();
        clearActivationRetry();
        stopSpaWatch();
        postToPage('STOP', { reason });
        state.hookActive = false;
        state.hookAlive = false;
        state.lastError = '';
        return;
      }

      clearPendingStart();
      if (!enabled) {
        stopSpaWatch();
        state.hookAlive = false;
        state.hookActive = false;
        state.lastError = '';
      }

      if (enabled && state.injected) {
        startSpaWatch();
        postToPage('SET_GAIN', { gainDb });
        scheduleActivationRetry(reason);
      }
    } finally {
      state.syncInFlight = false;
      state.initialSyncDone = true;
      if (state.queuedSyncReason) {
        const nextReason = state.queuedSyncReason;
        state.queuedSyncReason = '';
        state.activeSync = sync(nextReason).catch(() => {});
        try {
          await state.activeSync;
        } catch {}
      }
      if (!state.queuedSyncReason) {
        state.activeSync = null;
      }
    }
  }

  function inject() {
    // Never inject for an excluded frame, on any path.
    if (state.excluded || state.detached) return;
    if (state.injecting && (Date.now() - state.injectStartedAt) < INJECT_TIMEOUT_MS) return;

    if (state.injected) clearPendingStart();

    state.injecting = true;
    state.injectStartedAt = Date.now();
    state.injected = true;
    state.hookAlive = false;

    const workletUrl = chrome.runtime.getURL('audio/normalizer-worklet.js');
    document.documentElement?.setAttribute('data-tn-worklet-url', workletUrl);

    chrome.runtime.sendMessage({ type: 'INJECT_PAGE_HOOK' })
      .then((response) => {
        state.injecting = false;
        if (!response?.ok) {
          console.error('[cs] page-hook injection failed:', response?.error || 'unknown');
          state.injected = false;
          state.lastError = 'Failed to inject page hook.';
          return;
        }
        console.log('[cs] page-hook.js injected via background');
        if (state.enabled) {
          postToPage('START', { reason: 'inject-onload', gainDb: state.gainDb, workletUrl: getWorkletUrl() });
          postToPage('SET_GAIN', { gainDb: state.gainDb });
          scheduleActivationRetry('inject-onload');
        }
      })
      .catch((error) => {
        // A rejected injection must not stall later attempts until
        // INJECT_TIMEOUT_MS expires: release the flag and surface the error.
        state.injecting = false;
        state.lastError = 'Failed to inject page hook.';
        console.error('[cs] page-hook injection failed:', error);
      });
  }

  function handleHookMessage(data) {
    if (!data?.type) return;

    if (data.type === 'HOOK_STARTED' || data.type === 'HOOK_STATUS' || data.type === 'HOOK_ERROR') {
      console.log('[cs] hook status:', data.type, 'active:', Boolean(data.active), 'error:', data.error || '');
      state.injected = true;
      state.hookAlive = true;
      state.hookActive = Boolean(data.active);
      state.lastError = state.enabled ? String(data.error || '') : '';
      state.lastStatusAt = Date.now();
      if (data.type === 'HOOK_STARTED' || data.active) {
        clearPendingStart();
      }
      resolveProbe(true);
      // Disabled-tab backstop: the page can set the DOM pending attribute and
      // call revive() after Active off, re-routing audio. A hook that reports
      // active while this tab is disabled gets an immediate STOP; the hook
      // itself ignores the DOM fallback after stop until a real START.
      if (!state.enabled && data.active) {
        postToPage('STOP', { reason: 'disabled-active-backstop' });
        state.hookActive = false;
      }
      // Gain re-assertion: the hook echoes its live gainDb on every status
      // (it numbers no provenance between our SET_GAIN and a page forgery),
      // so a page SET_GAIN that drifted the hook cannot persist — correct it
      // at once with the stored truth.
      if (state.enabled && typeof data.gainDb === 'number'
        && Number.isFinite(data.gainDb)
        && contentShared.clampGainDb(data.gainDb) !== contentShared.clampGainDb(state.gainDb)) {
        postToPage('SET_GAIN', { gainDb: state.gainDb });
      }
      return;
    }

    if (data.type === 'HOOK_STOPPED') {
      state.hookAlive = false;
      state.hookActive = false;
      state.lastError = '';
      state.lastStatusAt = Date.now();
      clearActivationRetry();
      resolveProbe(false);
      // Liveness: the hook died while this frame still wants audio — re-sync
      // through the capped activation retry instead of going silent.
      if (state.injected && !state.hookAlive) scheduleLivenessResync('hook-stopped');
    }
  }

  async function evaluateHookHealth() {
    if (state.excluded || state.detached) return false;
    if (!state.injected) return false;
    if (state.hookAlive && (Date.now() - state.lastStatusAt) < HOOK_FRESH_MS) return true;
    return probeHook();
  }

  async function probeHook() {
    if (!state.injected) {
      return false;
    }

    if (state.pendingProbe) {
      return state.pendingProbe.promise;
    }

    const requestId = `probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const pending = createProbe(requestId);
    postToPage('STATUS_REQUEST', { requestId });
    return pending;
  }

  function createProbe(requestId) {
    /** @type {(v: boolean) => void} */
    let resolvePending = () => {};
    const pendingPromise = new Promise((resolve) => {
      resolvePending = resolve;
    });

    state.pendingProbe = {
      requestId,
      promise: pendingPromise,
      resolve: resolvePending,
      timeoutId: setTimeout(() => {
        if (state.pendingProbe?.requestId !== requestId) return;
        state.pendingProbe = null;
        state.hookAlive = false;
        state.hookActive = false;
        resolvePending(false);
        // Liveness: injected but dead — re-sync via capped retry, no busy loop.
        if (state.injected && !state.hookAlive) scheduleLivenessResync('probe-timeout');
      }, HOOK_TIMEOUT_MS),
    };

    return pendingPromise;
  }

  function resolveProbe(alive) {
    if (!state.pendingProbe) return;

    clearTimeout(state.pendingProbe.timeoutId);
    state.pendingProbe.resolve(alive);
    state.pendingProbe = null;
  }

  function probePopup() {
    if (!state.enabled) return Promise.resolve(false);
    if (!state.injected) return Promise.resolve(false);

    return new Promise((resolve) => {
      const requestId = `popup-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      let settled = false;

      const handler = (event) => {
        if (settled) return;
        if (event.source !== window || event.data?.channel !== CHANNEL) return;
        if (event.data.requestId !== requestId) return;
        settled = true;
        window.removeEventListener('message', handler);
        clearTimeout(timeoutId);
        state.hookAlive = true;
        state.hookActive = Boolean(event.data.active);
        state.lastError = state.enabled ? String(event.data.error || '') : '';
        state.lastStatusAt = Date.now();
        resolve(true);
      };

      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', handler);
        state.hookAlive = false;
        state.hookActive = false;
        resolve(false);
        // Liveness: injected but dead — re-sync via capped retry, no busy loop.
        if (state.injected && !state.hookAlive) scheduleLivenessResync('popup-probe-timeout');
      }, HOOK_TIMEOUT_MS);

      window.addEventListener('message', handler);
      postToPage('STATUS_REQUEST', { requestId });
    });
  }

  async function getEffectiveDocumentState() {
    // A transient session override outranks stored settings for the live
    // document until cleared. The per-site record stays the persistence
    // authority; the transient only shapes what this tab applies and reports.
    // Exclusion outranks both.
    if (state.excluded) {
      state.enabled = false;
      return { enabled: false, gainDb: state.gainDb, excluded: true };
    }
    if (state.transient) {
      state.enabled = state.transient.enabled;
      state.gainDb = state.transient.gainDb;
      return { ...state.transient };
    }
    // The per-site record is the single authority (legacy maps are the
    // read fallback). No session snapshot outranks it.
    const config = await readStoredConfig();
    state.excluded = config.excluded === true;
    const enabled = config.excluded ? false : config.enabled;
    const gainDb = config.gainDb;

    state.enabled = enabled;
    state.gainDb = gainDb;
    return { enabled, gainDb };
  }

  async function getDocumentStatus() {
    // In-memory answer: the 750 ms popup poll must NOT re-read storage in
    // the tab (4,800 reads/hour). Storage is re-read only on
    // `storage.onChanged` (via scheduleSync) and on explicit document-state
    // applies. Before the first sync lands, wait for it once so the first
    // answer is not a default-disabled snapshot.
    if (!state.initialSyncDone) {
      if (!state.syncInFlight && !state.activeSync) scheduleSync('popup-status-first');
      if (state.activeSync) {
        try {
          await state.activeSync;
        } catch {}
      }
    }
    const enabled = state.enabled;
    const gainDb = state.gainDb;

    if (enabled) {
      if (!state.injected && !state.syncInFlight) {
        scheduleSync('popup-status');
      }

      if (!state.hookAlive || (Date.now() - state.lastStatusAt) >= HOOK_FRESH_MS) {
        void ensureFreshPopupStatus();
      }
    }

    const isExcluded = state.excluded === true;
    const indicator = contentShared.getPopupIndicator({
      enabled,
      hookAlive: state.hookAlive,
      hookActive: state.hookActive,
      lastError: state.lastError,
    });

    return {
      ok: true,
      enabled,
      excluded: isExcluded,
      hostname: state.hostname,
      siteKey: state.siteKey,
      gainDb: state.gainDb,
      hookAlive: state.hookAlive,
      hookActive: state.hookActive,
      activating: isActivationPending(),
      lastError: enabled ? state.lastError : '',
      indicator,
    };
  }

  function ensureFreshPopupStatus() {
    if (state.popupProbe) {
      return state.popupProbe;
    }

    state.popupProbe = probePopup().finally(() => {
      state.popupProbe = null;
    });

    return state.popupProbe;
  }

  function postToPage(type, payload) {
    window.postMessage({ channel: CHANNEL, type, ...payload }, '*');
  }

  function setPendingStart() {
    document.documentElement?.setAttribute(PENDING_ATTR, '1');
  }

  function clearPendingStart() {
    document.documentElement?.removeAttribute(PENDING_ATTR);
  }
})();
