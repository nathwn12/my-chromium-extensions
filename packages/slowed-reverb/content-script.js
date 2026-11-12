(() => {
  const existing = globalThis.__slowedReverbAudioContent;

  // A reloaded/updated extension leaves the previous instance in this isolated
  // world with a dead chrome.runtime. Adopting it via refresh() keeps a zombie
  // that can never message the new worker; only adopt a live instance.
  function runtimeAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  if (existing && typeof existing.refresh === 'function' && runtimeAlive()) {
    existing.refresh();
    return;
  }
  if (existing && typeof existing.retire === 'function') {
    try {
      existing.retire();
    } catch {
      // A dead instance may fail to hand back the element; install anyway.
    }
  }

  const {
    getDefaultSettings,
    isNeutral,
    normalizeSettings,
  } = globalThis.SlowedReverbShared;

  const state = {
    settings: getDefaultSettings(),
    bypass: false,
    eligible: false,
    media: new Map(),
    observer: null,
    safetyPollTimer: null,
    scanQueued: false,
    hookRefreshQueued: false,
    context: null,
    listenersReady: false,
    lifecycleListenersReady: false,
    pageHookReady: false,
    pageHookToken: '',
    lastError: '',
    workletLoaded: false,
    workletRetryCount: 0,
    workletLastRetry: 0,
    lastNonzeroIntensity: 0,
    retired: false,
  };

  globalThis.__slowedReverbAudioContent = {
    refresh() {
      queueScan();
      void bootstrap(false);
    },
    __testGetHookToken() {
      return state.pageHookToken;
    },
    __testIsHookReady() {
      return state.pageHookReady;
    },
    __testSetHookReady(value) {
      state.pageHookReady = Boolean(value);
    },
    __testIsRetired() {
      return state.retired;
    },
    retire() {
      if (state.retired) return;
      state.retired = true;
      clearSafetyPoll();
      stopRateWatchdog();
      stopPlayerActions();
      if (recoveryTimer) {
        clearTimeout(recoveryTimer);
        recoveryTimer = null;
      }
      if (state.observer) {
        try {
          state.observer.disconnect();
        } catch {
          // Already disconnected.
        }
        state.observer = null;
      }
      for (const controller of [...state.media.values()]) {
        try {
          teardownController(controller, true, state.context);
        } catch {
          // Best effort: a dead instance may not own the element any more.
        }
      }
      state.media.clear();
      if (state.context) {
        try {
          void state.context.close();
        } catch {
          // Already closed.
        }
        state.context = null;
        state.workletLoaded = false;
      }
    },
  };

  void bootstrap(true);

  async function bootstrap(ensureHooks) {
    mintPageHookToken();
    ensureGlobalListeners();
    ensureLifecycleListeners();
    ensureObserver();
    if (ensureHooks) {
      void requestHookRefresh('bootstrap');
    }
    queueScan();

    try {
      const runtime = await chrome.runtime.sendMessage({ type: 'GET_TAB_RUNTIME_STATE' });
      applyRuntimeState(runtime);
    } catch {
      state.lastError = 'Runtime unavailable.';
      queueRecovery('bootstrap');
      syncAllMedia();
    }
  }

  function ensureGlobalListeners() {
    if (state.listenersReady) return;

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === 'SLRA_PAGE_REVIVE') {
        queueRecovery(message.reason || 'page-hook');
        sendResponse({ ok: true });
        return false;
      }

      if (message?.type === 'APPLY_TAB_STATE') {
        applyRuntimeState(message);
        sendResponse({ ok: true });
        return false;
      }

      if (message?.type === 'APPLY_LIVE_SETTINGS') {
        state.settings = normalizeSettings({ ...state.settings, ...(message.settings || {}) });
        if (state.settings.reverbIntensity > 0) {
          state.lastNonzeroIntensity = state.settings.reverbIntensity;
        }
        state.lastError = '';
        syncAllMedia();
        sendResponse({ ok: true, settings: state.settings, status: getLiveStatus() });
        return false;
      }

      if (message?.type === 'GET_LIVE_STATUS') {
        sendResponse(getLiveStatus());
        return false;
      }

      if (message?.type === 'TOGGLE_CHANGED') {
        applyRuntimeState({ bypass: !message.enabled, eligible: state.eligible });
        sendResponse({ ok: true });
        return false;
      }

      return false;
    });

    document.addEventListener('play', (event) => {
      const media = event.target;
      if (!(media instanceof HTMLMediaElement)) return;
      const controller = trackMedia(media);
      // A fresh playback start gets a fresh mute-correction budget; a page that
      // fought the last track must not leave the next one permanently unmuted.
      resetMuteDampener(controller);
      // The addModule ladder is per playback, not per page lifetime.
      state.workletRetryCount = 0;
      syncMediaController(controller);
      const generation = controller.generation;
      void resumeContext().then(() => {
        if (generation !== controller.generation) return;
        syncMediaController(controller);
      });
    }, true);

    document.addEventListener('playing', (event) => {
      const media = event.target;
      if (!(media instanceof HTMLMediaElement)) return;
      trackMedia(media);
      const staleController = state.media.get(media);
      const playingGeneration = staleController ? staleController.generation : 0;
      void resumeContext().then(() => {
        const current = state.media.get(media);
        if (!current || playingGeneration !== current.generation) return;
        syncMediaController(current);
      });
    }, true);

    ['pointerdown', 'keydown', 'mousedown', 'touchstart'].forEach((eventName) => {
      window.addEventListener(eventName, () => {
        void resumeContext().then(() => {
          syncAllMedia();
        });
      }, { passive: true, capture: true });
    });

    document.addEventListener('pause', () => {
      queueMicrotask(() => {
        try {
          maybeSuspendContext();
        } catch {
          // Best effort only.
        }
      });
    }, true);

    state.listenersReady = true;
  }

  function ensureLifecycleListeners() {
    if (state.lifecycleListenersReady) return;

    const revive = (reason) => queueRecovery(reason);

    window.addEventListener('pageshow', () => revive('pageshow'), { passive: true });
    window.addEventListener('focus', () => revive('focus'), { passive: true });
    window.addEventListener('popstate', () => revive('popstate'), { passive: true });
    window.addEventListener('hashchange', () => revive('hashchange'), { passive: true });
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') revive('visibilitychange');
    }, { passive: true });

    window.addEventListener('pagehide', () => {
      clearSafetyPoll();
      stopRateWatchdog();
      try {
        maybeSuspendContext();
      } catch {
        // Best effort only.
      }
    }, { passive: true });

    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      try {
        if (event.origin !== location.origin) return;
      } catch {
        return;
      }
      const data = event.data;
      if (!data || data.__slra !== true) return;

      if (data.type === 'SLRA_PAGE_REVIVE') {
        const now = Date.now();
        if (now - lastPageMessageRecovery >= 1000) {
          lastPageMessageRecovery = now;
          queueRecovery(data.reason || 'page-hook');
        }
      }

      if (data.type === 'SLRA_PAGE_HOOK_READY') {
        if (typeof data.token !== 'string' || data.token.length === 0) return;
        if (data.token !== state.pageHookToken) return;
        state.pageHookReady = true;
      }

      if (data.type === 'SLRA_VOLUME_STATE') {
        if (typeof data.token !== 'string' || data.token.length === 0) return;
        if (data.token !== state.pageHookToken) return;
        resolvePageVolume(data.id, {
          volume: data.volume,
          applied: data.applied === true,
          source: data.source || 'none',
        });
      }
    });

    ['yt-navigate-start', 'yt-navigate-finish', 'yt-page-data-updated', 'spfdone'].forEach((eventName) => {
      window.addEventListener(eventName, () => revive(eventName), true);
    });

    state.lifecycleListenersReady = true;
  }

  function ensureObserver() {
    if (state.observer) return;

    // Fast path: react only to media adds/removes on the next microtask via
    // queueScan (which coalesces with scanQueued, so a DOM storm schedules at
    // most one scan). Unrelated mutations are ignored; the slow safety poll
    // below is the backstop for a missed record.
    state.observer = new MutationObserver((records) => {
      if (!isMediaMutation(records)) return;
      queueScan();
    });

    const root = document.documentElement || document;
    state.observer.observe(root, { childList: true, subtree: true });
    ensureSafetyPoll();
  }

  function isMediaNode(node) {
    if (!node) return false;
    if (node instanceof HTMLMediaElement) return true;
    const tag = node.tagName;
    if (typeof tag === 'string') {
      const upper = tag.toUpperCase();
      if (upper === 'VIDEO' || upper === 'AUDIO') return true;
    }
    // Subtree add: a wrapper DIV whose descendants contain media.
    if (typeof node.querySelectorAll === 'function') {
      try {
        if (node.querySelectorAll('audio,video').length > 0) return true;
      } catch {
        // Non-element subtree; fall through.
      }
    }
    return false;
  }

  function isMediaMutation(records) {
    for (const record of records || []) {
      for (const node of record.addedNodes || []) {
        if (isMediaNode(node)) return true;
      }
      for (const node of record.removedNodes || []) {
        if (isMediaNode(node)) return true;
      }
    }
    return false;
  }

  function ensureSafetyPoll() {
    if (state.safetyPollTimer !== null) return;
    state.safetyPollTimer = setInterval(() => {
      queueScan();
    }, 5000);
  }

  function clearSafetyPoll() {
    if (state.safetyPollTimer !== null) {
      clearInterval(state.safetyPollTimer);
      state.safetyPollTimer = null;
    }
  }

  // chrome.runtime.getURL throws once the extension is reloaded and this content
  // script is an orphan. Resolve it through one guarded read so no timer tick can
  // throw and abandon the rest of its work.
  function workletUrl() {
    try {
      return chrome.runtime.getURL('dattorro-worklet.js');
    } catch {
      return '';
    }
  }

  function mintPageHookToken() {
    let token = '';
    try {
      const bytes = new Uint8Array(16);
      if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
        globalThis.crypto.getRandomValues(bytes);
        token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      }
    } catch {
      token = '';
    }
    if (!token) {
      token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
    state.pageHookToken = token;
    try {
      if (document && document.documentElement && document.documentElement.dataset) {
        document.documentElement.dataset.slraToken = token;
      }
    } catch {
      // Best effort only.
    }
    return token;
  }

  function maybeSuspendContext() {
    if (!state.context || state.context.state !== 'running') return;
    if (typeof state.context.suspend !== 'function') return;
    for (const controller of state.media.values()) {
      // "Idle" means nothing is playing. A detached-but-playing element (retry,
      // cool-down, source swap) is real playback: suspending there turns a
      // recoverable stall into seconds of silence.
      if (controller.media && !controller.media.paused && !controller.media.ended) {
        return;
      }
    }
    try {
      void Promise.resolve(state.context.suspend()).catch(() => {
        // Best effort only.
      });
    } catch {
      // Best effort only.
    }
  }

function applyRuntimeState(runtime) {
  if (runtime && runtime.ok === false) return;
  state.eligible = Boolean(runtime?.eligible !== false);
  state.bypass = Boolean(runtime?.bypass);
  if (runtime?.settings !== undefined) {
    state.settings = normalizeSettings(runtime.settings);
    if (state.settings.reverbIntensity > 0) {
      state.lastNonzeroIntensity = state.settings.reverbIntensity;
    }
  }
  state.lastError = '';
    syncAllMedia();
  }

  // Mute invariant: media.muted === attached. The element's own output is
  // suppressed for as long as this controller owns a graph; the graph renders
  // the captured stream. Gain invariant: masterGain carries media.volume only
  // while attached && !sourceStale; a stale or budget-parked graph is
  // hard-zeroed, so the page's own output is never doubled. A source swap is
  // therefore muted end to end: hardZero -> confirm muted -> connect -> ramp.
  function isAudible(controller) {
    return Boolean(controller && controller.attached);
  }

  // Stale-attach guard: bumped on every teardown/stale transition; async
  // continuations capture controller.generation and return early on mismatch,
  // so a resolve after teardown can never write muted or gain.
  function bumpGeneration(controller) {
    if (!controller) return;
    controller.generation = (controller.generation || 0) + 1;
  }

  function queueScan() {
    if (state.retired || state.scanQueued) return;
    state.scanQueued = true;
    queueMicrotask(() => {
      state.scanQueued = false;
      scanMediaElements();
      syncAllMedia();
    });
  }

  let recoveryTimer = null;
  let rateWatchdogTimer = null;
  let lastPageMessageRecovery = 0;

  // Player actions (easy volume + section repeat): one controller for the tab,
  // created only while the tab is eligible and not bypassed, torn down on
  // bypass/retire. Volume writes go through the MAIN-world page hook so YTM's
  // own slider stays truthful; a missing hook falls back to element volume.
  const VOLUME_REPLY_TIMEOUT_MS = 500;
  let playerActions = null;
  let volumeRequestSeq = 0;
  const pendingVolumeRequests = new Map();

  function resolvePageVolume(id, reply) {
    const pending = pendingVolumeRequests.get(id);
    if (!pending) return;
    pendingVolumeRequests.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(reply);
  }

  // Volume only: the hook never writes `muted`, so no mute intent travels with
  // a wheel write. The content script stays the single writer of media.muted.
  function requestPageVolume(percent) {
    const token = state.pageHookToken;
    if (!token) return Promise.resolve({ volume: null, applied: false, source: 'none' });
    return new Promise((resolve) => {
      const id = ++volumeRequestSeq;
      const timer = setTimeout(() => {
        if (!pendingVolumeRequests.has(id)) return;
        pendingVolumeRequests.delete(id);
        resolve({ volume: null, applied: false, source: 'none' });
      }, VOLUME_REPLY_TIMEOUT_MS);
      pendingVolumeRequests.set(id, { resolve, timer });
      const message = { __slra: true, type: 'SLRA_SET_VOLUME', id, token, percent };
      try {
        window.postMessage(message, '*');
      } catch {
        pendingVolumeRequests.delete(id);
        clearTimeout(timer);
        resolve({ volume: null, applied: false, source: 'none' });
      }
    });
  }

  function currentMediaForPlayerActions() {
    for (const controller of state.media.values()) {
      if (controller.attached && controller.media && controller.media.isConnected) return controller.media;
    }
    for (const media of state.media.keys()) {
      if (media.isConnected) return media;
    }
    try {
      const video = document.querySelector('video');
      return video instanceof HTMLMediaElement ? video : null;
    } catch {
      return null;
    }
  }

  function ensurePlayerActions() {
    if (playerActions || state.retired) return playerActions;
    const api = globalThis.SlowedReverbPlayerActions;
    if (!api || typeof api.createPlayerActions !== 'function') return null;
    try {
      playerActions = api.createPlayerActions({
        window,
        document,
        mediaProvider: currentMediaForPlayerActions,
        pageHook: {
          setVolume: (percent) => requestPageVolume(percent),
        },
        storage: {
          get: (key) => chrome.storage.local.get(key),
          // One ordered writer for the section list, across every tab.
          saveSection: (entry) => chrome.runtime.sendMessage({ type: 'SAVE_PLAYER_SECTION', entry }),
        },
      });
    } catch {
      playerActions = null;
      return null;
    }
    void playerActions.start();
    return playerActions;
  }

  function stopPlayerActions() {
    const current = playerActions;
    playerActions = null;
    for (const pending of pendingVolumeRequests.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ volume: null, applied: false, source: 'none' });
    }
    pendingVolumeRequests.clear();
    if (!current) return;
    try {
      current.stop();
    } catch {
      // Best effort: a dying instance must not throw.
    }
  }

  function syncPlayerActions() {
    if (state.retired || !state.eligible || state.bypass) {
      stopPlayerActions();
      return;
    }
    const current = ensurePlayerActions();
    if (current) current.sync();
  }
  const ATTACH_RETRY_MAX_ATTEMPTS = 20;
  const ATTACH_RETRY_MAX_DELAY_MS = 2000;
  // Mute enforcement is a correction loop against a page that may fight back.
  // A page that restores `muted = false` from its own `volumechange` listener
  // can otherwise spin forever, so each element gets a rolling budget of
  // corrections per second. Eight leaves headroom for YouTube's own start
  // sequence (~6 unmute writes) while still starving a spin loop. Spending the
  // budget pauses corrections for a cool-down rather than latching: after the
  // deadline the 2 s watchdog and the next volumechange can correct again.
  const MUTE_CORRECTION_WINDOW_MS = 1000;
  const MUTE_CORRECTION_BUDGET = 8;
  const MUTE_COOLDOWN_MS = 1000;

  function startRateWatchdog() {
    stopRateWatchdog();
    rateWatchdogTimer = setInterval(() => {
      if (!state.eligible || state.bypass) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      let anyPlaying = false;
      for (const controller of state.media.values()) {
        const element = controller.media;
        if (element && !element.paused && !element.ended) {
          anyPlaying = true;
          break;
        }
      }
      if (!anyPlaying) return;
      if (state.context && state.context.state !== 'running') {
        void resumeContext();
      }
      if (!state.workletLoaded && state.context && state.context.state === 'running') {
        const now = Date.now();
        if (state.workletRetryCount < 3 && now - state.workletLastRetry >= 5000) {
          state.workletRetryCount += 1;
          state.workletLastRetry = now;
          const workletContext = state.context;
          const url = workletUrl();
          if (!url) {
            state.lastError = 'Worklet: extension context invalidated.';
            state.workletRetryCount = 3;
            return;
          }
          void workletContext.audioWorklet.addModule(url).then(() => {
            state.workletLoaded = true;
            state.workletRetryCount = 0;
            state.lastError = '';
            syncAllMedia();
          }).catch((workletError) => {
            state.lastError = 'Worklet: ' + (workletError && workletError.message ? workletError.message : workletError);
          });
        }
      }
      for (const controller of state.media.values()) {
        if (!controller.attached || controller.failed) continue;
        // Mute is part of the contract, not just an attach-time action: the page
        // can unmute itself at any point. Independent of the rate-drift check.
        enforceElementMute(controller);
        if (Math.abs(controller.media.playbackRate - state.settings.slow) > 0.02) {
          setMediaPlaybackState(controller, state.settings.slow);
        }
      }
    }, 2000);
  }

  function stopRateWatchdog() {
    if (rateWatchdogTimer !== null) {
      clearInterval(rateWatchdogTimer);
      rateWatchdogTimer = null;
    }
  }

  function queueRecovery(reason) {
    if (recoveryTimer) return;

    if (!state.pageHookReady || reason === 'bootstrap' || reason === 'missing-hook') {
      void requestHookRefresh(reason);
    }

    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      void refreshRuntimeState().then(() => {
        queueScan();
        syncAllMedia();
      });
    }, 50);
  }

  function queueCriticalRecovery(reason) {
    if (!state.pageHookReady || reason === 'bootstrap' || reason === 'missing-hook') {
      void requestHookRefresh(reason);
    }

    queueMicrotask(() => {
      queueScan();
      syncAllMedia();
    });
  }

  async function requestHookRefresh(reason) {
    if (state.hookRefreshQueued) return;
    state.hookRefreshQueued = true;
    const token = mintPageHookToken();

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'ENSURE_TAB_HOOKS',
        reason: String(reason || 'recovery'),
        token,
      });
      if (result && result.ok !== false) {
        state.pageHookReady = true;
      }
    } catch {
      // Best effort only.
    } finally {
      state.hookRefreshQueued = false;
    }
  }

  async function refreshRuntimeState() {
    try {
      const runtime = await chrome.runtime.sendMessage({ type: 'GET_TAB_RUNTIME_STATE' });
      if (runtime && typeof runtime === 'object') {
        try {
          applyRuntimeState(runtime);
        } catch {
          // Keep local state; scan+sync still run below.
        }
      }
    } catch {
      // SW unreachable; keep local state and still scan+sync below.
    }
  }

  function scanMediaElements() {
    // Swap order: tear down (pause/mute) disconnected controllers BEFORE
    // tracking the replacement, so the old output never layers under the new
    // attach. Teardown runs restoreMediaPlaybackState, which pauses a
    // disconnected element before restoring its playback state.
    for (const [media, controller] of state.media.entries()) {
      if (media.isConnected) continue;
      teardownController(controller, true, state.context);
      state.media.delete(media);
    }

    document.querySelectorAll('audio,video').forEach((media) => {
      if (media instanceof HTMLMediaElement) {
        trackMedia(media);
      }
    });
  }

  function trackMedia(media) {
    if (state.media.has(media)) return state.media.get(media);

    const controller = {
      media,
      attached: false,
      attachedSrc: '',
      sourceStale: false,
      failed: false,
      generation: 0,
      pendingRetry: null,
      attachAttempts: 0,
      lastAttachReset: 0,
      attachError: '',
      stream: null,
      source: null,
      dryGain: null,
      masterGain: null,
      dattorroNode: null,
      originalRate: media.playbackRate,
      originalPitch: readPitchState(media),
      originalMuted: media.muted,
      internalRateWrite: false,
      internalMuteWrite: false,
      muteCorrections: [],
      mutePausedUntil: 0,
      budgetBypassed: false,
      budgetBypassedUntil: 0,
      lastPostedParams: null,
      rateHandler: null,
      resetHandler: null,
      loadHandler: null,
      volumeHandler: null,
    };

    controller.rateHandler = () => {
      if (controller.internalRateWrite) return;
      if (shouldBeActiveForController(controller)) {
        setMediaPlaybackState(controller, state.settings.slow);
      } else {
        controller.originalRate = media.playbackRate;
        controller.originalPitch = readPitchState(media);
      }
    };

    controller.resetHandler = () => {
      resetMuteDampener(controller);
      markTapStale(controller);
      queueCriticalRecovery('emptied');
    };

    controller.loadHandler = () => {
      markTapStale(controller);
      queueCriticalRecovery('loadedmetadata');
    };

    controller.volumeHandler = () => {
      if (controller.attached && controller.masterGain) {
        if (controller.sourceStale || controller.budgetBypassed) {
          hardZero(controller.masterGain.gain);
        } else {
          rampGain(controller.masterGain.gain, controller.media.volume);
        }
      }
      enforceElementMute(controller);
    };

    media.addEventListener('ratechange', controller.rateHandler);
    media.addEventListener('emptied', controller.resetHandler);
    media.addEventListener('loadedmetadata', controller.loadHandler);
    media.addEventListener('volumechange', controller.volumeHandler);
    state.media.set(media, controller);
    return controller;
  }

  // A genuine source change (emptied/loadedmetadata) invalidates the tap but not
  // the graph: hardZero first, confirm the element is muted, and let the next
  // sync connect the fresh capture. The element never goes audible here, so a
  // track switch has no dry gap and no doubled audio.
  function markTapStale(controller) {
    if (!controller.attached) {
      resetMuteDampener(controller);
      return;
    }
    if (controller.masterGain) hardZero(controller.masterGain.gain);
    bumpGeneration(controller);
    controller.sourceStale = true;
    controller.internalMuteWrite = true;
    controller.media.muted = true;
    queueMicrotask(() => {
      controller.internalMuteWrite = false;
    });
  }

  function shouldBeActiveForController(controller) {
    return state.eligible && !state.bypass && controller && controller.attached && !controller.failed;
  }

  function syncAllMedia(retryCount = 0) {
    if (state.retired) return;
    for (const controller of state.media.values()) {
      syncMediaController(controller, retryCount);
    }
    if (state.eligible && !state.bypass && rateWatchdogTimer === null) {
      startRateWatchdog();
    } else if ((!state.eligible || state.bypass) && rateWatchdogTimer !== null) {
      stopRateWatchdog();
    }
    if ((!state.eligible || state.bypass) && state.safetyPollTimer !== null) {
      clearSafetyPoll();
    } else if (state.eligible && !state.bypass && state.safetyPollTimer === null) {
      ensureSafetyPoll();
    }
    syncPlayerActions();
    maybeSuspendContext();
  }

  function syncMediaController(controller, retryCount = 0) {
    if (state.retired || !controller || !controller.media.isConnected) return;

    if (!state.eligible || state.bypass) {
      applyBypassState(controller);
      return;
    }

    if (controller.budgetBypassed) {
      if (Date.now() < controller.budgetBypassedUntil) {
        // Keep trying through the cool-down; the graph stays attached at 0.
        enforceElementMute(controller);
        return;
      }
      controller.budgetBypassed = false;
      controller.budgetBypassedUntil = 0;
    }

    void resumeContext();
    if (!ensureAttached(controller)) {
      if (controller.attached) {
        // The graph stays owned and muted while the new source loads; retry at
        // the ceiling instead of tearing a live graph down mid-song.
        scheduleAttachRetry(controller, retryCount);
        return;
      }
      if (state.context && state.context.state === 'running') {
        scheduleAttachRetry(controller, retryCount);
        return;
      }
      if (!state.context) {
        // Nothing to resume and no graph to own: retry later (play/seek/poll).
        scheduleAttachRetry(controller, retryCount);
        return;
      }
      // Autoplay-policy / external suspend: wait for the resume already in
      // flight instead of burning an attach-retry slot against a context that
      // is about to be running.
      const resumeGeneration = controller.generation;
      void resumeContext().then(() => {
        if (state.retired || resumeGeneration !== controller.generation) return;
        if (!controller.media.isConnected) return;
        if (!state.eligible || state.bypass) return;
        // Only continue when the resume actually produced a runnable context;
        // a failed resume is retried by the watchdog/poll, never by a microtask
        // spin.
        if (!state.context || state.context.state !== 'running') return;
        syncMediaController(controller, retryCount);
      });
      return;
    }
    cancelAttachRetry(controller);
    controller.attachAttempts = 0;
    controller.lastAttachReset = Date.now();

    updateWetChain(controller);
    const cleanSlow = parseFloat(state.settings.slow.toFixed(2));
    setMediaPlaybackState(controller, cleanSlow);
  }

  function scheduleAttachRetry(controller, retryCount = 0) {
    if (controller.pendingRetry) return;
    const now = Date.now();
    if (!controller.lastAttachReset || now - controller.lastAttachReset > 5 * 60 * 1000) {
      controller.attachAttempts = 0;
      controller.lastAttachReset = now;
    }
    const attempt = controller.attachAttempts || 0;
    if (attempt >= ATTACH_RETRY_MAX_ATTEMPTS) {
      controller.attachAttempts = 0;
      if (!controller.attached) {
        teardownController(controller, false, state.context);
        return;
      }
      // Attached: never tear a live graph down mid-song. Keep it muted and
      // retry at the ceiling until the new source arrives.
      controller.lastAttachReset = now;
    }
    const delay = Math.min(200 * (attempt + 1), ATTACH_RETRY_MAX_DELAY_MS);
    controller.attachAttempts = attempt + 1;
    const retryGeneration = controller.generation;
    controller.pendingRetry = setTimeout(() => {
      controller.pendingRetry = null;
      if (retryGeneration !== controller.generation) return;
      if (!controller.media.isConnected) return;
      if (!state.eligible || state.bypass) return;
      syncMediaController(controller, attempt + 1);
    }, delay);
  }

  function cancelAttachRetry(controller) {
    if (controller && controller.pendingRetry) {
      clearTimeout(controller.pendingRetry);
      controller.pendingRetry = null;
    }
  }

  function applyBypassState(controller) {
    teardownController(controller, false, state.context);
  }

  // One tap per element. The public name is the seam the tests drive: a second
  // sync, a revive double-fire, or a volumechange re-entry must never capture
  // or connect a second MediaStreamSource for the same live controller.
  function ensureSingleTap(controller) {
    if (!controller.attached) return false;
    if (controller.sourceStale) {
      if (controller.tapInFlight) return false;
      if (!controller.media.currentSrc || !isMediaReadyForAttach(controller.media)) {
        return false;
      }
      return rebuildStreamSource(controller);
    }

    const currentSrc = controller.media.currentSrc;
    if (currentSrc && currentSrc !== controller.attachedSrc) {
      // Track-change hint only. music.youtube.com rotates googlevideo URLs
      // (next/prev, radio, quality, ads) on the SAME element; captureStream is
      // per element, so the existing tap is still live. Never recapture here.
      controller.attachedSrc = currentSrc;
    }
    return true;
  }

  function ensureAttached(controller) {
    if (controller.attached) return ensureSingleTap(controller);
    if (!isMediaReadyForAttach(controller.media)) return false;

    if (state.context && state.context.state === 'closed') {
      state.context = null;
      state.workletLoaded = false;
    }

    const context = getAudioContext();
    if (!state.workletLoaded || context.state !== 'running') return false;

    controller.failed = false;
    controller.attachError = '';

    let stream = null;
    let source = null;
    try {
      stream = captureMediaStream(controller.media);
      if (!stream) {
        throw new Error('captureStream unavailable for this media element.');
      }

      if (!stream.getAudioTracks().length) {
        stream.addEventListener('addtrack', function onTrack(event) {
          if (event.track.kind === 'audio') {
            stream.removeEventListener('addtrack', onTrack);
            queueScan();
          }
        });

        // No audio track yet: the old tap is still connected, so hard-zero the
        // graph BEFORE unmuting. audible(controller) === (attached && !stale):
        // an unmuted element implies gain === 0.
        stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {
            // Track already stopped.
          }
        });
        if (controller.masterGain) {
          hardZero(controller.masterGain.gain);
        }
        controller.sourceStale = true;
        bumpGeneration(controller);
        controller.media.muted = false;
        return false;
      }

      source = context.createMediaStreamSource(stream);
      const dryGain = context.createGain();
      const masterGain = context.createGain();
      const dattorroNode = new AudioWorkletNode(context, 'dattorro-reverb');

      const initialParams = computePostParams(state.settings.reverbIntensity);
      dattorroNode.port.postMessage({ type: 'reset' });
      dattorroNode.port.postMessage({ type: 'setParams', params: initialParams });

      dryGain.gain.value = 0;
      masterGain.gain.value = 0;

      source.connect(dryGain);
      dryGain.connect(masterGain);
      source.connect(dattorroNode);
      dattorroNode.connect(masterGain);
      masterGain.connect(context.destination);

      // Direct, not budgeted: this is the one write that establishes the
      // contract, and it must land before `controller.attached = true` so the
      // volumechange it queues cannot re-enter a half-attached controller
      // (`enforceElementMute` gates on `attached`). The budget is cleared just
      // below, so this single write never eats into the correction allowance.
      controller.media.muted = true;
      rampGain(dryGain.gain, Math.sqrt(Math.max(0, 1 - initialParams.wetGain * initialParams.wetGain)));
      rampGain(masterGain.gain, controller.media.volume);

      controller.stream = stream;
      controller.source = source;
      controller.dryGain = dryGain;
      controller.masterGain = masterGain;
      controller.dattorroNode = dattorroNode;
      controller.attached = true;
      controller.attachedSrc = controller.media.currentSrc;
      controller.sourceStale = false;
      resetMuteDampener(controller);
      controller.lastPostedParams = JSON.stringify(initialParams);
      controller.attachError = '';
      const attachGeneration = controller.generation;
      void resumeContext().then(() => {
        if (attachGeneration !== controller.generation) return;
        syncMediaController(controller, 0);
      });
      return true;
    } catch (error) {
      if (source) {
        disconnectNode(source);
      }
      if (stream) {
        stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {
            // Track already stopped.
          }
        });
      }
      controller.media.muted = false;
      controller.failed = true;
      controller.attachError = 'Could not attach audio effect.';
      state.lastError = String(error && error.message ? error.message : error);
      return false;
    }
  }

  function rebuildStreamSource(controller) {
    controller.tapInFlight = true;
    let capturedStream = null;
    try {
      // Mute-first ordering: markTapStale already hard-zeroed the graph and
      // confirmed the element muted, so the source swap is inaudible. Re-assert
      // both before the new capture becomes reachable.
      if (controller.masterGain) hardZero(controller.masterGain.gain);
      controller.internalMuteWrite = true;
      controller.media.muted = true;
      queueMicrotask(() => {
        controller.internalMuteWrite = false;
      });

      const stream = captureMediaStream(controller.media);
      if (!stream) {
        throw new Error('captureStream unavailable for this media element.');
      }
      capturedStream = stream;

      if (!stream.getAudioTracks().length) {
        // No audio track yet: the old tap is still connected, so keep the
        // element muted. The graph owns the output, not the element.
        stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {
            // Track already stopped.
          }
        });
        controller.sourceStale = true;
        return false;
      }

      const source = state.context.createMediaStreamSource(stream);
      source.connect(controller.dryGain);
      source.connect(controller.dattorroNode);

      // A new track must not inherit the previous track's tank: clear it before
      // the fresh tap becomes audible.
      if (controller.dattorroNode) {
        controller.dattorroNode.port.postMessage({ type: 'reset' });
        const params = computePostParams(state.settings.reverbIntensity);
        controller.dattorroNode.port.postMessage({ type: 'setParams', params });
        controller.lastPostedParams = JSON.stringify(params);
      }

      const previousSource = controller.source;
      const previousStream = controller.stream;

      controller.source = source;
      controller.stream = stream;
      controller.attachedSrc = controller.media.currentSrc;
      controller.sourceStale = false;
      controller.failed = false;
      controller.attachError = '';

      void resumeContext();

      disconnectNode(previousSource);
      if (previousStream) {
        previousStream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {
            // Track already stopped.
          }
        });
      }

      resetMuteDampener(controller);
      if (controller.dryGain) {
        const params = computePostParams(state.settings.reverbIntensity);
        rampGain(controller.dryGain.gain, Math.sqrt(Math.max(0, 1 - params.wetGain * params.wetGain)));
      }
      if (controller.masterGain) {
        rampGain(controller.masterGain.gain, controller.media.volume);
      }
      return true;
    } catch (error) {
      // Never leave the element muted without an audio path: drop the stale
      // tap before unmuting so the old source cannot keep playing underneath.
      disconnectNode(controller.source);
      if (controller.stream) {
        controller.stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {
            // Track already stopped.
          }
        });
      }
      controller.stream = null;
      controller.source = null;
      controller.sourceStale = true;
      bumpGeneration(controller);
      if (capturedStream) {
        capturedStream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {
            // Track already stopped.
          }
        });
      }
      controller.media.muted = false;
      controller.failed = true;
      controller.attachError = 'Could not attach audio effect.';
      state.lastError = String(error && error.message ? error.message : error);
      return false;
    } finally {
      controller.tapInFlight = false;
    }
  }

  function getAudioContext() {
    if (!state.context) {
      // Chromium-only: AudioContext is unprefixed since Chrome 35 (2014).
      state.context = new AudioContext();
      state.context.onstatechange = handleContextStateChange;
      void loadWorklet(state.context);
    }
    return state.context;
  }

  // The one place a context lifecycle fact becomes an event: recover without
  // waiting for the 2 s watchdog, and never leave an element muted onto a dead
  // or frozen graph.
  function handleContextStateChange() {
    const context = state.context;
    if (!context || state.retired) return;
    if (context.state === 'running') {
      syncAllMedia();
      return;
    }
    if (context.state === 'closed') {
      for (const controller of [...state.media.values()]) {
        if (controller.attached) teardownController(controller, false, null);
      }
      state.context = null;
      state.workletLoaded = false;
      state.workletRetryCount = 0;
      syncAllMedia();
      return;
    }
    // suspended/interrupted while we own a playing element: resume now.
    for (const controller of state.media.values()) {
      if (controller.media && !controller.media.paused && !controller.media.ended) {
        void resumeContext();
        return;
      }
    }
  }

  async function resumeContext() {
    if (!state.context || state.context.state === 'running') return;
    try {
      await state.context.resume();
    } catch {
      // Best effort only.
    }
  }

  function captureMediaStream(media) {
    if (typeof media.captureStream === 'function') {
      return media.captureStream();
    }

    return null;
  }

  function isMediaReadyForAttach(media) {
    return Boolean(
      media &&
      !media.paused &&
      !media.ended &&
      media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      (media.currentSrc || media.srcObject)
    );
  }

  async function loadWorklet(context) {
    try {
      const url = workletUrl();
      if (!url) {
        state.lastError = 'Worklet: extension context invalidated.';
        return;
      }
      await context.audioWorklet.addModule(url);
      state.workletLoaded = true;
      state.workletRetryCount = 0;
      syncAllMedia();
    } catch (e) {
      state.lastError = 'Worklet: ' + (e.message || e);
      if (!state.workletLoaded && context.state === 'running') {
        try {
          const url = workletUrl();
          if (!url) return;
          await context.audioWorklet.addModule(url);
          state.workletLoaded = true;
          state.workletRetryCount = 0;
          state.lastError = '';
          syncAllMedia();
        } catch (retryError) {
          state.lastError = 'Worklet: ' + (retryError.message || retryError);
          state.workletLastRetry = Date.now();
        }
      }
    }
  }

  function computeDattorroParams(intensity) {
    const numeric = Number(intensity);
    const i = Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 0;
    if (i <= 0) {
      return { wetGain: 0, decay: 0, damping: 1, preDelay: 0 };
    }
    return {
      preDelay: 0.44 + i * 0.1,
      preFilter: 0.7 + i * 0.1,
      inputDiff1: 0.75,
      inputDiff2: 0.625,
      decayDiff1: 0.65 + i * 0.05,
      decay: Math.pow(i, 0.75) * 0.58,
      damping: Math.min(0.5 + Math.pow(i, 0.6) * 0.4, 0.78),
      // Equal-power crossfade: wet keeps the perceptual i^0.75 curve with full
      // wet at i=1, and dry = sqrt(1 - wet^2) so the uncorrelated sum holds
      // 0 dB at every setting (dry is derived at the rampGain sites below).
      wetGain: Math.pow(i, 0.75),
    };
  }

  function computePostParams(intensity) {
    const base = computeDattorroParams(intensity > 0 ? intensity : (state.lastNonzeroIntensity || 0.5));
    return { ...base, wetGain: intensity > 0 ? base.wetGain : 0 };
  }

  function rampGain(param, value, tau = 0.015) {
    if (!param || !state.context) return;
    param.setTargetAtTime(value, state.context.currentTime, tau);
  }

  // Zero-overlap unmute: cancel any scheduled ramp and drop the gain to 0 in
  // the same sample, so the element's own output and the graph are never both
  // audible. Order matters: cancel, hard-zero, and only then `muted = false`.
  // `rampGain` stays for genuine fade-ins (attach, rebuild, correction).
  function hardZero(param) {
    if (!param || !state.context) return;
    try {
      param.cancelScheduledValues(state.context.currentTime);
    } catch {
      // Already silent or no scheduled events.
    }
    param.setValueAtTime(0, state.context.currentTime);
  }

  function updateWetChain(controller) {
    if (!controller.dattorroNode) return;
    const params = computePostParams(state.settings.reverbIntensity);
    const signature = JSON.stringify(params);
    if (signature === controller.lastPostedParams) return;
    controller.lastPostedParams = signature;
    controller.dattorroNode.port.postMessage({ type: 'setParams', params });
    if (controller.dryGain) {
      rampGain(controller.dryGain.gain, Math.sqrt(Math.max(0, 1 - params.wetGain * params.wetGain)));
    }
  }

  function pitchStateMatches(media, intended) {
    const keys = ['preservesPitch', 'mozPreservesPitch', 'webkitPreservesPitch'];
    for (const key of keys) {
      if (!(key in media) || typeof intended[key] === 'undefined') continue;
      if (media[key] !== intended[key]) return false;
    }
    return true;
  }

  // Clears the mute-correction budget. Called on every fresh playback start
  // (attach / play / emptied) and on restore, so a paused dampener never
  // outlives the track it was paused on.
  function resetMuteDampener(controller) {
    if (!controller) return;
    controller.muteCorrections.length = 0;
    controller.mutePausedUntil = 0;
    controller.budgetBypassed = false;
    controller.budgetBypassedUntil = 0;
  }

  // Rolling-window budget plus a cool-down. Prune corrections older than the
  // window, then claim one slot; a spent budget sets a deadline instead of a
  // latch, so corrections resume on their own once the cool-down passes.
  function claimMuteCorrection(controller) {
    const now = Date.now();
    if (now < controller.mutePausedUntil) return false;
    controller.mutePausedUntil = 0;
    const cutoff = now - MUTE_CORRECTION_WINDOW_MS;
    const corrections = controller.muteCorrections;
    while (corrections.length > 0 && corrections[0] <= cutoff) {
      corrections.shift();
    }
    if (corrections.length >= MUTE_CORRECTION_BUDGET) {
      controller.mutePausedUntil = now + MUTE_COOLDOWN_MS;
      return false;
    }
    corrections.push(now);
    return true;
  }

  // `media.muted` mirrors `controller.attached` while the graph plays the
  // element (AGENTS.md "Mute semantics"). The page can write `muted = false`
  // during its own start sequence, so re-assert the contract at every
  // volumechange and from the watchdog instead of only at attach time.
  function enforceElementMute(controller) {
    if (!isAudible(controller)) return;
    const media = controller.media;
    if (!media || media.muted === true) return;
    if (controller.internalMuteWrite) return;
    if (!claimMuteCorrection(controller)) {
      const pausedUntil = controller.mutePausedUntil;
      controller.budgetBypassed = true;
      controller.budgetBypassedUntil = pausedUntil;
      // Never tear down the live graph: park it at 0 so only the page's own
      // (still slowed) output is audible, and retry the mute when the cool-down
      // expires. Keep the graph so the next correction is a single mute write,
      // not a full re-attach.
      if (controller.masterGain) hardZero(controller.masterGain.gain);
      return;
    }

    if (controller.budgetBypassed) {
      controller.budgetBypassed = false;
      controller.budgetBypassedUntil = 0;
    }
    controller.internalMuteWrite = true;

    try {
      media.muted = true;
      if (controller.masterGain && !controller.sourceStale) {
        rampGain(controller.masterGain.gain, media.volume);
      }
    } finally {
      queueMicrotask(() => {
        controller.internalMuteWrite = false;
      });
    }
  }

  function setMediaPlaybackState(controller, rate) {
    const media = controller.media;
    const neutral = Math.abs(rate - 1) < 0.001;
    const intendedRate = neutral ? controller.originalRate : parseFloat(rate.toFixed(2));
    // Speed and pitch move together: a non-neutral rate write always forces
    // pitch-preservation OFF across all three vendor spellings (and the guard
    // below re-asserts it after the page player writes the aliases); only the
    // neutral restore puts the element's own pitch state back.
    const intendedPitch = neutral
      ? controller.originalPitch
      : { preservesPitch: false, mozPreservesPitch: false, webkitPreservesPitch: false };
    const intendedMuted = isAudible(controller);

    if (media.playbackRate === intendedRate && media.muted === intendedMuted && pitchStateMatches(media, intendedPitch)) {
      return;
    }

    controller.internalRateWrite = true;

    try {
      if (neutral) {
        applyPitchState(media, controller.originalPitch);
        media.playbackRate = controller.originalRate;
      } else {
        setPreservesPitch(media, false);
        media.playbackRate = parseFloat(rate.toFixed(2));
      }
      if (intendedMuted) {
        // Same budget as the volumechange path: a page can restore its rate and
        // fire `ratechange` as easily as `volumechange`, so this write must not
        // be a free extra correction. Only the deliberate unmute is direct.
        enforceElementMute(controller);
      } else {
        media.muted = false;
      }
    } finally {
      queueMicrotask(() => {
        controller.internalRateWrite = false;
      });
    }
  }

  function teardownController(controller, removeCompletely, context) {
    if (!controller) return;
    cancelAttachRetry(controller);
    bumpGeneration(controller);

    // Only touch the element's playback state when this controller actually
    // attached and changed it. While bypassed (or before a first attach) the
    // extension must not clear the page's own mute/rate on every sync.
    if (controller.attached) {
      disconnectNode(controller.source);
      disconnectNode(controller.dryGain);
      disconnectNode(controller.masterGain);
      if (controller.dattorroNode) {
        try { controller.dattorroNode.disconnect(); } catch {}
      }
      if (controller.stream) {
        controller.stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {
            // Track already stopped.
          }
        });
      }
      restoreMediaPlaybackState(controller);
    }

    controller.attached = false;
    controller.attachedSrc = '';
    controller.sourceStale = false;
    controller.lastPostedParams = null;
    controller.stream = null;
    controller.source = null;
    controller.dryGain = null;
    controller.masterGain = null;
    controller.dattorroNode = null;

    if (removeCompletely && state.media.size <= 1) {
      clearSafetyPoll();
    }
    try {
      maybeSuspendContext();
    } catch {
      // Best effort only.
    }

    if (removeCompletely) {
      if (controller.rateHandler) {
        controller.media.removeEventListener('ratechange', controller.rateHandler);
        controller.rateHandler = null;
      }
      if (controller.resetHandler) {
        controller.media.removeEventListener('emptied', controller.resetHandler);
        controller.resetHandler = null;
      }
      if (controller.loadHandler) {
        controller.media.removeEventListener('loadedmetadata', controller.loadHandler);
        controller.loadHandler = null;
      }
      if (controller.volumeHandler) {
        controller.media.removeEventListener('volumechange', controller.volumeHandler);
        controller.volumeHandler = null;
      }
    }
  }

  function restoreMediaPlaybackState(controller) {
    const media = controller.media;
    // Element swap: a removed element can still be playing while its
    // replacement attaches. Pause a disconnected element before restoring
    // playback state so the old output never layers under the new one.
    if (media && media.isConnected === false) {
      try {
        media.pause();
      } catch {
        // Pause is best effort.
      }
    }
    resetMuteDampener(controller);
    controller.internalRateWrite = true;

    try {
      applyPitchState(media, controller.originalPitch);
      media.playbackRate = controller.originalRate;
      media.muted = false;
    } catch {
      // Ignore restore failures.
    } finally {
      queueMicrotask(() => {
        controller.internalRateWrite = false;
      });
    }
  }

  // Chromium-only, but DO NOT strip the prefixed aliases below.
  // Chrome exposes `mozPreservesPitch`/`webkitPreservesPitch` as real,
  // writable HTMLMediaElement properties, and YouTube's own player reads and
  // writes them. If we only wrote `preservesPitch`, YouTube could flip
  // preservation back on and the slow effect would lose its pitch drop: every
  // rate write has to force all three aliases off.
  function readPitchState(media) {
    return {
      preservesPitch: readMaybe(media, 'preservesPitch'),
      mozPreservesPitch: readMaybe(media, 'mozPreservesPitch'),
      webkitPreservesPitch: readMaybe(media, 'webkitPreservesPitch'),
    };
  }

  function applyPitchState(media, pitchState) {
    writeMaybe(media, 'preservesPitch', pitchState.preservesPitch);
    writeMaybe(media, 'mozPreservesPitch', pitchState.mozPreservesPitch);
    writeMaybe(media, 'webkitPreservesPitch', pitchState.webkitPreservesPitch);
  }

  function setPreservesPitch(media, value) {
    writeMaybe(media, 'preservesPitch', value);
    writeMaybe(media, 'mozPreservesPitch', value);
    writeMaybe(media, 'webkitPreservesPitch', value);
  }

  function readMaybe(target, key) {
    return key in target ? target[key] : undefined;
  }

  function writeMaybe(target, key, value) {
    if (!(key in target) || typeof value === 'undefined') return;
    target[key] = value;
  }

  function disconnectNode(node) {
    if (!node) return;
    try {
      node.disconnect();
    } catch {
      // Already disconnected.
    }
  }

  function getLiveStatus() {
    let attachedCount = 0;
    let failedCount = 0;
    let budgetBypassedCount = 0;

    for (const controller of state.media.values()) {
      if (controller.failed) failedCount += 1;
      if (controller.attached) attachedCount += 1;
      if (controller.budgetBypassed) budgetBypassedCount += 1;
    }

    const totalCount = state.media.size;
    const active = state.eligible && !state.bypass;
    // Friendly copy only: internal errors live in state.lastError and the
    // console, never in the status the popup shows.
    let text = 'Waiting for media.';
    if (!state.eligible) {
      text = 'Waiting for tab.';
    } else if (state.bypass) {
      text = 'Off.';
    } else if (attachedCount > 0) {
      text = 'Active.';
    }

    return {
      ok: true,
      eligible: state.eligible,
      bypass: state.bypass,
      active,
      neutral: active && attachedCount > 0 && isNeutral(state.settings),
      attachedCount,
      failedCount,
      totalCount,
      budgetBypassedCount,
      contextState: state.context ? state.context.state : 'idle',
      text,
      error: state.lastError || '',
    };
  }
})();
