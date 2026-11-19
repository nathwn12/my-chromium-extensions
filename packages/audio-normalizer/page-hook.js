(() => {
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
    let id = 0;
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
  /** @type {string} */
  let pinnedWorkletOrigin = '';
  /** @param {unknown} value */
  function isValidWorkletUrl(value) {
    if (typeof value !== 'string' || !pinnedWorkletOrigin) return false;
    /** @type {URL | null} */
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
    /** @type {string | null} */
    let value = null;
    try {
      value = document.documentElement?.getAttribute(WORKLET_ATTR);
    } catch { value = null; }
    try {
      document.documentElement?.removeAttribute(WORKLET_ATTR);
    } catch {}
    const ok = typeof value === 'string'
      && value.startsWith('chrome-extension://')
      && value.endsWith(WORKLET_SUFFIX);
    return ok ? value : null;
  }
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
  /** @type {{ AudioContext?: any, OfflineAudioContext?: any, webkitAudioContext?: any }} */
  const patchedConstructorOriginals = {};

  const sessions = new Set();
  const contextSessions = new WeakMap();
  const mediaSessions = new WeakMap();
  /** @type {ReturnType<typeof createMediaSession> | null} */
  let mediaSessionPromise = null;
  const guardedMediaElements = new Set();
  const unmanagedMediaElements = new Set();
  /** @type {ReturnType<typeof trackTimeout> | null} */
  let recoveryBurstTimer = null;
  let recoveryBurstRemaining = 0;
  let recoveryBurstRunning = false;

  const elementProgramGenerations = new WeakMap();
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

  if (globalThis.__tabNormalizerFrameGate?.excluded === true) {
    return;
  }

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
    if (action === 'stop') {
      stop();
      return status();
    }
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
            detachMediaElement(mediaElement);
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
  }

  function status() {
    return {
      ok: true,
      alive: true,
      active: isHookActive(),
      gainDb: state.gainDb,
      error: state.lastError,
      unprocessed: unmanagedMediaElements.size,
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

  /** @type {ReturnType<typeof trackTimeout> | null} */
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
    attachExistingMediaElements();
    rewatchAttachedMediaElements();
    routeSessions();
    updateSessionGains();
    notifySessionStarts();
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
    state.stopped = true;
    clearRecoveryBurst();
    console.log('[hook] stopping');
    restoreAllHookGuards();

    for (const session of sessions) {
      bypassSession(session);
    }

    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }

    for (const session of Array.from(sessions)) {
      maybeCloseIdleMediaSession(session);
    }
    try {
      deferredCaptureElements.clear();
    } catch {}
    maybeDisarmAttachedResume();

    unbindLifecycleListeners();
    untrackTimeout(lifecycleTimer);
    lifecycleTimer = null;
    teardownElementListeners();
    untrackListeners((entry) => entry.keepOnStop === true);
    if (attachedResumeArmed) {
      attachedResumeArmed = false;
      untrackListener(document, 'play', resumeAttachedSessions, true);
      untrackListener(document, 'playing', resumeAttachedSessions, true);
    }
    untrackAllTimers();

    reportStatus('HOOK_STOPPED');
  }

  function maybeCloseIdleMediaSession(session) {
    if (!session || session.kind !== 'media') return;
    if (session.captured) {
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

    const knownKeys = ['audioCtx', 'audioContext', 'ctx', 'context', 'actx', 'ac'];
    for (const key of knownKeys) {
      try {
        const val = window[key];
        if (val && typeof val === 'object') candidates.add(val);
      } catch {}
    }

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

    AudioNode.prototype.connect = function (dest, out = undefined, inp = undefined) {
      if (!state.internalWiring && state.active && this.context && dest === this.context.destination) {
        const s = ensureContextSession(this.context);
        if (s) return originalConnect.call(this, s.inputNode, out, inp);
      }
      return originalConnect.call(this, dest, out, inp);
    };
  }

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
      /** @type {ReturnType<typeof beginPlayAttempt> | null} */
      let attempt = null;
      if (managed) {
        watchProgramBoundaries(this);
        attempt = beginPlayAttempt(this);
        void attachMediaElement(this);
      }
      let started;
      try {
        started = originalPlay.apply(this, args);
      } catch (err) {
        if (attempt) finishPlayAttempt(this, attempt, false);
        throw err;
      }
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
      if (el && !state.internalWiring) el.__tnWebAudio = true;
      return originalCreateMediaElementSource.call(this, el);
    };
  }

  function observeDom() {
    patchAttachShadow();
    if (state.observer) {
      scanShadowRoots();
      return;
    }

    /** @type {ReturnType<typeof trackTimeout> | null} */
    let observerTimer = null;
    let pendingBatches = [];
    const MAX_MUTATIONS_PER_FLUSH = 200;

    function flushMutations() {
      observerTimer = null;
      const batch = pendingBatches.slice(0, MAX_MUTATIONS_PER_FLUSH);
      pendingBatches = pendingBatches.slice(batch.length);
      for (const m of batch) {
        for (const node of m.removedNodes ?? []) {
          try {
            if (!(node instanceof Element)) continue;
            if (isMediaElement(node)) {
              detachMediaElement(node);
            }
            for (const media of node.querySelectorAll?.('audio, video') ?? []) {
              detachMediaElement(media);
            }
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

  /** @param {any} root */
  function observeShadowRoot(root) {
    if (!root) return;
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
    try {
      const hosts = document.querySelectorAll?.('*') ?? [];
      for (const el of hosts) {
        if (el.shadowRoot) observeShadowRoot(el.shadowRoot);
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
    for (const media of document.querySelectorAll('audio, video')) {
      void attachMediaElement(media);
    }
    scanShadowRoots();
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
    trackListener(context, 'statechange', () => {
      if (!sessions.has(session) || session.context !== context) return;
      if (!state.active) return;
      if (context.state === 'closed') {
        setError('Audio context closed. Reconnecting…');
        teardownSession(session);
        void recoverAudio();
        return;
      }
      if (context.state === 'running') {
        session.suspensionRecoveryPending = false;
        if (state.lastError === 'Audio context remains suspended. Resume playback to restore audio.') {
          state.lastError = '';
        }
      }
      if (context.state === 'suspended' && session.mediaElements.size > 0
        && !session.suspensionRecoveryPending) {
        session.suspensionRecoveryPending = true;
        scheduleRecoveryBurst();
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
      suspensionRecoveryPending: false,
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

  /** @param {any} mediaElement */
  function watchProgramBoundaries(mediaElement) {
    if (!mediaElement || mediaElement.__tnProgramWatched) return;
    mediaElement.__tnProgramWatched = true;
    try {
      trackElementListener(mediaElement, 'loadstart', () => markProgramDirty(mediaElement));
      trackElementListener(mediaElement, 'emptied', () => {
        markProgramDirty(mediaElement);
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

  /** @param {any} mediaElement */
  function armHookGuard(mediaElement) {
    if (mediaElement.__tnGuarding) return;
    guardedMediaElements.add(mediaElement);
    mediaElement.__tnGuardPrevMuted = mediaElement.muted;
    mediaElement.muted = true;
    mediaElement.__tnGuarding = true;
    mediaElement.__tnGuardTimer = trackTimeout(() => restoreHookGuard(mediaElement), HOOK_GUARD_TIMEOUT_MS);
  }

  /** @param {any} mediaElement */
  function restoreHookGuard(mediaElement) {
    if (!mediaElement || !mediaElement.__tnGuarding) return;
    if (mediaElement.__tnGuardTimer) {
      untrackTimeout(mediaElement.__tnGuardTimer);
      mediaElement.__tnGuardTimer = null;
    }
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

  /** @param {any} mediaElement */
  function detachMediaElement(mediaElement) {
    if (!mediaElement) return;
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

  function pruneClosedSessions() {
    for (const session of Array.from(sessions)) {
      try {
        if (session.context.state === 'closed') {
          teardownSession(session);
        }
      } catch {}
    }
  }

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
      void attachMediaElement(mediaElement);
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
      void attachMediaElement(mediaElement);
    };
    trackListener(document, 'click', gestureRetry);
    trackListener(document, 'pointerdown', gestureRetry);
    trackListener(document, 'keydown', gestureRetry);
  }

  /** @param {any} mediaElement */
  async function attachMediaElement(mediaElement) {
    if (!state.active || !isMediaElement(mediaElement) || mediaElement.__tnAttached) return;
    const cachedEntry = elementSources.get(mediaElement);
    const cachedSource = cachedEntry && cachedEntry.source
      ? cachedEntry.source
      : (cachedEntry && typeof cachedEntry.connect === 'function' ? cachedEntry : null);
    if (cachedSource) {
      watchProgramBoundaries(mediaElement);
      if (/** @type {any} */ (mediaElement).__tnGuarding) return;
      armHookGuard(mediaElement);
      try {
        const session = await ensureMediaSession();
        await resumeWithTimeout(session.context, RESUME_TIMEOUT_MS);
        if (!state.active) {
          restoreHookGuard(mediaElement);
          return;
        }
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
        restoreHookGuard(mediaElement);
        mediaElement.__tnAttached = true;
        ensureAttachedResumeListeners();
        console.log('[hook] media element attached:', mediaElement.tagName, mediaElement.src?.slice(0, 60));
        reportStatus('HOOK_STATUS');
      } catch (e) {
        restoreHookGuard(mediaElement);
        console.error('[hook] attachMediaElement failed:', e.message || e);
        setError(`Attach media failed: ${e.message || e}`);
      }
      return;
    }
    if (mediaElement.__tnWebAudio) return;
    watchProgramBoundaries(mediaElement);
    if (/** @type {any} */ (mediaElement).__tnGuarding) return;
    armHookGuard(mediaElement);

    try {
      const session = await ensureMediaSession();
      await resumeWithTimeout(session.context, RESUME_TIMEOUT_MS);
      if (!state.active) {
        restoreHookGuard(mediaElement);
        return;
      }
      if (!session || session.context.state !== 'running') {
        restoreHookGuard(mediaElement);
        try {
          mediaElement.__tnAttached = false;
        } catch {}
        queueDeferredCapture(mediaElement);
        ensureAttachedResumeListeners();
        return;
      }
      {
        state.internalWiring = true;
        /** @type {MediaElementAudioSourceNode} */
        let source;
        try {
          source = session.context.createMediaElementSource(mediaElement);
        } finally {
          state.internalWiring = false;
        }
        try { source.connect(session.inputNode); } catch {}
        try {
          /** @type {any} */ (mediaElement).__tnSource = source;
          elementSources.set(mediaElement, { source, session });
        } catch {}
        session.sources.add(source);
        session.captured = true;
      }
      restoreHookGuard(mediaElement);
      mediaElement.__tnAttached = true;
      session.mediaElements.add(mediaElement);
      ensureAttachedResumeListeners();
      console.log('[hook] media element attached:', mediaElement.tagName, mediaElement.src?.slice(0, 60));
      reportStatus('HOOK_STATUS');
    } catch (e) {
      restoreHookGuard(mediaElement);
      if (e instanceof DOMException && e.name === 'InvalidStateError') {
        mediaElement.__tnWebAudio = true;
        unmanagedMediaElements.add(mediaElement);
        console.log('[hook] media element already connected to another source, left unprocessed until reload');
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
      if (session.context.state === 'running') {
        session.suspensionRecoveryPending = false;
      }

      if (session.readyResolved && !session.workletNode) {
        attachWorklet(session);
      }
    }

    attachExistingMediaElements();
    routeSessions();
    reportStatus('HOOK_STATUS');
  }

  function scheduleRecoveryBurst() {
    if (!state.active || recoveryBurstTimer || recoveryBurstRunning) return;

    recoveryBurstRemaining = RECOVERY_BURST_COUNT;

    const tick = async () => {
      recoveryBurstTimer = null;

      if (!state.active) {
        recoveryBurstRemaining = 0;
        return;
      }

      recoveryBurstRunning = true;
      try {
        await recoverAudio();
      } catch {}
      recoveryBurstRunning = false;

      recoveryBurstRemaining -= 1;
      if (state.active && recoveryBurstRemaining > 0) {
        recoveryBurstTimer = trackTimeout(tick, RECOVERY_BURST_MS);
      } else {
        if (state.active && Array.from(sessions).some((session) => (
          session.suspensionRecoveryPending && session.context.state === 'suspended'
        ))) {
          setError('Audio context remains suspended. Resume playback to restore audio.');
        }
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
    recoveryBurstRunning = false;
  }

  function teardownSession(session) {
    try {
      if (session.workletNode) {
        session.workletNode.disconnect();
      }
    } catch {}

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
