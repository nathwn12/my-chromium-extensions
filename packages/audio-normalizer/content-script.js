(() => {
  const HOOK_TIMEOUT_MS = 1000;
  const HOOK_FRESH_MS = 3000;
  const INJECT_TIMEOUT_MS = 5000;
  const ACTIVATE_RETRY_COUNT = 5;
  const ACTIVATE_RETRY_MS = 250;
  // The bootstrap read decides everything this frame will ever do, so it may
  // not be unbounded: two attempts, each raced against this budget.
  const BOOTSTRAP_READ_TIMEOUT_MS = 2000;
  const BOOTSTRAP_READ_ATTEMPTS = 2;
  const PENDING_ATTR = 'data-tab-normalizer-pending';

  const contentShared = globalThis.TabNormalizerShared;

  // A previous instance in this world, if any. Its reinject() is called only
  // AFTER the gate below has accepted this entry (finding: the old code called
  // it before any gate, so a re-injection could bypass exclusion).
  const existing = globalThis.__tabNormalizerContentScriptV5;

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

  // The frame gate the background ran in THIS world is authoritative: it was
  // computed from this frame's own hostname against a list read from storage
  // moments ago, and it also repopulated the cache (so a stale entry from a
  // previous teardown cannot outlive a re-injection).
  function frameGateExcluded() {
    const gate = globalThis.__tabNormalizerFrameGate;
    if (gate && typeof gate.excluded === 'boolean') return gate.excluded === true;
    return isExcludedByCache();
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
   *   excluded: boolean, seen: boolean,
   *   injected: boolean, hookAlive: boolean, hookPresent: boolean,
   *   hookActive: boolean, injecting: boolean, injectStartedAt: number,
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
    // The MAIN-world hook is in this frame (injected here, whether or not it is
    // processing). A seen host loads with it in place, which is what makes a
    // later enable live; `injected` below is this frame's own "we asked" flag.
    hookPresent: false,
    hookActive: false,
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

  // Every listener this frame owns, so teardown can release all of them (an
  // excluded frame must leave nothing behind that could do work).
  /** @type {Array<() => void>} */
  let listenerRemovers = [];

  // The one inert surface that outlives a teardown (rule 6): a single
  // `chrome.storage.onChanged` listener per frame.
  let storageSignalArmed = false;

  // ---------------------------------------------------------------------------
  // Arm gate (gate G3, narrowed for live toggling).
  //
  // Two facts decide it, both fixed at load:
  //  - `arrivedAtDocumentStart`: this instance was injected while the document
  //    was still parsing (`runAt: document_start`). An instance injected into a
  //    finished document may stop things but never start them.
  //  - `armDecision`: what the LOAD-TIME record said. 'allowed' means this
  //    document loaded with the page hook in place — either because the site was
  //    enabled, or because it has been enabled before (`seen`) and therefore
  //    loads the hook passively. 'denied' means neither, and no later message or
  //    storage change may change that for this document: the first-ever enable
  //    of a host is the one case that needs one navigation.
  //    'pending' only exists while the load-time read has not answered (a hung
  //    store); its bounded retry may still decide, because that is still the
  //    load-time question, not a state change.
  // ---------------------------------------------------------------------------
  const arrivedAtDocumentStart = (() => {
    try {
      return document.readyState === 'loading';
    } catch {
      return false;
    }
  })();
  /** @type {'pending'|'allowed'|'denied'} */
  let armDecision = arrivedAtDocumentStart ? 'pending' : 'denied';

  // THE GATE. It runs on every entry, before the re-injection hook is called
  // and before anything is created, so a re-injection can never bypass it.
  // Order of authority: the frame gate the background just ran in THIS world
  // (its own hostname, fresh list), then the cache the storage broadcast
  // maintains.
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
  // Rule 6: the ONE inert surface this frame keeps for its whole life, including
  // after a teardown. It is driven only by the extension's own storage records
  // and reacts to no page activity, and it exists because the worker's tab-level
  // teardown is selected by TOP-LEVEL host: an embedded frame on an excluded host
  // inside an allowed tab is never selected, so it must hear the record itself.
  registerStorageExclusionSignal();
  // FAIL CLOSED: nothing that works is installed until storage has answered, and
  // a read error installs nothing at all.
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
      // A read that never ANSWERS is not an answer: install nothing that runs,
      // but keep the one inert surface that lets the worker's soft re-check
      // retry the read, so a hung store cannot disable an enabled site
      // permanently and this state is reported instead of silently dead.
      if (outcome.timedOut) registerRuntimeMessageListener();
      return;
    }
    state.bootstrapError = '';
    const config = outcome.config;
    // The load-time decision, taken once. A later bootstrap (re-injection, a
    // retry after a hung read) may only resolve 'pending'; it can never turn a
    // document that loaded disabled into an armed one. A `seen` host counts as
    // armed because its document loads the passive hook — that is the whole
    // point of `seen`, and it is why a later enable needs no navigation.
    if (armDecision === 'pending') {
      armDecision = (config.enabled || config.seen) && !config.excluded ? 'allowed' : 'denied';
    }
    if (config.excluded) {
      state.excluded = true;
      rememberExclusion(state.siteKey, true);
      console.log('[cs] excluded, staying inactive');
      return;
    }
    if (!config.known) {
      // No record for this host (or any parent): unknown is inactive.
      console.log('[cs] no stored record for', state.siteKey, '- inactive');
      return;
    }
    state.seen = config.seen === true;
    if (!config.enabled) {
      // A host that has never been enabled does no work at all — no listener,
      // no timer, no observer, no hook. Enabling it for the first time applies
      // on the next navigation, so there is nothing to arm here.
      if (!state.seen) {
        rememberExclusion(state.siteKey, false);
        state.excluded = false;
        console.log('[cs] site off at load, staying idle');
        return;
      }
      // Seen-but-off: the document loads the page hook in reservation mode —
      // patched and idle, owning nothing — so a later enable starts in place.
      // Nothing is started and no audio graph is created while it is off.
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
      // (a) This frame's host (or an ancestor) is now excluded: run the dispose
      // path. `teardown` is idempotent, so a repeated write costs nothing.
      const excludedKey = excludedKeyForThisFrame(changes);
      if (excludedKey) {
        // Record the key that carries the verdict (it may be an ancestor) so the
        // synchronous gate refuses a re-entry, then run the dispose path.
        rememberExclusion(excludedKey, true);
        rememberExclusion(state.siteKey, true);
        state.excluded = true;
        state.transient = null;
        console.log('[cs] exclusion signal:', state.siteKey, 'via', excludedKey);
        teardown('excluded-storage');
        return;
      }
      // Rule 2/6: this listener may ONLY tear down. It never arms anything: the
      // live enable path is the runtime broadcast (`TOGGLE_CHANGED`), not a
      // storage write. Nothing is scheduled here, ever, so a torn-down or idle
      // frame pays no timer, no observer and no re-read.
    };
    chrome.storage.onChanged.addListener(onStorageChanged);
    // Deliberately NOT pushed into `listenerRemovers`: teardown releases
    // everything it owns EXCEPT this surface, which the contract keeps.
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
   * @returns {Promise<{ enabled: boolean, gainDb: number, excluded: boolean, known: boolean }>}
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

    const withExcluded = (rec, known) => ({
      enabled: ancestorExcluded ? false : rec.enabled,
      gainDb: rec.gainDb,
      excluded: ancestorExcluded || rec.excluded,
      // `known` = storage actually holds a record for this host (or a parent).
      // A host with no record at all is unknown, and unknown is inactive.
      known: Boolean(known) || ancestorExcluded,
      // An excluded frame is not seen: no hook, no registration, nothing.
      seen: ancestorExcluded ? false : Boolean(rec.seen) || Boolean(rec.enabled),
    });

    const perValue = perKey ? stored[perKey] : undefined;
    if (perValue && typeof perValue === 'object') {
      const rec = contentShared.normalizeSiteRecord(perValue);
      rememberExclusion(state.siteKey, rec.excluded);
      return withExcluded(rec, true);
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
        return withExcluded(rec, true);
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
   * @returns {Promise<{ ok: true, config: { enabled: boolean, gainDb: number, excluded: boolean, known: boolean }, error: '', timedOut: boolean }
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
    // A re-injection is the background's decision (it refuses excluded frames
    // and rewrites the frame gate first), so re-arm rather than trust a
    // possibly stale cache: drop the detached state and re-decide from storage.
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
   * May this document start work at all? Only a document that LOADED with a
   * hook decision — enabled, or seen and therefore loading the hook passively —
   * may. The first-ever enable of a host lands on a document with neither, and
   * that one case still needs a navigation. Everything else in this file stays
   * available for teardown and status.
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
      // The read above may have resolved after a teardown: never install a
      // transient override or schedule work on a detached frame.
      if (state.detached || state.excluded) return { ok: false, error: 'frame inactive' };
      enabled = hasEnabled ? Boolean(message.enabled) : base.enabled;
      gainDb = hasGain ? contentShared.clampGainDb(message.gainDb) : base.gainDb;
    }
    state.transient = { enabled, gainDb };
    state.enabled = enabled;
    state.gainDb = gainDb;

    console.log('[cs] document-state (transient):', state.siteKey, 'enabled:', enabled, 'gainDb:', gainDb);

    const hookAlive = await evaluateHookHealth();
    if (state.detached || state.excluded) return { ok: false, error: 'frame inactive' };
    const action = contentShared.getContentAction({
      enabled,
      injected: state.injected,
      hookAlive,
      seen: state.seen,
    });

    // Seen-but-off on the document-state path: keep the hook loaded and idle so
    // the next enable is live.
    if (action === 'reserve') {
      clearPendingStart();
      clearActivationRetry();
      stopSpaWatch();
      inject();
      return { ok: true, reserved: true };
    }

    // A message may stop or adjust an armed document; it arms one only when
    // this document already carries a hook (enabled at load, or seen). See
    // `mayStartWork`.
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
      // Bypass, not teardown: the hook stays loaded for a later live enable.
      postToPage('STOP', { reason: 'document-state' });
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

  function cleanupAndReset() {
    clearPendingStart();
    clearActivationRetry();
    stopSpaWatch();
    // STOP bypasses and keeps the hook loaded (dispatcher, sessions, captured
    // sources), so a later enable in this document is live. Only exclusion or
    // uninstall destroy it.
    postToPage('STOP', { reason: 'toggle-changed' });
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
    rememberExclusion(state.siteKey, true);
    console.log('[cs] torn down (excluded):', state.siteKey, reason);
  }

  async function handleSoftRecheckDocument() {
    if (!state.bootstrapped) {
      // The bounded bootstrap read never produced an answer: retry the read
      // rather than trust a state that was never resolved.
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
      // The read may have resolved after a teardown (live exclusion, popup
      // close): a detached frame must not schedule anything on a stale answer.
      if (state.detached) return;
      if (!config.known && !state.transient) {
        // Unknown host: inactive, and it arms nothing.
        state.enabled = false;
        state.hookAlive = false;
        state.hookActive = false;
        clearActivationRetry();
        stopSpaWatch();
        return;
      }
      // Exclusion outranks the transient session override AND stored
      // enablement: nothing runs on an excluded site, on any path.
      state.excluded = config.excluded === true;
      state.seen = config.seen === true;
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
      if (enabled) state.stopSent = false;

      console.log('[cs] sync:', state.siteKey, 'enabled:', enabled, 'gainDb:', gainDb, 'injected:', state.injected, 'hookAlive:', state.hookAlive, 'reason:', reason);

      const hookAlive = enabled ? await evaluateHookHealth() : state.hookAlive;
      // The probe awaited above can outlive a teardown: re-check before any
      // activation, page message or SPA timer is scheduled.
      if (state.detached) return;
      const action = contentShared.getContentAction({
        enabled,
        injected: state.injected,
        hookAlive,
        seen: state.seen,
      });

      // Seen-but-off: load the page hook in reservation mode — patched, idle,
      // owning nothing, creating no audio graph — so a later enable starts in
      // place. This is the one action that loads a hook without starting it.
      if (action === 'reserve') {
        clearPendingStart();
        clearActivationRetry();
        stopSpaWatch();
        state.hookActive = false;
        state.lastError = '';
        inject();
        return;
      }

      // The arm gate: a document that loaded with neither an enable nor a
      // passive hook is never armed by a live message. Enabling it for the
      // first time is the one residual navigation.
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
        // STOP is a bypass, not a teardown: the hook keeps its dispatcher,
        // sessions and captured sources so the next enable is live. The
        // response confirms the hook is still alive; `hookAlive` is left to
        // applyHookStatus instead of being cleared here.
        postToPage('STOP', { reason });
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
          state.hookPresent = false;
          state.lastError = 'Failed to inject page hook.';
          return;
        }
        state.hookPresent = true;
        console.log('[cs] page-hook.js injected via background');
        // Only a document that loaded ARMED starts here. A seen-but-off frame
        // loads the hook and stops; its START comes later, live.
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
        state.hookPresent = false;
        state.lastError = 'Failed to inject page hook.';
        console.error('[cs] page-hook injection failed:', error);
      });
  }

  // -------------------------------------------------------------------------
  // Control flow: extension -> page ONLY.
  //
  // This frame never posts to the page and never listens on `window`. It asks
  // the worker, and the worker calls the MAIN-world dispatcher through
  // chrome.scripting.executeScript with a per-tab token the page cannot read.
  // A page posting START/SET_GAIN/STATUS_REQUEST reaches nothing.
  // -------------------------------------------------------------------------
  const CONTROL_ACTIONS = { START: 'start', STOP: 'stop', SET_GAIN: 'setGain' };

  function postToPage(type, payload) {
    const action = CONTROL_ACTIONS[type];
    if (!action) return Promise.resolve(null);
    return sendHookControl(action, payload);
  }

  async function sendHookControl(action, payload) {
    // A torn-down or excluded frame may ask for a STOP and nothing else: the
    // dispose path must be able to make the worker deliver the teardown this
    // frame can no longer perform itself, and a STOP can never start work.
    // Every other action is refused on such a frame.
    if ((state.detached || state.excluded) && action !== 'stop') return null;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'CONTROL_HOOK',
        action,
        payload: payload || {},
      });
      applyHookStatus(response);
      return response || null;
    } catch {
      return null;
    }
  }

  function applyHookStatus(response) {
    if (!response || typeof response !== 'object') return;
    if (response.alive === true) {
      state.injected = true;
      state.hookAlive = true;
      state.hookActive = Boolean(response.active);
      state.lastError = state.enabled ? String(response.error || '') : '';
      state.lastStatusAt = Date.now();
      if (response.active && !state.enabled && !state.stopSent) {
        // The worker only starts a hook for enabled sites; an active hook on a
        // disabled one is stale, so ask for the stop the worker can deliver.
        // One shot: a hook that keeps reporting active must not spin here.
        state.stopSent = true;
        void postToPage('STOP', { reason: 'disabled-active-backstop' });
      }
      return;
    }
    if (response.ok === false) {
      const wasAlive = state.hookAlive;
      state.hookAlive = false;
      state.hookActive = false;
      state.lastError = state.enabled ? String(response.error || '') : '';
      // The worker says the hook is installed but not answering. Arm the
      // bounded re-sync ONLY on the alive -> dead transition: a retry that is
      // answered "still dead" must not re-arm it, or the capped chain would
      // restart itself on every answer (a busy loop).
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
    // Exclusion outranks everything; a transient session override outranks
    // stored settings for the live document until cleared.
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
    // In-memory answer: the 750 ms popup poll must not re-read storage. Hook
    // health comes from the worker's control responses, not from a page
    // channel (there is none).
    if (!state.initialSyncDone) {
      // A frame that never bootstrapped has no truth to sync with: answer from
      // memory instead of starting a read that may never settle.
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

    const indicator = contentShared.getPopupIndicator({
      enabled,
      hookAlive: state.hookAlive,
      hookActive: state.hookActive,
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
      // Whether this document carries the page hook at all: the popup's one
      // honest signal for "this tab can apply the enable without a reload".
      hookPresent: state.hookPresent,
      activating: isActivationPending(),
      lastError: enabled ? state.lastError : '',
      // Why this frame is inert when it never got an answer: the bounded
      // bootstrap read failed, and a soft re-check retries it.
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
