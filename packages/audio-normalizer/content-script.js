(() => {
  const HOOK_TIMEOUT_MS = 1000;
  const HOOK_FRESH_MS = 3000;
  const INJECT_TIMEOUT_MS = 5000;
  const ACTIVATE_RETRY_COUNT = 5;
  const ACTIVATE_RETRY_MS = 250;
  const BOOTSTRAP_READ_TIMEOUT_MS = 2000;
  const BOOTSTRAP_READ_ATTEMPTS = 2;
  const PENDING_ATTR = 'data-tab-normalizer-pending';

  const contentShared = globalThis.TabNormalizerShared;

  const existing = globalThis.__tabNormalizerContentScriptV5;

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

  function frameGateExcluded() {
    const gate = globalThis.__tabNormalizerFrameGate;
    if (gate && typeof gate.excluded === 'boolean') return gate.excluded === true;
    return isExcludedByCache();
  }

  if (isExcludedByCache()) {
    console.log('[cs] host excluded by registration cache, gated:', currentHost());
    return;
  }

  /** @type {{
   *   hostname: string, siteKey: string, enabled: boolean, gainDb: number,
   *   excluded: boolean, seen: boolean,
   *   injected: boolean, hookAlive: boolean, hookPresent: boolean,
   *   hookActive: boolean, hookProcessing: boolean, unprocessed: number, injecting: boolean, injectStartedAt: number,
   *   lastError: string, lastStatusAt: number,
   *   transient: ({ enabled: boolean, gainDb: number } | null),
   *   syncInFlight: boolean, queuedSyncReason: string,
   *   activeSync: (Promise<void> | null), initialSyncDone: boolean,
   *   bootstrapped: boolean, activationRetryTimer: (number | null),
   *   activationRetryCount: number, spaWatchTimer: (number | null),
   *   detached: boolean, stopSent: boolean,
   *   runtimeListenerArmed: boolean, bootstrapError: string
   * }} */
  const state = {
    hostname: '',
    siteKey: '',
    enabled: false,
    gainDb: contentShared.DEFAULT_GAIN_DB,
    excluded: false,
    seen: false,
    injected: false,
    hookAlive: false,
    hookPresent: false,
    unprocessed: 0,
    hookActive: false,
    hookProcessing: false,
    injecting: false,
    injectStartedAt: 0,
    lastError: '',
    lastStatusAt: 0,
    transient: null,
    syncInFlight: false,
    queuedSyncReason: '',
    activeSync: null,
    initialSyncDone: false,
    bootstrapped: false,
    activationRetryTimer: null,
    activationRetryCount: 0,
    spaWatchTimer: null,
    detached: false,
    stopSent: false,
    runtimeListenerArmed: false,
    bootstrapError: '',
  };

  /** @type {Array<() => void>} */
  let listenerRemovers = [];

  let storageSignalArmed = false;

  const arrivedAtDocumentStart = (() => {
    try {
      return document.readyState === 'loading';
    } catch {
      return false;
    }
  })();
  /** @type {'pending'|'allowed'|'denied'} */
  let armDecision = arrivedAtDocumentStart ? 'pending' : 'denied';

  if (frameGateExcluded()) {
    console.log('[cs] host gated before any listener:', currentHost());
    return;
  }

  if (existing?.reinject) {
    existing.reinject();
    return;
  }

  globalThis.__tabNormalizerContentScriptV5 = {
    reinject: handleReinject,
  };
  registerStorageExclusionSignal();
  void bootstrap('init');

  /**
   * Resolve this frame's stored truth, then install. No listener, observer or
   * timer exists before the answer arrives; an excluded host, an unreadable
   * store and a host with no stored record at all all stay inactive.
   * @param {string} reason
   */
  async function bootstrap(reason) {
    refreshLocationState();
    console.log('[cs] bootstrapping on:', state.hostname, location.href);
    if (!state.siteKey) {
      console.log('[cs] no hostname, skipping');
      return;
    }
    const outcome = await readStoredConfigBounded();
    if (!outcome.ok) {
      state.bootstrapError = outcome.error;
      console.log('[cs] storage read unusable, staying inactive:', outcome.error);
      if (outcome.timedOut) registerRuntimeMessageListener();
      return;
    }
    state.bootstrapError = '';
    const config = outcome.config;
    if (armDecision === 'pending') {
      armDecision = (config.enabled || config.seen) && !config.excluded ? 'allowed' : 'denied';
    } else if (armDecision === 'denied' && !arrivedAtDocumentStart) {
      // Explicit late injection into an already-playing document. Only a
      // currently enabled, non-excluded host may arm; a disabled host stays
      // passive so other tabs and frames are never armed unintentionally.
      armDecision = config.enabled && !config.excluded ? 'allowed' : 'denied';
    }
    if (config.excluded) {
      state.excluded = true;
      rememberExclusion(state.siteKey, true);
      console.log('[cs] excluded, staying inactive');
      return;
    }
    if (!config.known) {
      console.log('[cs] no stored record for', state.siteKey, '- inactive');
      return;
    }
    state.seen = config.seen === true;
    if (!config.enabled) {
      if (!state.seen) {
        rememberExclusion(state.siteKey, false);
        state.excluded = false;
        console.log('[cs] site off at load, staying idle');
        return;
      }
      rememberExclusion(state.siteKey, false);
      state.excluded = false;
      if (!ensureBootstrapListeners()) return;
      state.initialSyncDone = false;
      scheduleSync(reason);
      return;
    }
    rememberExclusion(state.siteKey, false);
    state.excluded = false;
    if (!ensureBootstrapListeners()) return;
    state.initialSyncDone = false;
    scheduleSync(reason);
  }

  function refreshLocationState() {
    state.hostname = contentShared.extractHostname(location.href);
    state.siteKey = contentShared.getSiteKey(state.hostname);
  }

  /**
   * The extension-message listener, registered from two places: the ordinary
   * armed frame, and the timeout recovery surface of a frame whose storage read
   * never answered. Idempotent, and released with every other listener.
   */
  function registerRuntimeMessageListener() {
    if (state.runtimeListenerArmed || state.detached) return;
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
        const intendedToggleSite = typeof message.siteKey === 'string'
          ? contentShared.getSiteKey(message.siteKey)
          : '';
        if (!intendedToggleSite || intendedToggleSite !== state.siteKey) {
          sendResponse({ ok: false, error: 'site mismatch' });
          return true;
        }
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
    state.runtimeListenerArmed = true;
  }

  /**
   * Rule 6: the per-frame exclusion signal.
   *
   * Exactly ONE `chrome.storage.onChanged` listener exists in this frame, and it
   * is registered before the bootstrap read (so it survives a hung or failed
   * read) and kept through teardown (so a torn-down frame still owns the one
   * inert surface the contract allows). It never reacts to page activity.
   *
   * An exclusion write for this host, or any ancestor of it, runs the SAME
   * dispose path the explicit `TOGGLE_CHANGED excluded` teardown runs. That is
   * what reaches an embedded frame on an excluded host inside an allowed tab:
   * the worker's tab selection is by top-level host and skips the tab entirely.
   */
  function registerStorageExclusionSignal() {
    if (storageSignalArmed) return;
    if (!state.siteKey) refreshLocationState();
    storageSignalArmed = true;
    const onStorageChanged = (changes, area) => {
      if (area !== 'local') return;
      const excludedKey = excludedKeyForThisFrame(changes);
      if (excludedKey) {
        rememberExclusion(excludedKey, true);
        rememberExclusion(state.siteKey, true);
        state.excluded = true;
        state.transient = null;
        console.log('[cs] exclusion signal:', state.siteKey, 'via', excludedKey);
        teardown('excluded-storage');
        return;
      }
    };
    chrome.storage.onChanged.addListener(onStorageChanged);
  }

  /**
   * Which excluded key, if any, does this change set say governs THIS frame's
   * host? The record's key covers its subdomains, so an exclusion of
   * `example.com` governs `a.example.com` too. Returns '' when nothing here
   * excludes this frame.
   * @param {Record<string, { oldValue?: unknown, newValue?: unknown }>} changes
   * @returns {string}
   */
  function excludedKeyForThisFrame(changes) {
    if (!state.siteKey) return '';
    for (const [key, change] of Object.entries(changes || {})) {
      if (!contentShared.isSiteStorageKey(key)) continue;
      const value = change && change.newValue;
      if (!value || typeof value !== 'object') continue;
      if (/** @type {{ excluded?: unknown }} */ (value).excluded !== true) continue;
      const excludedKey = contentShared.siteKeyFromStorageKey(key);
      if (!excludedKey) continue;
      if (contentShared.hostMatchesSiteKey(state.siteKey, excludedKey)) return excludedKey;
    }
    return '';
  }

  /**
   * @returns {boolean} true when the listener set is armed for this frame
   */
  function ensureBootstrapListeners() {
    if (state.bootstrapped || !state.siteKey || state.detached) return state.bootstrapped;

    registerRuntimeMessageListener();

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
    return true;
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
   * @returns {Promise<{ enabled: boolean, gainDb: number, excluded: boolean, known: boolean, seen: boolean }>}
   */
  async function readStoredConfig() {
    const perKey = contentShared.siteStorageKey(state.siteKey);
    const ancestorKeys = contentShared.ancestorSiteKeys(state.siteKey)
      .map((key) => contentShared.siteStorageKey(key))
      .filter(Boolean);
    /** @type {string[]} */
    const keys = ['activeSites', 'siteSettings', 'siteToggles'];
    if (perKey) keys.push(perKey);
    for (const key of ancestorKeys) {
      if (key !== perKey) keys.push(key);
    }
    const stored = await chrome.storage.local.get(keys);

    const ancestorExcluded = ancestorKeys.some((key) => {
      const value = stored[key];
      return Boolean(value && typeof value === 'object' && 'excluded' in value && value.excluded);
    });
    if (ancestorExcluded) {
      rememberExclusion(state.siteKey, true);
    }

    const withExcluded = (rec, known) => ({
      enabled: ancestorExcluded ? false : rec.enabled,
      gainDb: rec.gainDb,
      excluded: ancestorExcluded || rec.excluded,
      known: Boolean(known) || ancestorExcluded,
      seen: ancestorExcluded ? false : Boolean(rec.seen) || Boolean(rec.enabled),
    });

    const perValue = perKey ? stored[perKey] : undefined;
    if (perValue && typeof perValue === 'object') {
      const rec = contentShared.normalizeSiteRecord(perValue);
      rememberExclusion(state.siteKey, rec.excluded);
      return withExcluded(rec, true);
    }
    const legacyPerKey = contentShared.legacySiteStorageKey(state.siteKey);
    if (legacyPerKey && legacyPerKey !== perKey) {
      let legacyValue = stored[legacyPerKey];
      if (legacyValue === undefined) {
        const legacyStored = await chrome.storage.local.get([legacyPerKey]);
        legacyValue = legacyStored[legacyPerKey];
      }
      if (legacyValue && typeof legacyValue === 'object') {
        const rec = contentShared.normalizeSiteRecord(legacyValue);
        rememberExclusion(state.siteKey, rec.excluded);
        return withExcluded(rec, true);
      }
    }
    const migrated = contentShared.migrateLegacyToRecord(
      stored.siteSettings, stored.activeSites, stored.siteToggles, state.siteKey,
    );
    if (migrated) {
      return withExcluded(migrated, true);
    }
    const config = contentShared.getSiteConfig(stored.siteSettings, stored.activeSites, state.siteKey);
    return withExcluded({ enabled: config.enabled, gainDb: config.gainDb, excluded: false }, false);
  }

  class StorageReadTimeout extends Error {
    constructor() {
      super('Storage read timed out.');
    }
  }

  /**
   * Race one storage read against a budget. Resolves with the config; rejects
   * with {@link StorageReadTimeout} when the platform never answers, or with
   * the platform error. The timer is always cleared, so a slow-but-successful
   * read leaves no timer behind.
   * @param {number} ms
   */
  function withReadTimeout(ms) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new StorageReadTimeout());
      }, ms);
      readStoredConfig().then(
        (config) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(config);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /**
   * The bootstrap read, bounded: one retry, each attempt under a timeout.
   *
   * Without this, a `chrome.storage.local.get` that never settles disabled the
   * frame forever — nothing was installed, no timer was running, and no
   * listener existed to retry with, so only a reload could recover it.
   * @returns {Promise<{ ok: true, config: { enabled: boolean, gainDb: number, excluded: boolean, known: boolean, seen: boolean }, error: '', timedOut: boolean }
   *   | { ok: false, config: null, error: string, timedOut: boolean }>}
   */
  async function readStoredConfigBounded() {
    let timedOut = false;
    let message = '';
    for (let attempt = 0; attempt < BOOTSTRAP_READ_ATTEMPTS; attempt += 1) {
      try {
        const config = await withReadTimeout(BOOTSTRAP_READ_TIMEOUT_MS);
        return { ok: true, config, error: '', timedOut: false };
      } catch (error) {
        if (error instanceof StorageReadTimeout) {
          timedOut = true;
          message = 'Storage read timed out.';
        } else {
          message = `Storage read failed: ${String((error && error.message) || error)}`;
        }
      }
    }
    return { ok: false, config: null, error: message, timedOut };
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
    // Drop replies still in flight from the previous instance before the new
    // session issues its own requests.
    appliedStatusSeq = statusSeq;
    if (state.detached) {
      state.detached = false;
      state.bootstrapped = false;
      state.initialSyncDone = false;
    }
    void bootstrap('reinject');
  }

  function isActivationPending() {
    return state.enabled && (state.injecting || state.syncInFlight || Boolean(state.activeSync));
  }

  /**
   * May this document start work at all? A document that loaded with a hook
   * decision may, and an explicit late injection into an enabled document may
   * too (bootstrap grants it). Teardown and status work in every case.
   */
  function mayStartWork() {
    return armDecision === 'allowed' && !state.detached && !state.excluded;
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
    postToPage('START', { reason, gainDb: state.gainDb, workletUrl: getWorkletUrl() });
  }

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
    const intendedSite = typeof message?.siteKey === 'string'
      ? contentShared.getSiteKey(message.siteKey)
      : '';
    if (!intendedSite || intendedSite !== state.siteKey) {
      return { ok: false, error: 'site mismatch' };
    }
    if (state.excluded) {
      teardown('excluded-document-state');
      return { ok: true, excluded: true };
    }
    const isTransient = message.transient === true || message.persist === false;
    if (!isTransient) {
      state.transient = null;
      await sync('document-state');
      return { ok: true };
    }
    let enabled;
    let gainDb;
    const hasEnabled = Object.prototype.hasOwnProperty.call(message, 'enabled');
    const hasGain = Object.prototype.hasOwnProperty.call(message, 'gainDb');
    if (hasEnabled && hasGain) {
      enabled = Boolean(message.enabled);
      gainDb = contentShared.clampGainDb(message.gainDb);
    } else {
      const base = await readStoredConfig();
      if (state.detached || state.excluded) return { ok: false, error: 'frame inactive' };
      enabled = hasEnabled ? Boolean(message.enabled) : base.enabled;
      gainDb = hasGain ? contentShared.clampGainDb(message.gainDb) : base.gainDb;
    }
    state.transient = { enabled, gainDb };
    state.enabled = enabled;
    state.gainDb = gainDb;
    if (enabled) state.stopSent = false;

    console.log('[cs] document-state (transient):', state.siteKey, 'enabled:', enabled, 'gainDb:', gainDb);

    const hookAlive = await evaluateHookHealth();
    if (state.detached || state.excluded) return { ok: false, error: 'frame inactive' };
    const action = contentShared.getContentAction({
      enabled,
      injected: state.injected,
      hookAlive,
      seen: state.seen,
    });

    if (action === 'reserve') {
      clearPendingStart();
      clearActivationRetry();
      stopSpaWatch();
      inject();
      return { ok: true, reserved: true };
    }

    if ((action === 'inject' || action === 'start') && !mayStartWork()) {
      clearPendingStart();
      clearActivationRetry();
      stopSpaWatch();
      return { ok: true, deferred: 'navigation' };
    }

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
      postStopOnce('document-state');
      state.hookActive = false;
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

  /**
   * Deliver one STOP per enabled→disabled transition. Off sites are resynced on
   * focus/visibility/pageshow like any other document; without this the worker
   * would run a MAIN-world stop for an already-bypassed hook on every focus.
   * @param {string} reason
   */
  function postStopOnce(reason) {
    if (state.stopSent) return;
    state.stopSent = true;
    postToPage('STOP', { reason });
  }

  function cleanupAndReset() {
    clearPendingStart();
    clearActivationRetry();
    stopSpaWatch();
    postStopOnce('toggle-changed');
    state.hookActive = false;
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
    state.runtimeListenerArmed = false;
    // Invalidate replies from this session, including the STOP just posted:
    // none may reassert state on a torn-down frame.
    appliedStatusSeq = statusSeq;
    rememberExclusion(state.siteKey, true);
    console.log('[cs] torn down (excluded):', state.siteKey, reason);
  }

  async function handleSoftRecheckDocument() {
    if (!state.bootstrapped) {
      await bootstrap('soft-recheck');
      return getDocumentStatus();
    }
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
      const config = await readStoredConfig();
      if (state.detached) return;
      if (!config.known && !state.transient) {
        state.enabled = false;
        state.hookAlive = false;
        state.hookActive = false;
        clearActivationRetry();
        stopSpaWatch();
        return;
      }
      state.excluded = config.excluded === true;
      state.seen = config.seen === true;
      const enabled = config.excluded
        ? false
        : (state.transient ? state.transient.enabled : config.enabled);
      const gainDb = config.excluded
        ? contentShared.DEFAULT_GAIN_DB
        : (state.transient ? state.transient.gainDb : config.gainDb);

      if (config.excluded) {
        state.enabled = false;
        state.gainDb = gainDb;
        teardown('excluded-sync');
        return;
      }

      state.enabled = enabled;
      state.gainDb = gainDb;
      if (enabled) state.stopSent = false;

      console.log('[cs] sync:', state.siteKey, 'enabled:', enabled, 'gainDb:', gainDb, 'injected:', state.injected, 'hookAlive:', state.hookAlive, 'reason:', reason);

      const hookAlive = enabled ? await evaluateHookHealth() : state.hookAlive;
      if (state.detached) return;
      const action = contentShared.getContentAction({
        enabled,
        injected: state.injected,
        hookAlive,
        seen: state.seen,
      });

      if (action === 'reserve') {
        clearPendingStart();
        clearActivationRetry();
        stopSpaWatch();
        state.hookActive = false;
        state.lastError = '';
        inject();
        return;
      }

      if ((action === 'inject' || action === 'start') && !mayStartWork()) {
        console.log('[cs] enable deferred to the next navigation:', state.siteKey);
        clearPendingStart();
        clearActivationRetry();
        stopSpaWatch();
        state.hookActive = false;
        state.lastError = '';
        return;
      }

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
        postStopOnce(reason);
        state.hookActive = false;
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
          state.hookPresent = false;
          state.lastError = 'Failed to inject page hook.';
          return;
        }
        state.hookPresent = true;
        console.log('[cs] page-hook.js injected via background');
        if (state.enabled) {
          postToPage('START', { reason: 'inject-onload', gainDb: state.gainDb, workletUrl: getWorkletUrl() });
          postToPage('SET_GAIN', { gainDb: state.gainDb });
          scheduleActivationRetry('inject-onload');
        }
      })
      .catch((error) => {
        state.injecting = false;
        state.hookPresent = false;
        state.lastError = 'Failed to inject page hook.';
        console.error('[cs] page-hook injection failed:', error);
      });
  }

  const CONTROL_ACTIONS = { START: 'start', STOP: 'stop', SET_GAIN: 'setGain' };

  // Concurrent CONTROL_HOOK requests can resolve out of order: a delayed reply
  // for an older request must not reapply over a newer confirmed receipt.
  // Each request carries a monotonic seq; the receiving boundary drops any
  // reply older than the newest already applied one.
  let statusSeq = 0;
  let appliedStatusSeq = 0;

  function postToPage(type, payload) {
    const action = CONTROL_ACTIONS[type];
    if (!action) return Promise.resolve(null);
    return sendHookControl(action, payload);
  }

  async function sendHookControl(action, payload) {
    if ((state.detached || state.excluded) && action !== 'stop') return null;
    const seq = ++statusSeq;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'CONTROL_HOOK',
        action,
        payload: payload || {},
      });
      applyHookStatus(response, seq);
      return response || null;
    } catch {
      return null;
    }
  }

  function applyHookStatus(response, seq) {
    if (!response || typeof response !== 'object') return;
    if (typeof seq === 'number') {
      if (seq < appliedStatusSeq) return;
      appliedStatusSeq = seq;
    }
    if (response.alive === true) {
      state.injected = true;
      state.hookAlive = true;
      state.hookActive = Boolean(response.active);
      state.hookProcessing = Boolean(response.processing);
      state.unprocessed = Number(response.unprocessed) || 0;
      state.lastError = state.enabled ? String(response.error || '') : '';
      state.lastStatusAt = Date.now();
      if (response.active && !state.enabled && !state.stopSent) {
        state.stopSent = true;
        void postToPage('STOP', { reason: 'disabled-active-backstop' });
      }
      return;
    }
    if (response.ok === false) {
      const wasAlive = state.hookAlive;
      state.hookAlive = false;
      state.hookActive = false;
      state.hookProcessing = false;
      state.lastError = state.enabled ? String(response.error || '') : '';
      if (wasAlive) scheduleLivenessResync('hook-not-alive');
    }
  }

  async function evaluateHookHealth() {
    if (state.excluded || state.detached) return false;
    if (!state.injected) return false;
    if (state.hookAlive && (Date.now() - state.lastStatusAt) < HOOK_FRESH_MS) return true;
    const response = await sendHookControl('status');
    return Boolean(response && response.alive);
  }

  function ensureFreshPopupStatus() {
    if (!state.enabled || state.detached) return Promise.resolve(false);
    if (state.hookAlive && (Date.now() - state.lastStatusAt) < HOOK_FRESH_MS) {
      return Promise.resolve(true);
    }
    return sendHookControl('status').then((response) => Boolean(response && response.alive));
  }

  async function getEffectiveDocumentState() {
    if (state.excluded) {
      state.enabled = false;
      return { enabled: false, gainDb: state.gainDb, excluded: true };
    }
    if (state.transient) {
      state.enabled = state.transient.enabled;
      state.gainDb = state.transient.gainDb;
      return { ...state.transient };
    }
    const config = await readStoredConfig();
    state.excluded = config.excluded === true;
    state.seen = config.seen === true;
    const enabled = config.excluded ? false : config.enabled;
    state.enabled = enabled;
    state.gainDb = config.gainDb;
    return { enabled, gainDb: config.gainDb };
  }

  async function getDocumentStatus() {
    if (!state.initialSyncDone) {
      if (state.bootstrapped && !state.syncInFlight && !state.activeSync) scheduleSync('popup-status-first');
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

    // `hookActive` means armed (worklet routed). Only a processing receipt may
    // paint the popup Active; an empty page or a page-owned source has none.
    const processing = state.hookActive && state.hookProcessing === true;
    const indicator = contentShared.getPopupIndicator({
      enabled,
      hookAlive: state.hookAlive,
      hookActive: processing,
      lastError: state.lastError,
    });

    return {
      ok: true,
      enabled,
      excluded: state.excluded === true,
      seen: state.seen === true,
      hostname: state.hostname,
      siteKey: state.siteKey,
      gainDb: state.gainDb,
      hookAlive: state.hookAlive,
      hookActive: state.hookActive,
      processing,
      hookPresent: state.hookPresent,
      unprocessed: state.unprocessed,
      activating: isActivationPending(),
      lastError: enabled ? state.lastError : '',
      bootstrapError: state.bootstrapError,
      indicator,
    };
  }


  function setPendingStart() {
    document.documentElement?.setAttribute(PENDING_ATTR, '1');
  }

  function clearPendingStart() {
    document.documentElement?.removeAttribute(PENDING_ATTR);
  }
})();
