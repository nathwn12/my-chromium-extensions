(() => {
  // A page-defined `window.__tabNormalizerHookV5` never blocks the real
  // hook: always install/overwrite below. Early-return ONLY when our own
  // connect patch is already present (a real hook is installed).
  if (typeof AudioNode !== 'undefined' && AudioNode.prototype
    && /** @type {any} */ (AudioNode.prototype).__tnConnect) {
    return;
  }

  const WORKLET_ATTR = 'data-tn-worklet-url';
  const WORKLET_SUFFIX = '/audio/normalizer-worklet.js';
  const RECOVERY_BURST_MS = 250;
  const RECOVERY_BURST_COUNT = 6;
  const HOOK_GUARD_TIMEOUT_MS = 1500;
  const RESUME_TIMEOUT_MS = 400;
  // Live-tap limits: how many elements one document routes at once, how long a
  // captured stream may take to produce its audio track, how long the tap is
  // measured before the element is muted, and the floor between full-document
  // scans (a recovery pass must not re-walk a feed every 250 ms).
  const MAX_ROUTED_MEDIA = 4;
  const STREAM_TRACK_WAIT_MS = 800;
  const STREAM_PROBE_MS = 600;
  const MEDIA_SCAN_MIN_INTERVAL_MS = 5000;
  // -------------------------------------------------------------------------
  // Tracked teardown collection.
  //
  // Every listener and timer this hook owns is registered through these four
  // helpers, so STOP releases them from ONE place instead of relying on each
  // subsystem remembering to clean up. The `message` listener is the single
  // deliberate survivor: it is the hook's only channel for a later START, and
  // removing it would make re-enabling a page impossible without a reload.
  // -------------------------------------------------------------------------
  /** @type {Array<{ target: any, type: string, fn: any, options: any, keepOnStop?: boolean }>} */
  let trackedListeners = [];
  /** @type {Set<any>} */
  const trackedTimers = new Set();

  function trackListener(target, type, fn, options, keepOnStop) {
    if (!target || typeof target.addEventListener !== 'function') return false;
    try {
      target.addEventListener(type, fn, options);
    } catch {
      return false;
    }
    trackedListeners.push({ target, type, fn, options, keepOnStop: keepOnStop === true });
    return true;
  }

  /** @param {((entry: { target: any, type: string, fn: any, options: any, keepOnStop?: boolean }) => boolean) | undefined} [keep] */
  function untrackListeners(keep) {
    const survivors = [];
    for (const entry of trackedListeners) {
      if (keep && keep(entry)) {
        survivors.push(entry);
        continue;
      }
      try {
        entry.target.removeEventListener(entry.type, entry.fn, entry.options);
      } catch {}
    }
    trackedListeners = survivors;
  }

  function trackTimeout(fn, ms) {
    let id = null;
    id = setTimeout(() => {
      trackedTimers.delete(id);
      try {
        fn();
      } catch {}
    }, ms);
    trackedTimers.add(id);
    return id;
  }

  function untrackTimeout(id) {
    if (id === null || id === undefined) return;
    trackedTimers.delete(id);
    try {
      clearTimeout(id);
    } catch {}
  }

  function untrackListener(target, type, fn, options) {
    untrackListeners((entry) => !(entry.target === target
      && entry.type === type && entry.fn === fn && entry.options === options));
    trackedElementListeners = trackedElementListeners.filter((entry) => {
      if (entry.el !== target || entry.type !== type || entry.fn !== fn) return true;
      try {
        entry.el.removeEventListener(entry.type, entry.fn);
      } catch {}
      return false;
    });
  }

  function untrackAllTimers() {
    for (const id of Array.from(trackedTimers)) {
      try {
        clearTimeout(id);
      } catch {}
    }
    trackedTimers.clear();
  }

  /**
   * Per-element listeners, tracked for the same reason: STOP detaches every
   * one of them and clears the `__tnProgramWatched` latch so a later START
   * re-arms the element instead of finding a stale guard.
   * @type {Array<{ el: any, type: string, fn: any }>}
   */
  let trackedElementListeners = [];

  function trackElementListener(el, type, fn) {
    if (!el || typeof el.addEventListener !== 'function') return;
    try {
      el.addEventListener(type, fn);
    } catch {
      return;
    }
    trackedElementListeners.push({ el, type, fn });
  }

  function teardownElementListeners() {
    for (const entry of trackedElementListeners) {
      try {
        entry.el.removeEventListener(entry.type, entry.fn);
      } catch {}
      try {
        entry.el.__tnProgramWatched = false;
      } catch {}
    }
    trackedElementListeners = [];
  }

  /**
   * Race context.resume() against a short timer so an autoplay-blocked
   * context never wedges session creation or media attach. Resolves on
   * timeout, never rejects.
   * @param {any} context
   * @param {number} [ms]
   * @returns {Promise<void>}
   */
  function resumeWithTimeout(context, ms = RESUME_TIMEOUT_MS) {
    if (!context || typeof context.resume !== 'function') return Promise.resolve();
    const timeoutMs = Number.isFinite(ms) ? ms : RESUME_TIMEOUT_MS;
    return Promise.race([
      Promise.resolve()
        .then(() => context.resume())
        .then(
          () => {},
          () => {},
        ),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]).then(() => {});
  }
  // Cheap re-armed resume for attached elements: a single document-level
  // play/playing capture pair resumes any suspended session that still
  // holds elements. Registered once, removed only when no session holds
  // elements. Gesture listeners in createMediaSession cover click/touch/
  // key/pointerdown; this covers feed autoplay (play events with no
  // gesture) while the tab is active.
  let attachedResumeArmed = false;
  function resumeAttachedSessions() {
    for (const session of sessions) {
      try {
        if (session.mediaElements.size === 0) continue;
        if (session.context.state === 'suspended'
          && typeof session.context.resume === 'function') {
          void resumeWithTimeout(session.context, RESUME_TIMEOUT_MS);
        }
      } catch {}
    }
    maybeDisarmAttachedResume();
  }
  function ensureAttachedResumeListeners() {
    if (attachedResumeArmed) return;
    attachedResumeArmed = true;
    trackListener(document, 'play', resumeAttachedSessions, true);
    trackListener(document, 'playing', resumeAttachedSessions, true);
  }
  function maybeDisarmAttachedResume() {
    if (!attachedResumeArmed) return;
    let held = false;
    try {
      for (const session of sessions) {
        if (session.mediaElements.size !== 0) { held = true; break; }
      }
    } catch {}
    if (held) return;
    attachedResumeArmed = false;
    untrackListener(document, 'play', resumeAttachedSessions, true);
    untrackListener(document, 'playing', resumeAttachedSessions, true);
  }
  // Worklet URL contract: the ONLY trusted source is the START message from
  // the ISOLATED content script (which knows chrome.runtime.getURL). The
  // page-writable DOM attribute is kept ONLY as the pending-start fallback
  // (set just before injection when the hook auto-starts before any START
  // arrives). Anything else — page-relative fallback, missing value, or an
  // origin that is not the content-script-set one pinned at load — fails
  // closed with a clear status error. Never fetch a non-chrome-extension URL.
  //
  // Origin pinning: a bare `chrome-extension://` prefix check lets a page
  // START pin ANY extension id's worklet path. At load the hook captures the
  // exact origin of the content-script-set attribute value; every candidate
  // must match that origin plus the exact worklet path. No pinned origin
  // (attribute missing at load) means nothing validates — fail closed.
  /** @type {string} */
  let pinnedWorkletOrigin = '';
  /** @param {unknown} value */
  function isValidWorkletUrl(value) {
    if (typeof value !== 'string' || !pinnedWorkletOrigin) return false;
    let parsed = null;
    try {
      parsed = new URL(value);
    } catch {
      return false;
    }
    return parsed.origin === pinnedWorkletOrigin
      && parsed.pathname === WORKLET_SUFFIX;
  }
  function readWorkletUrlAttribute() {
    let value = null;
    try {
      value = document.documentElement?.getAttribute(WORKLET_ATTR);
    } catch { value = null; }
    try {
      document.documentElement?.removeAttribute(WORKLET_ATTR);
    } catch {}
    // Structural pre-check only (origin pinning happens right after from
    // whatever this captures); the pinned `isValidWorkletUrl` gates use.
    const ok = typeof value === 'string'
      && value.startsWith('chrome-extension://')
      && value.endsWith(WORKLET_SUFFIX);
    return ok ? value : null;
  }
  // Capture the pending-start fallback value once at load; the attribute is
  // removed immediately so the page cannot swap it afterwards. The value's
  // origin is pinned: only it (plus the exact worklet path) ever validates.
  const pendingWorkletUrlFallback = readWorkletUrlAttribute();
  try {
    if (pendingWorkletUrlFallback) {
      pinnedWorkletOrigin = new URL(pendingWorkletUrlFallback).origin;
    }
  } catch {
    pinnedWorkletOrigin = '';
  }
  /** @type {string|null} */
  let WORKLET_URL = null;
  /**
   * Resolve the worklet URL: START payload first, stored value next,
   * pending-start DOM fallback last. Returns null when none validates —
   * the caller fails closed with a status error.
   * @param {unknown} candidate
   */
  function ensureWorkletUrl(candidate) {
    if (isValidWorkletUrl(candidate)) {
      WORKLET_URL = /** @type {string} */ (candidate);
      return WORKLET_URL;
    }
    if (isValidWorkletUrl(WORKLET_URL)) return WORKLET_URL;
    if (isValidWorkletUrl(pendingWorkletUrlFallback)) {
      WORKLET_URL = pendingWorkletUrlFallback;
      return WORKLET_URL;
    }
    return null;
  }
  const MIN_GAIN_DB = -12;
  const MAX_GAIN_DB = 12;

  console.log('[hook] loaded, worklet:', WORKLET_URL);

  const originalConnect = AudioNode.prototype.connect;
  const originalPlay = HTMLMediaElement.prototype.play;
  const originalCreateMediaElementSource = AudioContext.prototype.createMediaElementSource;
  // Originals of the constructor patches, so a dispose can put the page back
  // exactly as it was instead of leaving half-patched globals behind.
  /** @type {{ AudioContext?: any, OfflineAudioContext?: any, webkitAudioContext?: any }} */
  const patchedConstructorOriginals = {};

  // -------------------------------------------------------------------------
  // Per-instance session registry — deliberately NOT page-durable.
  //
  // Design cut: a captured element cannot be recaptured (Web Audio allows one
  // source per element), so a live document can never be re-normalized after its
  // graph is released. Rather than retain a captured context and its sources for
  // a later instance (which pins the graph and the removed elements for the life
  // of the document), STOP/DESTROY release everything for good, and the popup
  // tells the user that a reload restores the page.
  // -------------------------------------------------------------------------
  const sessions = new Set();
  const contextSessions = new WeakMap();
  const mediaSessions = new WeakMap();
  let mediaSessionPromise = null;
  const guardedMediaElements = new Set();
  // Elements the page wired into its own Web Audio graph. They cannot be
  // captured by us (one MediaElementSource per element, ever) and are left
  // playing untouched; the set is what turns that into a visible verdict.
  const unmanagedMediaElements = new Set();
  // Elements left native because their captured stream carries no accessible
  // audio (CORS-protected) — a verdict, never a mute.
  const protectedMediaElements = new Set();
  let recoveryBurstTimer = null;
  let recoveryBurstRemaining = 0;

  // Program-boundary tracking (feed fix, page-hook half): exactly one
  // {type:'reset-program', generation} per new program to each active
  // session's worklet port. Per-element generation counter lives on the
  // element (__tnProgramGen) mirrored in elementProgramGenerations;
  // the tab-wide generation is currentProgramGeneration; each session
  // tracks lastResetGeneration / pendingResetGeneration; the active
  // program element is activeProgramElement.
  const elementProgramGenerations = new WeakMap();
  // Durable per-document map: element -> { source, session }. NEVER deleted
  // for the life of the document (WeakMap key, so a discarded element can
  // still be collected; the live AudioNodes stay pinned only by the owning
  // session's `sources` set). Removal never disconnects and never drops the
  // entry: a re-inserted element reuses the SAME source with zero re-capture
  // (a second createMediaElementSource on one element throws). Per instance, and
  // released with the session: see releaseSessions.
  const elementSources = new WeakMap();
  let currentProgramGeneration = 0;
  let activeProgramElement = null;

  /** @type {{ active: boolean, observer: (MutationObserver|null), recovering: boolean, internalWiring: boolean, creatingContext: boolean, gainDb: number, lastError: string, stopped: boolean }} */
  const state = {
    active: false,
    observer: null,
    recovering: false,
    internalWiring: false,
    creatingContext: false,
    gainDb: 0,
    lastError: '',
    stopped: false,
  };

  // The frame gate (written by the background in the MAIN world just before
  // this file, from the frame's OWN hostname) is the first thing consulted: an
  // excluded frame gets no listener, no observer and no patch.
  if (globalThis.__tabNormalizerFrameGate?.excluded === true) {
    return;
  }

  // There is NO page -> extension control channel. Nothing here listens on
  // `window`: a page posting START/STATUS_REQUEST/SET_GAIN reaches nothing.
  // Control arrives only through the background's `executeScript({func})`,
  // which calls the dispatcher below. `stop` leaves the dispatcher in place on
  // purpose (a later enable must revive this instance, not a fresh one), and
  // `destroy` removes it — after that the only way back is a fresh injection
  // from the worker.
  //
  // `__tnDisposeV6` is the one inert marker left behind: it can only tear the
  // hook down (never start it), and it exists so a re-injection does not stack
  // a second instance on a live one. It costs no timer, observer or listener.
  try {
    if (typeof globalThis.__tnDisposeV6 === 'function') {
      globalThis.__tnDisposeV6();
    }
  } catch {}


  function tnDispatch(action, payload) {
    if (action === 'start') {
      start(payload || null);
      return status();
    }
    if (action === 'setGain') {
      setGain(payload && payload.gainDb);
      return status();
    }
    if (action === 'status') return status();
    // 'stop' is a BYPASS, not a teardown: the worklet is disconnected and the
    // page plays unprocessed at 0 dB, while the dispatcher, the sessions and
    // every captured source stay alive. That is what makes a later enable live
    // (a captured element can never be re-captured, so releasing it here would
    // make re-enable impossible without a reload).
    if (action === 'stop') {
      stop();
      return status();
    }
    // 'destroy' is the exclusion/uninstall path: full teardown, dispatcher
    // removed, sessions released. Nothing survives it by design.
    if (action === 'destroy') {
      dispose();
      return { ok: true, alive: false, active: false, error: '' };
    }
    return status();
  }

  /**
   * Full teardown from the worker's point of view: no processing, no listeners,
   * no timers, patched globals restored, the dispatcher deleted, and every
   * session released for good. Nothing is kept for a later instance.
   */
  function dispose() {
    try {
      stop();
    } catch {}
    try {
      releaseSessions();
    } catch {}
    // stop() keeps the session-context watchers (the sessions survive it); a
    // destroy releases the sessions, so their listeners go with them.
    try {
      untrackListeners();
    } catch {}
    try {
      restorePatchedPrototypes();
    } catch {}
    removeControlSurface();
  }

  /**
   * Release every session the hook created: detach its elements, disconnect its
   * sources, disconnect its worklet and close its context.
   *
   * This is what makes a later instance start clean. It also means a captured
   * element goes quiet for the rest of the document's life — the page's source
   * cannot be re-created and we no longer hold a context to route it — which is
   * exactly why the popup carries a reload notice (design cut, round 5).
   */
  function releaseSessions() {
    for (const session of Array.from(sessions)) {
      try {
        for (const mediaElement of Array.from(session.mediaElements || [])) {
          try {
            // A stream tap is handed back to the page (disconnect + unmute);
            // an element source is disconnected below and cannot be restored.
            if (!detachStreamRoute(mediaElement)) detachMediaElement(mediaElement);
          } catch {}
        }
        if (session.workletNode) {
          try { session.inputNode.disconnect(session.workletNode); } catch {}
          try { session.workletNode.disconnect(session.outputNode); } catch {}
        }
        try { session.inputNode.disconnect(session.outputNode); } catch {}
        for (const source of Array.from(session.sources || [])) {
          try { source.disconnect(); } catch {}
        }
        try { session.sources.clear(); } catch {}
        try { session.mediaElements.clear(); } catch {}
        if (session.context && session.context.state !== 'closed'
          && typeof session.context.close === 'function') {
          void session.context.close().catch(() => {});
        }
      } catch {}
      try {
        sessions.delete(session);
      } catch {}
      try {
        if (mediaSessions.get(document) === session) mediaSessions.delete(document);
      } catch {}
    }
    try {
      deferredCaptureElements.clear();
    } catch {}
    try {
      guardedMediaElements.clear();
    } catch {}
    try {
      unmanagedMediaElements.clear();
    } catch {}
    try {
      protectedMediaElements.clear();
    } catch {}
  }

  function status() {
    return {
      ok: true,
      alive: true,
      active: isHookActive(),
      gainDb: state.gainDb,
      error: state.lastError,
      // Elements the page owns (it created its own MediaElementSource) can never
      // be captured by us: reported so the popup can show a verdict instead of
      // pretending the page is normalized.
      unprocessed: unmanagedMediaElements.size,
      // Elements whose captured stream carried no accessible audio (CORS).
      protected: protectedMediaElements.size,
    };
  }

  /**
   * Remove every page-callable entrypoint. After this a page cannot restart
   * processing: the dispatcher is gone, the listeners are gone, the routes are
   * bypassed. `__tnDisposeV6` stays (teardown-only) so a later re-injection can
   * dispose this instance before installing its own.
   */
  function removeControlSurface() {
    try {
      delete globalThis.__tnHookV6;
    } catch {
      globalThis.__tnHookV6 = undefined;
    }
  }

  globalThis.__tnHookV6 = tnDispatch;
  globalThis.__tnDisposeV6 = dispose;

  function bindLifecycleListeners() {
    trackListener(document, 'visibilitychange', handleLifecycleEvent);
    trackListener(window, 'focus', handleLifecycleEvent);
    trackListener(window, 'pageshow', handleLifecycleEvent);
  }

  function unbindLifecycleListeners() {
    untrackListener(document, 'visibilitychange', handleLifecycleEvent);
    untrackListener(window, 'focus', handleLifecycleEvent);
    untrackListener(window, 'pageshow', handleLifecycleEvent);
  }

  let lifecycleTimer = null;

  function handleLifecycleEvent() {
    if (!state.active) return;
    if (lifecycleTimer) return;
    lifecycleTimer = trackTimeout(() => {
      lifecycleTimer = null;
      scheduleRecoveryBurst();
    }, 200);
  }

  /**
   * @param {{ gainDb?: number, workletUrl?: unknown }|null} [nextState]
   */
  function start(nextState = null) {
    const wasActive = state.active;
    state.stopped = false;
    if (nextState && typeof nextState === 'object') {
      state.gainDb = normalizeGainDb(nextState.gainDb);
    }
    // Worklet URL contract: START payload first, stored value next,
    // pending-start DOM fallback last. Fail closed on anything else.
    const resolvedUrl = ensureWorkletUrl(
      nextState && typeof nextState === 'object' ? nextState.workletUrl : null,
    );
    if (!resolvedUrl) {
      setError('Invalid worklet URL: expected a chrome-extension:// URL ending in /audio/normalizer-worklet.js.');
      return;
    }
    state.active = true;
    state.gainDb = normalizeGainDb(state.gainDb);
    state.lastError = '';
    bindLifecycleListeners();

    // Owner-directed seamless start: pre-warm the media session (AudioContext +
    // AudioWorklet module + node) so it is ready before the first media element
    // plays. The CPU cost is accepted. Never awaited; failures surface via setError.
    if (!mediaSessions.has(document) && !mediaSessionPromise) {
      void ensureMediaSession().catch(() => {});
    }

    if (wasActive) {
      routeSessions();
      updateSessionGains();
      reportStatus('HOOK_STATUS');
      return;
    }

    clearRecoveryBurst();
    console.log('[hook] starting');
    try {
      bootstrap();
    } catch (e) {
      console.error('[hook] bootstrap failed:', e);
      setError(`Bootstrap failed: ${e.message || e}`);
    }
    // One document scan per enable: this is the only pass that walks the page
    // (the recovery burst is rate-limited behind it, and the play patch plus the
    // DOM observer are the normal attach triggers after it).
    lastMediaScanAt = 0;
    attachExistingMediaElements();
    rewatchAttachedMediaElements();
    routeSessions();
    updateSessionGains();
    notifySessionStarts();
    // Re-enable transition (inactive -> active after a previous program):
    // mint one fresh program generation and broadcast exactly one
    // reset-program per session so the re-enabled hook never resumes on the
    // previous program's stale AGC/limiter state. Never reset at attach time
    // (attach paths only flush this pending generation); the first cold start
    // (no prior program) needs no reset because every worklet is already cold.
    if (currentProgramGeneration > 0 || activeProgramElement) {
      currentProgramGeneration += 1;
      broadcastProgramReset(currentProgramGeneration);
    }
    void recoverAudio();
    scheduleRecoveryBurst();
    reportStatus('HOOK_STARTED');
  }

  function setGain(gainDb) {
    state.gainDb = normalizeGainDb(gainDb);
    updateSessionGains();
    reportStatus('HOOK_STATUS');
  }

  function stop() {
    if (!state.active) return;
    state.active = false;
    // The recovery burst must not re-route audio after an explicit stop.
    state.stopped = true;
    clearRecoveryBurst();
    console.log('[hook] stopping');
    // OFF IS NATIVE. Every stream tap is disconnected and its tracks stopped
    // BEFORE the elements are unmuted, so the page gets its own audio back (a
    // stream tap never stole it) and there is no window with both routes live.
    // The session, its context and its worklet stay for a fast re-enable.
    releaseStreamRoutes();
    restoreAllHookGuards();

    for (const session of sessions) {
      bypassSession(session);
    }

    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }

    // Close hook-created media contexts that no longer route anything; a
    // fresh one is pre-warmed on the next start. Sessions that ever
    // captured stay alive (their sources cannot be re-captured elsewhere).
    for (const session of Array.from(sessions)) {
      maybeCloseIdleMediaSession(session);
    }
    try {
      deferredCaptureElements.clear();
    } catch {}
    maybeDisarmAttachedResume();

    // Complete teardown: every tracked listener, every tracked timer, every
    // per-element listener. `dispose()` goes further afterwards — it restores
    // the patched prototypes and releases the sessions — so what remains here is
    // the part `stop()` owns when it is called on its own.
    unbindLifecycleListeners();
    untrackTimeout(lifecycleTimer);
    lifecycleTimer = null;
    teardownElementListeners();
    // Session context watchers survive: the sessions do (see watchSessionContext).
    untrackListeners((entry) => entry.keepOnStop === true);
    // The armed flag must follow the sweep, or the next START would not re-add
    // the document-level resume pair.
    if (attachedResumeArmed) {
      attachedResumeArmed = false;
      untrackListener(document, 'play', resumeAttachedSessions, true);
      untrackListener(document, 'playing', resumeAttachedSessions, true);
    }
    untrackAllTimers();

    reportStatus('HOOK_STOPPED');
  }

  // Close a hook-created (media-kind) context once it routes nothing and the
  // hook is inactive. A context that ever captured NEVER closes: its
  // sources cannot be re-captured elsewhere, and closing would make every
  // later retry throw and latch __tnWebAudio forever. When such a context
  // is idle (no present elements) and the hook is inactive it is suspended
  // to release CPU instead; the next attach resumes it. The media session
  // is pre-warmed per document so the close saves nothing.
  function maybeCloseIdleMediaSession(session) {
    if (!session || session.kind !== 'media') return;
    if (session.captured) {
      // Captured latch: close is impossible after any capture — suspend
      // when idle and inactive, never close, never tear down.
      if (session.mediaElements.size !== 0) return;
      if (state.active) return;
      try {
        if (typeof session.context.suspend === 'function'
          && session.context.state === 'running') {
          void session.context.suspend().catch(() => {});
        }
      } catch {}
      return;
    }
    if (session.mediaElements.size !== 0) return;
    if (session.sources.size !== 0) return;
    if (state.active) return;
    try {
      if (typeof session.context.close === 'function'
        && session.context.state !== 'closed') {
        void session.context.close().catch(() => {});
      }
    } catch {}
    teardownSession(session);
  }

  function bootstrap() {
    patchConnect();
    patchPlay();
    patchCreateMediaElementSource();
    observeDom();

    try {
      const OrigAC = /** @type {typeof AudioContext & {__tnPatched?: boolean}} */ (window.AudioContext);
      if (OrigAC && !OrigAC.__tnPatched) {
        class PatchedAudioContext extends OrigAC {
          constructor(...args) {
            super(...args);
            if (state.creatingContext || this.state === 'closed') return;
            try { ensureContextSession(this); } catch {}
          }
        }
        PatchedAudioContext.__tnPatched = true;
        patchedConstructorOriginals.AudioContext = OrigAC;
        window.AudioContext = /** @type {typeof AudioContext & {__tnPatched?: boolean}} */ (PatchedAudioContext);
      }

      const OrigOAC = /** @type {typeof OfflineAudioContext & {__tnPatched?: boolean}} */ (window.OfflineAudioContext);
      if (OrigOAC && !OrigOAC.__tnPatched) {
        const Parent = /** @type {{ new (...a: any[]): OfflineAudioContext & {__tnPatched?: boolean} }} */ (OrigOAC);
        class PatchedOfflineAudioContext extends Parent {
          constructor(...args) {
            super(...args);
            if (state.creatingContext) return;
            try { ensureContextSession(this); } catch {}
          }
        }
        PatchedOfflineAudioContext.__tnPatched = true;
        patchedConstructorOriginals.OfflineAudioContext = OrigOAC;
        window.OfflineAudioContext = /** @type {typeof OfflineAudioContext & {__tnPatched?: boolean}} */ (PatchedOfflineAudioContext);
      }

      if (window.webkitAudioContext) {
        const Orig = /** @type {typeof AudioContext & {__tnPatched?: boolean}} */ (window.webkitAudioContext);
        if (!Orig.__tnPatched) {
          class PatchedWebkitAudioContext extends Orig {
            constructor(...args) {
              super(...args);
              if (state.creatingContext || this.state === 'closed') return;
              try { ensureContextSession(this); } catch {}
            }
          }
          PatchedWebkitAudioContext.__tnPatched = true;
          patchedConstructorOriginals.webkitAudioContext = Orig;
          window.webkitAudioContext = /** @type {typeof AudioContext & {__tnPatched?: boolean}} */ (PatchedWebkitAudioContext);
        }
      }
    } catch {}

    try { scanExistingContexts(); } catch {}
  }

  function scanExistingContexts() {
    const candidates = new Set();

    // Fast path: check known common variable names
    const knownKeys = ['audioCtx', 'audioContext', 'ctx', 'context', 'actx', 'ac'];
    for (const key of knownKeys) {
      try {
        const val = window[key];
        if (val && typeof val === 'object') candidates.add(val);
      } catch {}
    }

    // Fallback: scan window keys with audio/context pattern, capped at 200
    if (candidates.size === 0) {
      let scanned = 0;
      try {
        for (const key of Object.keys(window)) {
          if (scanned++ > 200) break;
          if (!/audio|ctx|context/i.test(key)) continue;
          try {
            const val = window[key];
            if (val && typeof val === 'object') candidates.add(val);
          } catch {}
        }
      } catch {}
    }

    for (const c of candidates) {
      try {
        if (c && typeof c === 'object' &&
            c.state !== 'closed' &&
            Number.isFinite(c.sampleRate) &&
            c.destination && typeof c.createGain === 'function') {
          ensureContextSession(c);
        }
      } catch {}
    }
  }

  function patchConnect() {
    if (AudioNode.prototype.__tnConnect) return;
    AudioNode.prototype.__tnConnect = true;

    AudioNode.prototype.connect = function (dest, out, inp) {
      if (!state.internalWiring && state.active && this.context && dest === this.context.destination) {
        const s = ensureContextSession(this.context);
        if (s) return originalConnect.call(this, s.inputNode, out, inp);
      }
      return originalConnect.call(this, dest, out, inp);
    };
  }

  // Pending play() attempts, per element. Every play() call adds its own
  // token and removes it when its promise settles; the listener gate is
  // "this element has at least one unresolved attempt". A single boolean
  // was cleared by whichever attempt settled first, so a still-pending
  // attempt's later play/playing events could reset (SPEC F1).
  /** @type {WeakMap<object, Set<object>>} */
  const pendingPlayAttempts = new WeakMap();

  /** @param {any} mediaElement */
  function beginPlayAttempt(mediaElement) {
    let attempts = pendingPlayAttempts.get(mediaElement);
    if (!attempts) {
      attempts = new Set();
      pendingPlayAttempts.set(mediaElement, attempts);
    }
    const token = {};
    attempts.add(token);
    return token;
  }

  /**
   * @param {any} mediaElement
   * @param {object} token
   * @param {boolean} confirmed
   */
  function finishPlayAttempt(mediaElement, token, confirmed) {
    const attempts = pendingPlayAttempts.get(mediaElement);
    if (attempts) {
      attempts.delete(token);
      if (attempts.size === 0) pendingPlayAttempts.delete(mediaElement);
    }
    // The promise, not the event stream, owns the reset decision: a resolved
    // attempt confirms a start even while another attempt is still pending.
    // The token set above keeps the listeners closed until the LAST attempt
    // settles, so an earlier settle can never open that gate.
    if (confirmed) handleElementPlaybackStart(mediaElement);
  }

  /** @param {any} mediaElement */
  function hasPendingPlayAttempt(mediaElement) {
    const attempts = pendingPlayAttempts.get(mediaElement);
    return !!attempts && attempts.size > 0;
  }

  function patchPlay() {
    if (HTMLMediaElement.prototype.__tnPlay) return;
    HTMLMediaElement.prototype.__tnPlay = true;

    HTMLMediaElement.prototype.play = function (...args) {
      const managed = state.active && (!this.__tnWebAudio || this.__tnAttached);
      let attempt = null;
      if (managed) {
        watchProgramBoundaries(this);
        // Close the play/playing listener path for THIS attempt until its
        // promise settles: a listener must not reset ahead of a start that
        // is then rejected. The element is not "playing" yet at this instant,
        // so the attach is explicitly flagged as a play attempt.
        attempt = beginPlayAttempt(this);
        void attachMediaElement(this, { fromPlay: true });
      }
      let started;
      try {
        started = originalPlay.apply(this, args);
      } catch (err) {
        if (attempt) finishPlayAttempt(this, attempt, false);
        throw err;
      }
      // Single reset decision: a confirmed start. The promise path owns it
      // while an attempt is pending; the listeners take over only when
      // play() returns no promise to confirm with.
      if (attempt && started && typeof started.then === 'function') {
        started.then(
          () => { finishPlayAttempt(this, attempt, true); },
          () => { finishPlayAttempt(this, attempt, false); },
        );
      } else if (attempt) {
        finishPlayAttempt(this, attempt, false);
      }
      return started;
    };
  }

  function patchCreateMediaElementSource() {
    if (AudioContext.prototype.__tnMediaSource) return;
    AudioContext.prototype.__tnMediaSource = true;

    AudioContext.prototype.createMediaElementSource = function (el) {
      // Our own attach path runs under `state.internalWiring` (see
      // attachMediaElement): never label our own wiring as page WebAudio, or
      // the element could never re-attach after a context close/recover.
      if (el && !state.internalWiring) el.__tnWebAudio = true;
      return originalCreateMediaElementSource.call(this, el);
    };
  }

  function observeDom() {
    patchAttachShadow();
    if (state.observer) {
      // Observer already runs: still sweep for shadow roots added since the
      // last sweep (open roots created while inactive are never patched).
      scanShadowRoots();
      return;
    }

    let observerTimer = null;
    let pendingBatches = [];
    // Feed-starvation guard: one flush never walks an unbounded queue.
    // A mutation storm is sliced into capped flushes; the remainder is
    // carried over to the next tick, never dropped.
    const MAX_MUTATIONS_PER_FLUSH = 200;

    function flushMutations() {
      observerTimer = null;
      const batch = pendingBatches.slice(0, MAX_MUTATIONS_PER_FLUSH);
      pendingBatches = pendingBatches.slice(batch.length);
      for (const m of batch) {
        for (const node of m.removedNodes ?? []) {
          // Detach first so removed elements leave the present set: the
          // source stays connected and the cache entry is kept.
          // (A later re-insert re-attaches, reusing the live source.)
          try {
            if (!(node instanceof Element)) continue;
            if (isMediaElement(node)) {
              detachMediaElement(node);
            }
            for (const media of node.querySelectorAll?.('audio, video') ?? []) {
              detachMediaElement(media);
            }
            // No querySelectorAll('*') walk here: removals inside a shadow
            // tree arrive as their own mutations (every open root is
            // observed), so a descendant sweep would only re-walk the
            // subtree at O(size) per mutation.
          } catch {}
        }
        for (const node of m.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (isMediaElement(node)) {
            void attachMediaElement(node);
          }
          for (const media of node.querySelectorAll?.('audio, video') ?? []) {
            void attachMediaElement(media);
          }
          // A subtree added under a shadow host arrives as one Element:
          // observe its own open root. Descendant hosts need no sweep —
          // patchAttachShadow captures every root created after injection
          // and scanShadowRoots covers roots that already existed.
          try {
            if (node.shadowRoot) observeShadowRoot(node.shadowRoot);
          } catch {}
        }
      }
      if (pendingBatches.length > 0) {
        observerTimer = trackTimeout(flushMutations, 0);
      }
    }

    state.observer = new MutationObserver((mutations) => {
      if (!state.active) return;
      // Coalesce, never drop: a removal landing inside the 100 ms window
      // is queued and detached on the next flush.
      for (const m of mutations ?? []) pendingBatches.push(m);
      if (observerTimer) return;

      observerTimer = trackTimeout(flushMutations, 100);
    });

    state.observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
    });
    scanShadowRoots();
  }

  // Open-shadow-root walk: the MutationObserver on document never sees nodes
  // inside a shadow tree, so a <video> in an open shadow root would never be
  // attached. Observe each open root with the same observer and attach any
  // media already inside. Closed roots have no observable handle — the
  // play() patch still catches those at playback time.
  /** @param {any} root */
  function observeShadowRoot(root) {
    if (!root) return;
    // Re-enable fix: stop() disconnects + nulls the observer, so a later
    // start creates a new instance. A bare __tnObserved flag would
    // early-return forever for previously seen roots. Track the observing
    // instance and re-observe when it differs from the live observer.
    if (state.observer && /** @type {any} */ (root).__tnObserver !== state.observer) {
      try {
        state.observer.observe(root, { childList: true, subtree: true });
        /** @type {any} */ (root).__tnObserved = true;
        /** @type {any} */ (root).__tnObserver = state.observer;
      } catch {}
    }
    try {
      for (const media of root.querySelectorAll?.('audio, video') ?? []) {
        void attachMediaElement(media);
      }
      for (const el of root.querySelectorAll?.('*') ?? []) {
        if (el.shadowRoot) observeShadowRoot(el.shadowRoot);
      }
    } catch {}
  }

  function scanShadowRoots() {
    // Bounded walk: a huge feed can hold thousands of elements, so the host walk
    // is capped, each root is visited once (WeakSet), and the number of roots
    // observed in one pass is capped. Runs only from a rate-limited scan.
    try {
      const hosts = document.querySelectorAll?.('*') ?? [];
      let visited = 0;
      let observed = 0;
      for (const el of hosts) {
        if (visited >= MAX_SHADOW_HOSTS || observed >= MAX_SHADOW_ROOTS) break;
        visited += 1;
        if (!el.shadowRoot || scannedShadowRoots.has(el.shadowRoot)) continue;
        scannedShadowRoots.add(el.shadowRoot);
        observed += 1;
        observeShadowRoot(el.shadowRoot);
      }
    } catch {}
  }

  function patchAttachShadow() {
    try {
      const proto = Element.prototype;
      if (!proto) return;
      if (/** @type {any} */ (proto).__tnAttachShadow) return;
      /** @type {any} */ (proto).__tnAttachShadow = true;
      const originalAttachShadow = proto.attachShadow;
      if (typeof originalAttachShadow !== 'function') return;
      /** @param {any[]} args */
      /** @type {any} */ (proto).attachShadow = function (...args) {
        const root = originalAttachShadow.apply(this, args);
        try {
          if (state.observer) observeShadowRoot(root);
        } catch {}
        return root;
      };
    } catch {}
  }

  function attachExistingMediaElements() {
    // Only what is actually PLAYING is routed. A feed preloads many <video>
    // elements that never play; capturing each one costs a context source and a
    // worklet route and is what froze infinite feeds. Later elements are picked
    // up by the `play()` patch and the DOM observer.
    //
    // Rate-limited: a start scan is meant, but recovery ticks must not re-walk a
    // large document every 250 ms.
    if (!scanAllowed()) return;
    let routed = 0;
    for (const media of document.querySelectorAll?.('audio, video') ?? []) {
      if (!isPlayingMedia(media)) continue;
      if (routed >= MAX_ROUTED_MEDIA) break;
      routed += 1;
      void attachMediaElement(media);
    }
    scanShadowRoots();
  }

  function scanAllowed() {
    const now = Date.now();
    if (now - lastMediaScanAt < MEDIA_SCAN_MIN_INTERVAL_MS) return false;
    lastMediaScanAt = now;
    return true;
  }

  // ---------------------------------------------------------------------------
  // What may be routed, and how often the DOM is walked.
  //
  // The stream tap (captureStream) is the default route: it does NOT steal the
  // element's output, so off/stop can hand native audio back. The element-source
  // route is the fallback only (engines without captureStream) and permanently
  // steals the element, so it is never used for page-owned/DRM/srcObject media
  // or for CORS-cross-origin media that is not CORS-approved (its graph output
  // is silence by spec).
  //
  // A full-document scan is expensive on a feed: it runs once per enable, and a
  // recovery pass may ask for one at most every MEDIA_SCAN_MIN_INTERVAL_MS.
  // ---------------------------------------------------------------------------
  const CORS_APPROVED = ['anonymous', 'use-credentials'];
  const MAX_SHADOW_ROOTS = 40;
  const MAX_SHADOW_HOSTS = 2000;
  let lastMediaScanAt = 0;
  const scannedShadowRoots = new WeakSet();

  /** @param {any} mediaElement */
  function isCorsCrossOrigin(mediaElement) {
    try {
      const raw = mediaElement.currentSrc || mediaElement.src || '';
      if (!raw) return false;
      const url = new URL(raw, location.href);
      // blob:/data:/mediastream: URLs carry their own origin; MSE (YouTube's
      // blob: URLs) is same-origin and must keep the element-source path.
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      // `location.origin` is authoritative; the href fallback keeps the check
      // honest in worlds that expose only the URL.
      const pageOrigin = location.origin || new URL(location.href).origin;
      if (url.origin === pageOrigin) return false;
      return !CORS_APPROVED.includes(String(mediaElement.crossOrigin || '').toLowerCase());
    } catch {
      return false;
    }
  }

  /** @param {any} mediaElement */
  function isPlayingMedia(mediaElement) {
    try {
      return Boolean(mediaElement
        && !mediaElement.paused
        && !mediaElement.ended
        && mediaElement.readyState >= 2 /* HAVE_CURRENT_DATA */
        && (mediaElement.currentSrc || mediaElement.srcObject));
    } catch {
      return false;
    }
  }

  /** How many elements this document already routes. */
  function routedMediaCount() {
    let count = 0;
    for (const session of sessions) {
      try {
        count += session.mediaElements.size;
      } catch {}
    }
    return count;
  }

  // Attaches in flight (an element whose route is being built). The cap counts
  // them, or a burst of play() calls would all pass the check before the first
  // route lands. A second attach for the same element is refused outright.
  let pendingAttachCount = 0;
  const attachingElements = new WeakSet();

  /**
   * Why this element must not be routed ('' when it may be).
   * @param {any} mediaElement
   */
  function unroutableReason(mediaElement) {
    try {
      if (mediaElement.__tnWebAudio) return 'page';
      if (mediaElement.mediaKeys) return 'drm';
      if (mediaElement.srcObject) return 'srcObject';
    } catch {}
    return '';
  }

  /**
   * Record an element we deliberately left native, so the popup can show a
   * verdict instead of claiming the page is normalized. Never mutes, never
   * captures, never retried in a loop.
   * @param {any} mediaElement
   * @param {'page'|'drm'|'srcObject'|'protected'|'cap'} reason
   */
  function noteUnroutable(mediaElement, reason) {
    try {
      mediaElement.__tnUnroutable = reason;
      if (reason === 'protected') {
        protectedMediaElements.add(mediaElement);
      } else {
        unmanagedMediaElements.add(mediaElement);
      }
    } catch {}
  }

  function ensureContextSession(context) {
    let session = contextSessions.get(context);
    if (session) return session;

    if (context.state === 'closed') {
      console.log('[hook] skipping closed context');
      return null;
    }

    session = createSession(context, 'context');
    contextSessions.set(context, session);
    sessions.add(session);

    if (state.active && session.readyResolved && !session.workletNode) {
      attachWorklet(session);
    }
    return session;
  }

  async function ensureMediaSession() {
    if (mediaSessions.has(document)) {
      return mediaSessions.get(document);
    }

    if (mediaSessionPromise) {
      return mediaSessionPromise;
    }

    mediaSessionPromise = createMediaSession();

    try {
      return await mediaSessionPromise;
    } finally {
      mediaSessionPromise = null;
    }
  }

  async function createMediaSession() {
    /** @type {AudioContext|undefined} */
    let context;
    state.creatingContext = true;
    try {
      context = new AudioContext({ latencyHint: 'interactive' });
    } catch (e) {
      console.warn('[hook] AudioContext creation failed:', e.message || e);
    } finally {
      state.creatingContext = false;
    }

    if (!context) return /** @type {*} */ (null);

    console.log('[hook] AudioContext created, state:', context.state, 'sampleRate:', context.sampleRate);

    // Autoplay-policy fix: gesture listeners MUST be registered before any
    // resume await, so a context created before the first gesture still
    // resumes on click/touch/key. The resume itself must never block session
    // creation: race it against a short timeout and retry on gesture.
    const resumeOnInteraction = async () => {
      try {
        await context.resume();
        console.log('[hook] AudioContext resumed on user interaction');
      } catch {}
      if (context.state === 'running') {
        document.removeEventListener('click', resumeOnInteraction);
        document.removeEventListener('touchstart', resumeOnInteraction);
        document.removeEventListener('keydown', resumeOnInteraction);
        document.removeEventListener('pointerdown', resumeOnInteraction);
      }
    };
    document.addEventListener('click', resumeOnInteraction);
    document.addEventListener('touchstart', resumeOnInteraction);
    document.addEventListener('keydown', resumeOnInteraction);
    document.addEventListener('pointerdown', resumeOnInteraction);
    ensureAttachedResumeListeners();

    // Bounded resume: never blocks session creation under the autoplay
    // policy; the gesture listeners above retry on interaction.
    await resumeWithTimeout(context, RESUME_TIMEOUT_MS);

    if (context.state === 'running') {
      document.removeEventListener('click', resumeOnInteraction);
      document.removeEventListener('touchstart', resumeOnInteraction);
      document.removeEventListener('keydown', resumeOnInteraction);
      document.removeEventListener('pointerdown', resumeOnInteraction);
    }

    const session = createSession(context, 'media');
    mediaSessions.set(document, session);
    sessions.add(session);

    if (state.active && session.readyResolved && !session.workletNode) {
      attachWorklet(session);
    }

    await session.ready;
    return session;
  }

  /**
   * Bind this instance's teardown-tracked `statechange` listener to a session's
   * context. Called for a session this instance creates AND for one it ADOPTS:
   * the previous instance's copy was released by its own sweep, so the new owner
   * must watch the context it now routes.
   * @param {any} session
   */
  function watchSessionContext(session) {
    const context = session && session.context;
    if (!context) return;
    // `keepOnStop`: a session survives a STOP, so its context watcher must
    // survive it too. Without this a re-enabled hook would stop noticing a
    // closed or interrupted context until the next recovery pass.
    trackListener(context, 'statechange', () => {
      if (!state.active) return;
      if (context.state === 'closed') {
        setError('Audio context closed. Reconnecting…');
        teardownSession(session);
        void recoverAudio();
        return;
      }
      reportStatus('HOOK_STATUS');
    }, undefined, true);
  }

  function createSession(context, kind) {
    const inputNode = context.createGain();
    const outputNode = context.createGain();

    state.internalWiring = true;
    try {
      originalConnect.call(inputNode, outputNode);
      originalConnect.call(outputNode, context.destination);
    } finally {
      state.internalWiring = false;
    }

    const session = {
      context,
      inputNode,
      outputNode,
      workletNode: null,
      readyResolved: false,
      ready: null,
      sources: new Set(),
      mediaElements: new Set(),
      kind,
      captured: false,
      processorFailures: 0,
      lastResetGeneration: null,
      pendingResetGeneration: null,
    };

    watchSessionContext(session);

    session.ready = context.audioWorklet
      .addModule(WORKLET_URL || '')
      .then(async () => {
        console.log('[hook] worklet module loaded for context:', context.state);
        if (context.state === 'closed') {
          console.log('[hook] skipping worklet for closed context');
          return;
        }
        // Bounded resume before worklet node: never blocks readiness.
        await resumeWithTimeout(context, RESUME_TIMEOUT_MS);
        session.readyResolved = true;
        if (!state.active || session.workletNode) return;
        attachWorklet(session);
      })
      .catch((e) => {
        console.error('[hook] worklet module load failed:', e.message || e);
        setError(`Worklet module load failed: ${e.message || e}`);
      });

    return session;
  }

  function routeSessions() {
    for (const session of sessions) {
      if (session.workletNode) {
        routeSession(session, session.workletNode);
      } else if (session.readyResolved && state.active) {
        attachWorklet(session);
      }
    }
  }

  function attachWorklet(session) {
    if (!session || session.workletNode || !session.readyResolved || !state.active) return;

    try {
      const workletNode = new AudioWorkletNode(session.context, 'loudness-normalizer', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCountMode: 'max',
        channelInterpretation: 'speakers',
      });

      workletNode.onprocessorerror = (e) => {
        console.error('[hook] worklet processor error:', e);
        // Never leave a dead worklet wired: bypass at once so the element
        // keeps playing unprocessed, then retry with backoff. Repeated
        // failure stays in bypass (audible) rather than silent.
        try { session.inputNode.disconnect(workletNode); } catch {}
        try { workletNode.disconnect(session.outputNode); } catch {}
        try { session.inputNode.disconnect(session.outputNode); } catch {}
        try { session.inputNode.connect(session.outputNode); } catch {}
        session.workletNode = null;
        session.processorFailures = (session.processorFailures || 0) + 1;
        setError('Audio processor error. Retrying…');
        if (!state.recovering) {
          state.recovering = true;
          const delay = session.processorFailures > 2 ? 2000 : 500;
          trackTimeout(() => {
            state.recovering = false;
            try {
              if (session.processorFailures > 4) return;
              void recoverAudio();
            } catch {}
          }, delay);
        }
      };

      console.log('[hook] worklet node created, routing audio through normalizer');
      state.lastError = '';
      routeSession(session, workletNode);
      updateSessionGain(session);
      notifySessionStart(session);
      flushPendingProgramReset(session);
      reportStatus('HOOK_STATUS');
    } catch (e) {
      console.error('[hook] AudioWorkletNode creation failed:', e.message || e);
      console.log('[hook] audio will pass through unprocessed (bypass mode)');
      setError(`AudioWorkletNode creation failed: ${e.message || e}`);
    }
  }

  function routeSession(session, workletNode) {
    if (!session || !workletNode) return;

    try { session.inputNode.disconnect(session.outputNode); } catch {}
    try { session.inputNode.disconnect(workletNode); } catch {}
    try { workletNode.disconnect(session.outputNode); } catch {}

    try {
      session.inputNode.connect(workletNode);
      workletNode.connect(session.outputNode);
    } catch {
      // A throwing connect must never leave input->worklet with no path
      // to output: fall back to the direct (unprocessed but audible) path.
      bypassSession(session);
      return;
    }
    session.workletNode = workletNode;
  }

  function bypassSession(session) {
    if (!session) return;

    try {
      if (session.workletNode) {
        session.inputNode.disconnect(session.workletNode);
        session.workletNode.disconnect(session.outputNode);
      }
    } catch {}

    try { session.inputNode.disconnect(session.outputNode); } catch {}

    try {
      session.inputNode.connect(session.outputNode);
    } catch {}
    // Best-effort resume toward audible: when the site is disabled the
    // graph is input->destination, which is silent while suspended.
    try {
      if (session.context.state === 'suspended'
        && typeof session.context.resume === 'function') {
        void resumeWithTimeout(session.context, RESUME_TIMEOUT_MS);
      }
    } catch {}
  }

  function updateSessionGains() {
    for (const session of sessions) {
      updateSessionGain(session);
    }
  }

  function notifySessionStarts() {
    for (const session of sessions) {
      notifySessionStart(session);
    }
  }

  function updateSessionGain(session) {
    if (!session?.workletNode) return;
    try {
      session.workletNode.port.postMessage({ type: 'set-gain-db', gainDb: state.gainDb });
    } catch {}
  }

  function notifySessionStart(session) {
    if (!session?.workletNode) return;
    try {
      session.workletNode.port.postMessage({ type: 'start-normalizing' });
    } catch {}
    flushPendingProgramReset(session);
  }

  // Program-boundary detection. New program: first playback of a newly
  // attached managed element; loadstart/emptied followed by playback; a
  // different element begins playing while another was the active
  // program; replay after ended. Not a new program: pause/resume, seek
  // within the same program, waiting/playing buffer stall, repeated
  // play() while already playing. Never resets at attach time; only
  // after a confirmed start — the resolved play() promise, or a start
  // event with no play() attempt pending.
  /** @param {any} mediaElement */
  function watchProgramBoundaries(mediaElement) {
    if (!mediaElement || mediaElement.__tnProgramWatched) return;
    mediaElement.__tnProgramWatched = true;
    try {
      trackElementListener(mediaElement, 'loadstart', () => markProgramDirty(mediaElement));
      trackElementListener(mediaElement, 'emptied', () => {
        markProgramDirty(mediaElement);
        // The program is spent: leave the present set so a replay
        // re-attaches (reusing the cached source). The source stays
        // connected and the cache entry is kept.
        detachMediaElement(mediaElement);
      });
      trackElementListener(mediaElement, 'ended', () => {
        markProgramDirty(mediaElement);
        try { mediaElement.__tnPlaying = false; } catch {}
        detachMediaElement(mediaElement);
      });
      trackElementListener(mediaElement, 'pause', () => {
        try { mediaElement.__tnPlaying = false; } catch {}
      });
      trackElementListener(mediaElement, 'play', () => handlePlaybackSignal(mediaElement));
      trackElementListener(mediaElement, 'playing', () => handlePlaybackSignal(mediaElement));
    } catch {}
  }

  // Re-arm the per-element program listeners after a STOP cleared them. The
  // element keeps its captured source and __tnAttached flag across a stop, so
  // attachMediaElement alone would not re-watch it.
  function rewatchAttachedMediaElements() {
    for (const session of sessions) {
      for (const mediaElement of session.mediaElements) {
        try {
          mediaElement.__tnProgramWatched = false;
        } catch {}
        watchProgramBoundaries(mediaElement);
      }
    }
  }

  // The only gate on the listener path: while ANY play() attempt for the
  // element is unresolved its play/playing events must not reset; a start
  // outside play() (autoplay, a resumed element) has no pending attempt and
  // resets as before.
  /** @param {any} mediaElement */
  function handlePlaybackSignal(mediaElement) {
    if (!mediaElement || hasPendingPlayAttempt(mediaElement)) return;
    handleElementPlaybackStart(mediaElement);
  }

  /** @param {any} mediaElement */
  function markProgramDirty(mediaElement) {
    if (!mediaElement) return;
    try {
      mediaElement.__tnProgramDirty = true;
    } catch {}
  }

  /** @param {any} mediaElement */
  function handleElementPlaybackStart(mediaElement) {
    if (!state.active || !mediaElement) return;
    // Elements wired by the page through WebAudio are unmanaged; elements
    // wired by our own attach carry __tnAttached and stay managed.
    if (mediaElement.__tnWebAudio && !mediaElement.__tnAttached) return;
    let isNewProgram = false;
    try {
      if (mediaElement !== activeProgramElement) {
        isNewProgram = true;
      } else if (mediaElement.__tnProgramDirty) {
        isNewProgram = true;
      } else {
        isNewProgram = false;
      }
    } catch {
      return;
    }
    if (!isNewProgram) {
      try { mediaElement.__tnPlaying = true; } catch {}
      return;
    }
    // New program: bump the per-element counter, mint one tab-wide
    // generation, broadcast exactly once per session (or stash pending).
    try {
      const next = (elementProgramGenerations.get(mediaElement) || 0) + 1;
      elementProgramGenerations.set(mediaElement, next);
      mediaElement.__tnProgramGen = next;
      mediaElement.__tnProgramDirty = false;
      mediaElement.__tnPlaying = true;
    } catch {}
    currentProgramGeneration += 1;
    activeProgramElement = mediaElement;
    broadcastProgramReset(currentProgramGeneration);
  }

  function broadcastProgramReset(generation) {
    for (const session of sessions) {
      sendProgramResetToSession(session, generation);
    }
  }

  function sendProgramResetToSession(session, generation) {
    if (!session || session.lastResetGeneration === generation) return;
    if (session.workletNode?.port) {
      try {
        session.workletNode.port.postMessage({ type: 'reset-program', generation });
        session.lastResetGeneration = generation;
        if (session.pendingResetGeneration === generation) session.pendingResetGeneration = null;
      } catch {}
      return;
    }
    // Worklet not ready: keep a single pending generation per session;
    // never queue duplicates. A newly created worklet is already cold,
    // so a pending reset is harmless.
    if (session.lastResetGeneration !== generation) {
      session.pendingResetGeneration = generation;
    }
  }

  function flushPendingProgramReset(session) {
    if (!session?.workletNode?.port) return;
    let target = session.pendingResetGeneration;
    if (target == null && currentProgramGeneration > 0 && session.lastResetGeneration !== currentProgramGeneration) {
      target = currentProgramGeneration;
    }
    if (target == null || session.lastResetGeneration === target) {
      if (session.pendingResetGeneration === target) session.pendingResetGeneration = null;
      return;
    }
    try {
      session.workletNode.port.postMessage({ type: 'reset-program', generation: target });
      session.lastResetGeneration = target;
    } catch {}
    session.pendingResetGeneration = null;
  }

  // Silence-until-routed guard: while the extension is active, a managed media
  // element is muted synchronously at attach time (before the patched play()
  // reaches the original) so it cannot play un-processed audio at full volume
  // while createMediaElementSource + connect are still pending. The previous
  // muted value is restored once routing is live (source connected to the
  // session input), on any attach error, on STOP/teardown, or by a 1.5 s safety
  // timer — never a permanent mute; on failure the element plays raw as before.
  /** @param {any} mediaElement */
  function armHookGuard(mediaElement) {
    if (mediaElement.__tnGuarding) return;
    guardedMediaElements.add(mediaElement);
    mediaElement.__tnGuardPrevMuted = mediaElement.muted;
    mediaElement.muted = true;
    mediaElement.__tnGuarding = true;
    mediaElement.__tnGuardTimer = trackTimeout(() => restoreHookGuard(mediaElement), HOOK_GUARD_TIMEOUT_MS);
  }

  /**
   * Keep the guard's mute but cancel its safety timer. A stream tap plays the
   * audio through our graph, so the element must stay muted for as long as the
   * route owns the output; `restoreHookGuard` hands the page back on
   * stop/destroy/failure (previous muted value restored).
   * @param {any} mediaElement
   */
  function holdHookGuard(mediaElement) {
    if (!mediaElement || !mediaElement.__tnGuarding) return;
    if (mediaElement.__tnGuardTimer) {
      untrackTimeout(mediaElement.__tnGuardTimer);
      mediaElement.__tnGuardTimer = null;
    }
    mediaElement.muted = true;
  }

  /** @param {any} mediaElement */
  function restoreHookGuard(mediaElement) {
    if (!mediaElement || !mediaElement.__tnGuarding) return;
    if (mediaElement.__tnGuardTimer) {
      untrackTimeout(mediaElement.__tnGuardTimer);
      mediaElement.__tnGuardTimer = null;
    }
    // Guard-window race: restore the pre-guard muted value ONLY while the
    // element is still guard-muted (muted === true from armHookGuard). A mute
    // state the user or page set during the 1.5 s window must never be undone
    // — e.g. unmuting a muted video, or muting-then-unmuting, must survive.
    // Guard bookkeeping is always cleared; only the muted write is gated.
    if (mediaElement.muted === true) {
      mediaElement.muted = mediaElement.__tnGuardPrevMuted;
    }
    delete mediaElement.__tnGuarding;
    delete mediaElement.__tnGuardPrevMuted;
    delete mediaElement.__tnGuardTimer;
    guardedMediaElements.delete(mediaElement);
  }

  function restoreAllHookGuards() {
    for (const mediaElement of Array.from(guardedMediaElements)) {
      restoreHookGuard(mediaElement);
    }
  }

  /** @param {any} stream */
  function stopTracks(stream) {
    try {
      for (const track of stream.getTracks?.() ?? []) {
        try {
          track.stop();
        } catch {}
      }
    } catch {}
  }

  /**
   * Resolve the captureStream audio track. A stream can be created before its
   * track exists (HAVE_NOTHING, or playback not started yet), so wait for
   * `addtrack` or the element's next `playing`, bounded. No mute, no route,
   * nothing is taken from the page while waiting.
   * @param {any} mediaElement
   * @param {any} stream
   * @returns {Promise<any|null>}
   */
  function waitForAudioTrack(mediaElement, stream) {
    const audioTracks = () => {
      const tracks = stream.getAudioTracks?.() ?? [];
      return tracks.length ? tracks[0] : null;
    };
    const ready = audioTracks();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (track) => {
        if (settled) return;
        settled = true;
        untrackListener(stream, 'addtrack', onAddTrack);
        untrackListener(mediaElement, 'playing', onPlaying);
        untrackTimeout(timer);
        resolve(track || null);
      };
      const onAddTrack = (event) => {
        if (event && event.track && event.track.kind && event.track.kind !== 'audio') return;
        finish(audioTracks());
      };
      const onPlaying = () => finish(audioTracks());
      trackListener(stream, 'addtrack', onAddTrack);
      trackListener(mediaElement, 'playing', onPlaying);
      timer = trackTimeout(() => finish(null), STREAM_TRACK_WAIT_MS);
    });
  }

  /**
   * Prove the tap actually carries audio BEFORE muting the element.
   *
   * A CORS-cross-origin element that is not CORS-approved can be captured, but
   * what reaches the graph is silence (mediacapture-fromelement §Security: a
   * MediaStreamAudioSourceNode fed from protected content "produces no
   * information to the document origin"). Muting on the strength of a silent
   * track would reproduce the very mute this change exists to remove, so the
   * stream is measured while the element still plays natively: non-zero peak
   * means the graph will be audible. Silent for the whole window → leave the
   * page native and record a verdict.
   *
   * The analyser is rendered, not read into the void: an AnalyserNode that
   * nothing pulls is not guaranteed to process, and an unrendered analyser
   * reports zeros — which would judge every CORS tap "protected". It is wired
   * through a ZERO-GAIN sink to the destination (the steady-volume silent-sink
   * pattern): rendered every quantum, audible to nobody. The element stays
   * unmuted and the source is not connected to the session while probing, so
   * there is no double.
   * @param {any} context
   * @param {any} source
   * @returns {Promise<boolean>}
   */
  function probeStreamSignal(context, source) {
    if (!context || typeof context.createAnalyser !== 'function'
      || typeof context.createGain !== 'function') {
      return Promise.resolve(true);
    }
    /** @type {any} */
    let analyser = null;
    /** @type {any} */
    let sink = null;
    let torn = false;
    const teardown = () => {
      if (torn) return;
      torn = true;
      try { source.disconnect(analyser); } catch {}
      try { analyser.disconnect(sink); } catch {}
      try { sink.disconnect(context.destination); } catch {}
    };
    try {
      analyser = context.createAnalyser();
      analyser.fftSize = 256;
      sink = context.createGain();
      // Silent sink: the path exists so the analyser is pulled by the render
      // graph, and the gain keeps it inaudible.
      sink.gain.value = 0;
      source.connect(analyser);
      analyser.connect(sink);
      sink.connect(context.destination);
    } catch {
      teardown();
      return Promise.resolve(true);
    }
    const samples = new Float32Array(analyser.fftSize || 256);
    const deadline = Date.now() + STREAM_PROBE_MS;
    return new Promise((resolve) => {
      const tick = () => {
        let peak = 0;
        try {
          analyser.getFloatTimeDomainData(samples);
          for (let i = 0; i < samples.length; i += 1) {
            const value = samples[i] < 0 ? -samples[i] : samples[i];
            if (value > peak) peak = value;
          }
        } catch {}
        if (peak > 0) {
          teardown();
          resolve(true);
          return;
        }
        if (!state.active || Date.now() >= deadline) {
          teardown();
          resolve(false);
          return;
        }
        trackTimeout(tick, 50);
      };
      tick();
    });
  }

  /**
   * Open a captureStream tap: `{ ok: true, stream, source }` or
   * `{ ok: false, reason }` with reason `unavailable | no-track | protected`.
   * Nothing is muted and nothing is connected to the session here.
   * @param {any} mediaElement
   * @param {any} session
   */
  async function openStreamTap(mediaElement, session) {
    if (typeof mediaElement.captureStream !== 'function'
      || !session || typeof session.context.createMediaStreamSource !== 'function') {
      return { ok: false, reason: 'unavailable' };
    }
    let stream = null;
    try {
      stream = mediaElement.captureStream();
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    if (!stream || typeof stream.getAudioTracks !== 'function') {
      stopTracks(stream);
      return { ok: false, reason: 'unavailable' };
    }
    const track = await waitForAudioTrack(mediaElement, stream);
    if (!track) {
      stopTracks(stream);
      return { ok: false, reason: 'no-track' };
    }
    if (track.muted === true) {
      stopTracks(stream);
      return { ok: false, reason: 'protected' };
    }
    let source = null;
    try {
      source = session.context.createMediaStreamSource(stream);
    } catch {
      stopTracks(stream);
      return { ok: false, reason: 'unavailable' };
    }
    if (isCorsCrossOrigin(mediaElement)) {
      const audible = await probeStreamSignal(session.context, source);
      if (!audible) {
        try { source.disconnect(); } catch {}
        stopTracks(stream);
        return { ok: false, reason: 'protected' };
      }
    }
    return { ok: true, stream, source };
  }

  /**
   * Route a proven tap: mute (through the guard) and connect in one synchronous
   * step, so there is never a window with both native and graph audio.
   * @param {any} mediaElement
   * @param {{ stream: any, source: any }} tap
   * @param {any} session
   */
  function routeStream(mediaElement, tap, session) {
    armHookGuard(mediaElement);
    try {
      tap.source.connect(session.inputNode);
    } catch (e) {
      try { tap.source.disconnect(); } catch {}
      stopTracks(tap.stream);
      restoreHookGuard(mediaElement);
      setError(`Stream tap failed: ${(e && e.message) || e}`);
      return;
    }
    holdHookGuard(mediaElement);
    session.sources.add(tap.source);
    session.mediaElements.add(mediaElement);
    // `captured` means "this session owns page media": it keeps the context
    // alive (suspend, never close) so a re-enable is fast.
    session.captured = true;
    try {
      elementSources.set(mediaElement, { kind: 'stream', source: tap.source, session, stream: tap.stream });
      mediaElement.__tnAttached = true;
    } catch {}
    ensureAttachedResumeListeners();
    console.log('[hook] media element attached (stream tap):', mediaElement.tagName);
    reportStatus('HOOK_STATUS');
  }

  /**
   * Give one element back to the page: disconnect the tap, stop its tracks,
   * forget the entry and unmute. A stream tap does NOT steal the element, so
   * this restores native audio immediately — which is what makes "off" native.
   * @param {any} mediaElement
   */
  function detachStreamRoute(mediaElement) {
    const entry = elementSources.get(mediaElement);
    if (!entry || entry.kind !== 'stream') return false;
    try { entry.source.disconnect(); } catch {}
    stopTracks(entry.stream);
    for (const session of Array.from(sessions)) {
      try { session.sources.delete(entry.source); } catch {}
      try { session.mediaElements.delete(mediaElement); } catch {}
    }
    try { elementSources.delete(mediaElement); } catch {}
    try {
      mediaElement.__tnAttached = false;
      delete mediaElement.__tnSource;
    } catch {}
    deferredCaptureElements.delete(mediaElement);
    restoreHookGuard(mediaElement);
    maybeDisarmAttachedResume();
    return true;
  }

  function releaseStreamRoutes() {
    for (const mediaElement of Array.from(guardedMediaElements)) {
      detachStreamRoute(mediaElement);
    }
  }

  // Detach one element: drop only the present-element membership
  // (session.mediaElements) and `__tnAttached` so a replay re-attaches.
  // An ELEMENT-SOURCE route (the captureStream fallback) is the one that steals
  // the element, so its source stays connected and its cache entry is kept: a
  // re-insert reuses the SAME source (a second createMediaElementSource on one
  // element throws). A stream tap is detached for real (see detachStreamRoute).
  /** @param {any} mediaElement */
  function detachMediaElement(mediaElement) {
    if (!mediaElement) return;
    if (detachStreamRoute(mediaElement)) return;
    for (const session of Array.from(sessions)) {
      if (!session.mediaElements.has(mediaElement)) continue;
      session.mediaElements.delete(mediaElement);
      maybeCloseIdleMediaSession(session);
      maybeDisarmAttachedResume();
    }
    try {
      mediaElement.__tnAttached = false;
    } catch {}
    try {
      deferredCaptureElements.delete(mediaElement);
    } catch {}
  }

  // Forget sessions whose contexts closed: they route nothing and their
  // source sets would otherwise pin removed elements forever.
  function pruneClosedSessions() {
    for (const session of Array.from(sessions)) {
      try {
        if (session.context.state === 'closed') {
          teardownSession(session);
        }
      } catch {}
    }
  }

  // Deferred capture: elements skipped while the context is suspended
  // re-attempt once on the next user gesture or play event. Never more
  // than one pending retry per element; dropped when the site disables.
  const deferredCaptureElements = new Set();
  function queueDeferredCapture(mediaElement) {
    if (!mediaElement || deferredCaptureElements.has(mediaElement)) return;
    deferredCaptureElements.add(mediaElement);
    const retry = () => {
      if (!deferredCaptureElements.has(mediaElement)) return;
      deferredCaptureElements.delete(mediaElement);
      untrackListener(mediaElement, 'play', retry);
      untrackListener(mediaElement, 'playing', retry);
      if (!state.active) return;
      void attachMediaElement(mediaElement, { fromPlay: true });
    };
    trackElementListener(mediaElement, 'play', retry);
    trackElementListener(mediaElement, 'playing', retry);
    const gestureRetry = () => {
      if (!deferredCaptureElements.has(mediaElement)) {
        untrackListener(document, 'click', gestureRetry);
        untrackListener(document, 'pointerdown', gestureRetry);
        untrackListener(document, 'keydown', gestureRetry);
        return;
      }
      deferredCaptureElements.delete(mediaElement);
      untrackListener(document, 'click', gestureRetry);
      untrackListener(document, 'pointerdown', gestureRetry);
      untrackListener(document, 'keydown', gestureRetry);
      untrackListener(mediaElement, 'play', retry);
      untrackListener(mediaElement, 'playing', retry);
      if (!state.active) return;
      void attachMediaElement(mediaElement, { fromPlay: true });
    };
    trackListener(document, 'click', gestureRetry);
    trackListener(document, 'pointerdown', gestureRetry);
    trackListener(document, 'keydown', gestureRetry);
  }

  /**
   * Route one media element.
   *
   * Order: a stream tap (captureStream) first — it does NOT steal the element,
   * so off/stop can hand native audio back by disconnecting and unmuting. The
   * element-source fallback exists only for engines without captureStream, and
   * never for page-owned/DRM/srcObject media.
   * @param {any} mediaElement
   * @param {{ fromPlay?: boolean }} [options]
   */
  async function attachMediaElement(mediaElement, options) {
    const fromPlay = Boolean(options && options.fromPlay);
    if (!state.active || !isMediaElement(mediaElement) || /** @type {any} */ (mediaElement).__tnAttached) return;
    if (/** @type {any} */ (mediaElement).__tnGuarding) return;
    if (attachingElements.has(mediaElement)) return;

    let cached = elementSources.get(mediaElement);
    if (cached && cached.kind === 'stream') {
      // A stream route never survives a stop; capture a fresh one.
      detachStreamRoute(mediaElement);
      cached = undefined;
    }
    const cachedSource = cached && cached.source
      ? cached.source
      : (cached && typeof cached.connect === 'function' ? cached : null);

    if (!cachedSource) {
      // A paused/preloaded feed item is never captured: the play() patch and the
      // observer pick it up when it actually plays.
      if (!fromPlay && !isPlayingMedia(mediaElement)) return;
      const reason = unroutableReason(mediaElement);
      if (reason) {
        noteUnroutable(mediaElement, reason);
        return;
      }
      if (routedMediaCount() + pendingAttachCount >= MAX_ROUTED_MEDIA) {
        noteUnroutable(mediaElement, 'cap');
        return;
      }
    }

    watchProgramBoundaries(mediaElement);
    attachingElements.add(mediaElement);
    pendingAttachCount += 1;

    try {
      const session = await ensureMediaSession();
      await resumeWithTimeout(session.context, RESUME_TIMEOUT_MS);
      // A stop landing mid-attach must not capture, connect or re-arm the
      // resume listeners after the sweep: leave the element as the page has it.
      if (!state.active) {
        restoreHookGuard(mediaElement);
        return;
      }
      if (!session || session.context.state !== 'running') {
        // Routing into a suspended context is silence, and a stream tap into
        // one is pointless: keep the element native and retry on a gesture.
        restoreHookGuard(mediaElement);
        try { mediaElement.__tnAttached = false; } catch {}
        queueDeferredCapture(mediaElement);
        ensureAttachedResumeListeners();
        return;
      }
      if (cachedSource) {
        attachCachedElementSource(mediaElement, cached, cachedSource, session);
        return;
      }

      const tap = await openStreamTap(mediaElement, session);
      if (tap.ok) {
        routeStream(mediaElement, /** @type {any} */ (tap), session);
        return;
      }
      if (tap.reason === 'no-track') {
        // No audio track yet: nothing was muted or connected. Retry when the
        // element plays again.
        queueDeferredCapture(mediaElement);
        return;
      }
      if (tap.reason === 'protected') {
        noteUnroutable(mediaElement, 'protected');
        return;
      }
      // captureStream is unavailable: the legacy element source, but never for
      // media whose graph output would be silence.
      if (isCorsCrossOrigin(mediaElement)) {
        noteUnroutable(mediaElement, 'protected');
        return;
      }
      await attachElementSource(mediaElement, session);
    } catch (e) {
      restoreHookGuard(mediaElement);
      console.error('[hook] attachMediaElement failed:', e.message || e);
      setError(`Attach media failed: ${e.message || e}`);
    } finally {
      pendingAttachCount = Math.max(0, pendingAttachCount - 1);
      attachingElements.delete(mediaElement);
    }
  }

  /**
   * Reconnect a cached element-source route (the fallback path, after a DOM
   * remove/re-insert). The source was never released, so no re-capture.
   * @param {any} mediaElement
   * @param {any} cachedEntry
   * @param {any} cachedSource
   * @param {any} session
   */
  function attachCachedElementSource(mediaElement, cachedEntry, cachedSource, session) {
    try {
      let owner = session;
      try {
        const s = cachedEntry && cachedEntry.session;
        if (s && s.context && s.context.state !== 'closed' && s.inputNode) owner = s;
      } catch {}
      const target = (owner && owner.inputNode) || (session && session.inputNode);
      try { if (target) cachedSource.connect(target); } catch {}
      try {
        if (owner) {
          owner.sources.add(cachedSource);
          owner.mediaElements.add(mediaElement);
        }
      } catch {}
      mediaElement.__tnAttached = true;
      ensureAttachedResumeListeners();
      console.log('[hook] media element re-attached (cached source):', mediaElement.tagName);
      reportStatus('HOOK_STATUS');
    } catch (e) {
      restoreHookGuard(mediaElement);
      console.error('[hook] attachCachedElementSource failed:', e.message || e);
      setError(`Attach media failed: ${e.message || e}`);
    }
  }

  /**
   * The legacy route: `createMediaElementSource`. It permanently steals the
   * element's output, so it is used only when captureStream is unavailable, and
   * the context must already be running.
   * @param {any} mediaElement
   * @param {any} session
   */
  async function attachElementSource(mediaElement, session) {
    armHookGuard(mediaElement);
    try {
      state.internalWiring = true;
      let source = null;
      try {
        source = session.context.createMediaElementSource(mediaElement);
      } finally {
        state.internalWiring = false;
      }
      try { source.connect(session.inputNode); } catch {}
      try {
        /** @type {any} */ (mediaElement).__tnSource = source;
        elementSources.set(mediaElement, { kind: 'element', source, session });
      } catch {}
      session.sources.add(source);
      session.captured = true;
      // The element source owns the output, so the guard is not needed.
      restoreHookGuard(mediaElement);
      mediaElement.__tnAttached = true;
      session.mediaElements.add(mediaElement);
      ensureAttachedResumeListeners();
      console.log('[hook] media element attached (element source):', mediaElement.tagName);
      reportStatus('HOOK_STATUS');
    } catch (e) {
      restoreHookGuard(mediaElement);
      if (e instanceof DOMException && e.name === 'InvalidStateError') {
        // The page (or a previous hook instance) already owns this element's
        // only source. Record it and leave it alone — unmuted, untouched, and
        // unprocessed until a reload rebuilds the page.
        mediaElement.__tnWebAudio = true;
        unmanagedMediaElements.add(mediaElement);
        console.log('[hook] media element already connected to another source, left unprocessed');
      } else {
        console.error('[hook] attachMediaElement failed:', e.message || e);
        setError(`Attach media failed: ${e.message || e}`);
      }
    }
  }

  async function recoverAudio() {
    scanExistingContexts();
    pruneClosedSessions();

    for (const session of Array.from(sessions)) {
      if (session.context.state === 'closed') {
        teardownSession(session);
        continue;
      }

      await resumeWithTimeout(session.context, RESUME_TIMEOUT_MS);

      if (session.readyResolved && !session.workletNode) {
        attachWorklet(session);
      }
    }

    attachExistingMediaElements();
    routeSessions();
    reportStatus('HOOK_STATUS');
  }

  function scheduleRecoveryBurst() {
    if (!state.active || recoveryBurstTimer) return;

    recoveryBurstRemaining = RECOVERY_BURST_COUNT;

    const tick = async () => {
      recoveryBurstTimer = null;

      if (!state.active) {
        recoveryBurstRemaining = 0;
        return;
      }

      try {
        await recoverAudio();
      } catch {}

      recoveryBurstRemaining -= 1;
      if (state.active && recoveryBurstRemaining > 0) {
        recoveryBurstTimer = trackTimeout(tick, RECOVERY_BURST_MS);
      } else {
        recoveryBurstRemaining = 0;
      }
    };

    recoveryBurstTimer = trackTimeout(tick, 0);
  }

  function clearRecoveryBurst() {
    if (recoveryBurstTimer) {
      clearTimeout(recoveryBurstTimer);
      recoveryBurstTimer = null;
    }
    recoveryBurstRemaining = 0;
  }

  function teardownSession(session) {
    try {
      if (session.workletNode) {
        session.workletNode.disconnect();
      }
    } catch {}

    // Teardown runs only for contexts that never captured or are already
    // closed (captured sessions suspend instead and never reach here via
    // idle): disconnect every element source and drop the strong
    // references so dead contexts can be collected; elements that
    // are still in the document re-attach on the next recovery pass.
    for (const source of Array.from(session.sources)) {
      try { source.disconnect(); } catch {}
    }
    session.sources.clear();
    for (const mediaElement of session.mediaElements) {
      restoreHookGuard(mediaElement);
      try {
        mediaElement.__tnAttached = false;
      } catch {}
    }
    session.mediaElements.clear();

    sessions.delete(session);
    contextSessions.delete(session.context);

    if (mediaSessions.get(document) === session) {
      mediaSessions.delete(document);
    }
    try {
      maybeDisarmAttachedResume();
    } catch {}
  }

  function setError(message) {
    state.lastError = String(message || 'Unknown normalizer error.');
    reportStatus('HOOK_ERROR');
  }

  /**
   * Status is answered synchronously through the dispatcher (`status()`).
   * Nothing is posted to the page: the old `window.postMessage` report was half
   * of the page-reachable control channel.
   */
  function reportStatus(type) {
    if (type === 'HOOK_STATUS') {
      // Re-assert the live worklet gains from `state.gainDb` on every status
      // report, so a drifted worklet is corrected at once.
      updateSessionGains();
    }
  }

  /**
   * Put the page back the way it was: patched prototypes and constructors are
   * restored, so a disposed instance leaves no half-patched globals and a
   * re-injected instance installs on a clean page.
   */
  function restorePatchedPrototypes() {
    try {
      AudioNode.prototype.connect = originalConnect;
      delete AudioNode.prototype.__tnConnect;
    } catch {}
    try {
      HTMLMediaElement.prototype.play = originalPlay;
      delete HTMLMediaElement.prototype.__tnPlay;
    } catch {}
    try {
      AudioContext.prototype.createMediaElementSource = originalCreateMediaElementSource;
    } catch {}
    try {
      if (patchedConstructorOriginals.AudioContext) {
        window.AudioContext = patchedConstructorOriginals.AudioContext;
      }
      if (patchedConstructorOriginals.OfflineAudioContext) {
        window.OfflineAudioContext = patchedConstructorOriginals.OfflineAudioContext;
      }
      if (patchedConstructorOriginals.webkitAudioContext) {
        window.webkitAudioContext = patchedConstructorOriginals.webkitAudioContext;
      }
    } catch {}
  }

  function isHookActive() {
    if (!state.active) return false;
    for (const session of sessions) {
      if (session.workletNode && session.context.state !== 'closed') {
        return true;
      }
    }
    return false;
  }

  function isMediaElement(node) {
    return node instanceof HTMLMediaElement;
  }

  function normalizeGainDb(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, Math.round(numeric * 2) / 2));
  }

})();
