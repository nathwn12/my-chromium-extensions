(() => {
  const existing = globalThis.__slowedReverbAudioContent;

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
    }
  }

  const {
    extractHostname,
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
    pageSongId: null,
    pageSongPushed: false,
    pageSongHref: null,
    lastTrustedSliderAt: 0,
    songPushSeq: 0,
    songQuerySeq: 0,
    pendingSongQuery: null,
    identityPlayed: false,
    pendingSourceChange: false,
    suspendedSongId: null,
    suspendedElement: null,
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
        }
        state.observer = null;
      }
      for (const controller of [...state.media.values()]) {
        try {
          teardownController(controller, true, state.context);
        } catch {
        }
      }
      state.media.clear();
      if (state.context) {
        try {
          void state.context.close();
        } catch {
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
      resetMuteDampener(controller);
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

    document.addEventListener('timeupdate', (event) => {
      const target = event && event.target;
      if (!(target instanceof HTMLMediaElement)) return;
      if (Number(target.currentTime) > 0.5) state.identityPlayed = true;
    }, true);

    ['loadedmetadata', 'emptied'].forEach((eventName) => {
      document.addEventListener(eventName, (event) => {
        const target = event && event.target;
        if (!(target instanceof HTMLMediaElement)) return;
        if (state.identityPlayed && state.pageSongId !== null) {
          state.pendingSourceChange = true;
          state.suspendedSongId = state.pageSongId;
          state.suspendedElement = target;
          suspendPlayerSongIdentity();
        }
        if (!requestSongIdentity() && state.pendingSourceChange) {
          invalidatePlayerSongIdentity();
        }
      }, true);
    });
    window.addEventListener('yt-navigate-finish', () => requestSongIdentity(), true);
    window.addEventListener('yt-player-updated', () => requestSongIdentity(), true);

    ['input', 'change'].forEach((eventName) => {
      document.addEventListener(eventName, (event) => {
        if (!event || event.isTrusted !== true) return;
        if (isVolumeSliderEvent(event.target)) state.lastTrustedSliderAt = Date.now();
      }, true);
    });

    document.addEventListener('pause', () => {
      queueMicrotask(() => {
        try {
          maybeSuspendContext();
        } catch {
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

      if (data.type === 'SLRA_SONG') {
        if (typeof data.token !== 'string' || data.token.length === 0) return;
        if (data.token !== state.pageHookToken) return;
        state.songPushSeq += 1;
        const pushedId = typeof data.videoId === 'string' && data.videoId !== '' ? data.videoId : null;
        const pushedHref = typeof data.href === 'string' && data.href !== '' ? data.href : location.href;
        if (state.pendingSourceChange) {
          if (pushedId === state.suspendedSongId) {
            if (!state.pageSongPushed && pushedId !== null) {
              state.pageSongId = pushedId;
              state.pageSongHref = pushedHref;
              state.pageSongPushed = true;
              state.suspendedElement = currentMediaForPlayerActions();
            }
            if (!sameSongSourceConfirmed(pushedId, pushedHref)) {
              invalidatePlayerSongIdentity();
              return;
            }
          } else if (pushedId === null) {
            invalidatePlayerSongIdentity();
            return;
          }
          state.pendingSourceChange = false;
          state.suspendedSongId = null;
          state.suspendedElement = null;
        }
        if (pushedId !== state.pageSongId) state.identityPlayed = false;
        state.pageSongPushed = true;
        state.pageSongId = pushedId;
        state.pageSongHref = pushedHref;
        if (playerActions) playerActions.setSongId(state.pageSongId, state.pageSongHref);
      }

      if (data.type === 'SLRA_SONG_STATE') {
        if (typeof data.token !== 'string' || data.token.length === 0) return;
        if (data.token !== state.pageHookToken) return;
        const pending = state.pendingSongQuery;
        if (!pending || data.id !== pending.id) return;
        clearTimeout(pending.timer);
        state.pendingSongQuery = null;
        if (state.songPushSeq !== pending.pushSeq) return;
        if (typeof data.videoId === 'string' && data.videoId !== '') {
          if (state.pendingSourceChange && data.videoId === state.suspendedSongId) {
            if (!sameSongSourceConfirmed(data.videoId, data.href)) {
              invalidatePlayerSongIdentity();
              return;
            }
          }
          state.pendingSourceChange = false;
          state.suspendedSongId = null;
          state.suspendedElement = null;
          if (!(state.pageSongPushed && state.pageSongId === data.videoId)) {
            state.identityPlayed = false;
            state.pageSongHref = typeof data.href === 'string' && data.href !== '' ? data.href : location.href;
          }
          state.pageSongPushed = true;
          state.pageSongId = data.videoId;
          if (playerActions) playerActions.setSongId(state.pageSongId, state.pageSongHref);
          return;
        }
        invalidatePlayerSongIdentity();
        return;
      }

      if (data.type === 'SLRA_VOLUME_STATE') {
        if (typeof data.token !== 'string' || data.token.length === 0) return;
        if (data.token !== state.pageHookToken) return;
        if (data.applied === true) settleAttachedVolume();
        resolvePageVolume(data.id, {
          volume: data.volume,
          applied: data.applied === true,
          source: data.source || 'none',
        });
        if ((data.id === undefined || data.id === null) && data.source === 'player') {
          const pushed = Number(data.volume);
          if (Number.isFinite(pushed)) {
            settleAttachedVolume();
            if (playerActions) {
              try {
                playerActions.setPlayerVolume(pushed, { user: isUserSliderPush(data) });
              } catch {
              }
            }
          }
        }
      }
    });

    ['yt-navigate-start', 'yt-navigate-finish', 'yt-page-data-updated', 'spfdone'].forEach((eventName) => {
      window.addEventListener(eventName, () => revive(eventName), true);
    });

    state.lifecycleListenersReady = true;
  }

  function ensureObserver() {
    if (state.observer) return;

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
    if (typeof node.querySelectorAll === 'function') {
      try {
        if (node.querySelectorAll('audio,video').length > 0) return true;
      } catch {
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
    }
    return token;
  }

  function maybeSuspendContext() {
    if (!state.context || state.context.state !== 'running') return;
    if (typeof state.context.suspend !== 'function') return;
    for (const controller of state.media.values()) {
      if (controller.media && !controller.media.paused && !controller.media.ended) {
        return;
      }
    }
    try {
      void Promise.resolve(state.context.suspend()).catch(() => {
      });
    } catch {
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
    restoreStoredVolume();
  }

  /**
   * The wheel volume is remembered in this site's settings. Applying it is the
   * controller's job (it waits for the first playback start); here we only hand
   * it the stored number, once per document, and only when a controller exists
   * to take it - a number dropped before that is a number lost.
   */
  function restoreStoredVolume() {
    if (volumeRestoreSeeded) return;
    const stored = state.settings ? state.settings.volume : null;
    if (!Number.isFinite(stored)) return;
    if (!playerActions || typeof playerActions.restoreVolume !== 'function') return;
    volumeRestoreSeeded = true;
    try {
      playerActions.restoreVolume(stored);
    } catch {
    }
  }

  function isAudible(controller) {
    return Boolean(controller && controller.attached);
  }

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

  const VOLUME_REPLY_TIMEOUT_MS = 500;
  let playerActions = null;
  let volumeRequestSeq = 0;
  let volumeRestoreSeeded = false;
  const pendingVolumeRequests = new Map();

  function requestVolumeUiSync(percent) {
    const token = state.pageHookToken;
    if (!token) return;
    try {
      window.postMessage({ __slra: true, type: 'SLRA_SYNC_VOLUME_UI', token, percent }, '*');
    } catch {
    }
  }

  const SONG_QUERY_TIMEOUT_MS = 1000;

  function suspendPlayerSongIdentity() {
    if (playerActions && typeof playerActions.suspendSongIdentity === 'function') {
      try {
        playerActions.suspendSongIdentity();
      } catch {
      }
    }
  }

  function songIdFromHref(href) {
    try {
      const parsed = new URL(String(href === undefined || href === null ? '' : href));
      const id = parsed.searchParams.get('v');
      return typeof id === 'string' && id !== '' ? id : null;
    } catch {
      return null;
    }
  }

  function sameSongSourceConfirmed(id, href) {
    if (typeof id !== 'string' || id === '') return false;
    if (!(state.pageSongPushed && state.pageSongId === id)) return false;
    if (songIdFromHref(location.href) !== id) return false;
    if (songIdFromHref(href) !== id) return false;
    const element = state.suspendedElement;
    if (!element || !(element instanceof HTMLMediaElement) || !element.isConnected) return false;
    return currentMediaForPlayerActions() === element;
  }

  function invalidatePlayerSongIdentity() {
    state.pageSongPushed = false;
    state.pageSongId = null;
    state.pageSongHref = null;
    state.suspendedElement = null;
    if (playerActions && typeof playerActions.invalidateSongIdentity === 'function') {
      try {
        playerActions.invalidateSongIdentity();
      } catch {
      }
    }
  }

  function requestSongIdentity() {
    if (!state.pageSongPushed || !state.pageHookReady) return false;
    const token = state.pageHookToken;
    if (!token) return false;
    const id = ++state.songQuerySeq;
    if (state.pendingSongQuery && state.pendingSongQuery.timer) {
      clearTimeout(state.pendingSongQuery.timer);
    }
    const timer = setTimeout(() => {
      if (!state.pendingSongQuery || state.pendingSongQuery.id !== id) return;
      state.pendingSongQuery = null;
      invalidatePlayerSongIdentity();
    }, SONG_QUERY_TIMEOUT_MS);
    state.pendingSongQuery = { id, pushSeq: state.songPushSeq, timer };
    suspendPlayerSongIdentity();
    try {
      window.postMessage({ __slra: true, type: 'SLRA_QUERY_SONG', id, token }, '*');
      return true;
    } catch {
      return false;
    }
  }

  const USER_PUSH_WINDOW_MS = 3000;
  const VOLUME_SLIDER_SELECTOR = '#volume-slider, #expand-volume-slider';

  function isVolumeSliderEvent(target) {
    try {
      if (!target || typeof target.closest !== 'function') return false;
      return Boolean(target.closest(VOLUME_SLIDER_SELECTOR));
    } catch {
      return false;
    }
  }

  function isUserSliderPush(data) {
    if (!data || data.reason !== 'slider') return false;
    return Date.now() - state.lastTrustedSliderAt <= USER_PUSH_WINDOW_MS;
  }

  function resolvePageVolume(id, reply) {
    const pending = pendingVolumeRequests.get(id);
    if (!pending) return;
    pendingVolumeRequests.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(reply);
  }

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
      const message = { __slra: true, type: 'SLRA_SET_VOLUME', id, token, percent, keepMuted: true };
      try {
        window.postMessage(message, '*');
      } catch {
        pendingVolumeRequests.delete(id);
        clearTimeout(timer);
        resolve({ volume: null, applied: false, source: 'none' });
      }
    });
  }

  /**
   * Persists the wheel volume. The patch carries only `volume`, so the worker
   * must merge it over the stored object; a wheel scroll never rewrites slow or
   * reverb. The shared normalizer clamps it, and the local cache follows.
   */
  function savePlayerVolume(percent) {
    const value = Number(percent);
    if (!Number.isFinite(value)) return Promise.resolve({ ok: false, error: 'invalid_volume' });
    const clamped = Math.min(100, Math.max(0, Math.round(value)));
    state.settings = normalizeSettings({ ...state.settings, volume: clamped });
    try {
      return chrome.runtime.sendMessage({
        type: 'SET_SITE_SETTINGS',
        siteKey: extractHostname(location.href),
        settings: { volume: clamped },
      });
    } catch {
      return Promise.resolve({ ok: false, error: 'runtime_unavailable' });
    }
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
          syncVolumeUi: (percent) => requestVolumeUiSync(percent),
        },
        storage: {
          get: (key) => chrome.storage.local.get(key),
          saveSection: (entry) => chrome.runtime.sendMessage({ type: 'SAVE_PLAYER_SECTION', entry }),
          saveVolume: (percent) => savePlayerVolume(percent),
          subscribe: (callback) => {
            if (!chrome.storage || !chrome.storage.onChanged) return () => {};
            const handler = (changes, area) => {
              if (area !== 'local' || !changes || !changes.playerActions) return;
              const value = changes.playerActions.newValue;
              callback(value && Array.isArray(value.sections) ? value.sections : []);
            };
            chrome.storage.onChanged.addListener(handler);
            return () => {
              try {
                chrome.storage.onChanged.removeListener(handler);
              } catch {
              }
            };
          },
        },
      });
    } catch {
      playerActions = null;
      return null;
    }
    if (state.pageSongPushed) playerActions.setSongId(state.pageSongId, state.pageSongHref);
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
        }
      }
    } catch {
    }
  }

  function scanMediaElements() {
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
      reverbCompGain: null,
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
        const intended = intendedPlaybackState(controller, state.settings.slow);
        const rateDiffers = media.playbackRate !== intended.intendedRate || !pitchStateMatches(media, intended.intendedPitch);
        if (!rateDiffers && media.muted === isAudible(controller)) return;
        const coverParam = rateDiffers && !controller.sourceStale && controller.masterGain ? controller.masterGain.gain : null;
        if (coverParam) {
          const now = state.context ? state.context.currentTime : 0;
          try {
            coverParam.cancelScheduledValues(now);
          } catch {
          }
          coverParam.setValueAtTime(coverParam.value, now);
          if (typeof coverParam.linearRampToValueAtTime === 'function') {
            coverParam.linearRampToValueAtTime(0, now + 0.005);
          }
        }
        writeIntendedRate(controller, state.settings.slow);
        enforceElementMute(controller);
        if (coverParam && !controller.budgetBypassed) {
          rampGain(controller.masterGain.gain, media.volume);
        }
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

  function markTapStale(controller) {
    if (!controller.attached) {
      resetMuteDampener(controller);
      return;
    }
    resetMuteDampener(controller);
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
        enforceElementMute(controller);
        return;
      }
      controller.budgetBypassed = false;
      controller.budgetBypassedUntil = 0;
    }

    void resumeContext();
    if (!ensureAttached(controller)) {
      if (controller.attached) {
        if (controller.sourceStale) {
          writeIntendedRate(controller, state.settings.slow);
        }
        scheduleAttachRetry(controller, retryCount);
        return;
      }
      if (state.context && state.context.state === 'running') {
        scheduleAttachRetry(controller, retryCount);
        return;
      }
      if (!state.context) {
        scheduleAttachRetry(controller, retryCount);
        return;
      }
      const resumeGeneration = controller.generation;
      void resumeContext().then(() => {
        if (state.retired || resumeGeneration !== controller.generation) return;
        if (!controller.media.isConnected) return;
        if (!state.eligible || state.bypass) return;
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

        stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {
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
      const reverbCompGain = context.createGain();
      const masterGain = context.createGain();
      const dattorroNode = new AudioWorkletNode(context, 'dattorro-reverb');

      const initial = computeMixLevels(state.settings.reverbIntensity);
      const initialParams = initial.params;
      dattorroNode.port.postMessage({ type: 'reset' });
      dattorroNode.port.postMessage({ type: 'setParams', params: initialParams });

      dryGain.gain.value = 0;
      reverbCompGain.gain.value = initial.comp;
      masterGain.gain.value = 0;

      source.connect(dryGain);
      dryGain.connect(masterGain);
      source.connect(dattorroNode);
      dattorroNode.connect(reverbCompGain);
      reverbCompGain.connect(masterGain);
      masterGain.connect(context.destination);

      controller.media.muted = true;

      controller.stream = stream;
      controller.source = source;
      controller.dryGain = dryGain;
      controller.reverbCompGain = reverbCompGain;
      controller.masterGain = masterGain;
      controller.dattorroNode = dattorroNode;
      controller.attached = true;
      controller.attachedSrc = controller.media.currentSrc;
      alignBeforeAudible(controller);
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
        stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {
          }
        });
        controller.sourceStale = true;
        return false;
      }

      const source = state.context.createMediaStreamSource(stream);
      source.connect(controller.dryGain);
      source.connect(controller.dattorroNode);

      if (controller.dattorroNode) {
        controller.dattorroNode.port.postMessage({ type: 'reset' });
        const { params } = computeMixLevels(state.settings.reverbIntensity);
        controller.dattorroNode.port.postMessage({ type: 'setParams', params });
        controller.lastPostedParams = JSON.stringify(params);
      }

      const previousSource = controller.source;
      const previousStream = controller.stream;

      controller.source = source;
      controller.stream = stream;
      controller.attachedSrc = controller.media.currentSrc;
      controller.failed = false;
      controller.attachError = '';

      void resumeContext();

      disconnectNode(previousSource);
      if (previousStream) {
        previousStream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {
          }
        });
      }

      resetMuteDampener(controller);
      alignBeforeAudible(controller);
      return true;
    } catch (error) {
      disconnectNode(controller.source);
      if (controller.stream) {
        controller.stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {
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
      state.context = new AudioContext();
      state.context.onstatechange = handleContextStateChange;
      void loadWorklet(state.context);
    }
    return state.context;
  }

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
      wetGain: Math.pow(i, 0.75),
    };
  }

  function computePostParams(intensity) {
    const base = computeDattorroParams(intensity > 0 ? intensity : (state.lastNonzeroIntensity || 0.5));
    return { ...base, wetGain: intensity > 0 ? base.wetGain : 0 };
  }

  const WET_TRANSFER_BY_INTENSITY = [0.5814, 0.6193, 0.6698, 0.7384];

  const MIX_HEADROOM = 0.9;

  function wetTransferForIntensity(intensity) {
    const numeric = Number(intensity);
    const i = Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 0;
    const span = WET_TRANSFER_BY_INTENSITY.length - 1;
    const index = i * span;
    const lo = Math.min(span, Math.floor(index));
    const hi = Math.min(span, lo + 1);
    const k = WET_TRANSFER_BY_INTENSITY[lo] + (WET_TRANSFER_BY_INTENSITY[hi] - WET_TRANSFER_BY_INTENSITY[lo]) * (index - lo);
    return Math.max(1e-6, k);
  }

  function computeMixLevels(intensity) {
    const params = computePostParams(intensity);
    const wet = params.wetGain;
    return {
      params,
      dry: MIX_HEADROOM * Math.sqrt(Math.max(0, 1 - wet * wet)),
      comp: MIX_HEADROOM / wetTransferForIntensity(intensity),
    };
  }

  function rampGain(param, value, tau = 0.015) {
    if (!param || !state.context) return;
    param.setTargetAtTime(value, state.context.currentTime, tau);
  }

  function hardZero(param) {
    if (!param || !state.context) return;
    try {
      param.cancelScheduledValues(state.context.currentTime);
    } catch {
    }
    param.setValueAtTime(0, state.context.currentTime);
  }

  function updateWetChain(controller) {
    if (!controller.dattorroNode) return;
    const levels = computeMixLevels(state.settings.reverbIntensity);
    const { params } = levels;
    const signature = JSON.stringify(params);
    if (signature === controller.lastPostedParams) return;
    controller.lastPostedParams = signature;
    controller.dattorroNode.port.postMessage({ type: 'setParams', params });
    applyMixLevels(controller, levels);
  }

  function applyMixLevels(controller, levels) {
    if (controller.dryGain) rampGain(controller.dryGain.gain, levels.dry);
    if (controller.reverbCompGain) rampGain(controller.reverbCompGain.gain, levels.comp);
  }

  function pitchStateMatches(media, intended) {
    const keys = ['preservesPitch', 'mozPreservesPitch', 'webkitPreservesPitch'];
    for (const key of keys) {
      if (!(key in media) || typeof intended[key] === 'undefined') continue;
      if (media[key] !== intended[key]) return false;
    }
    return true;
  }

  function resetMuteDampener(controller) {
    if (!controller) return;
    controller.muteCorrections.length = 0;
    controller.mutePausedUntil = 0;
    controller.budgetBypassed = false;
    controller.budgetBypassedUntil = 0;
  }

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

  function settleAttachedVolume() {
    for (const controller of state.media.values()) {
      if (!controller.attached || !controller.media) continue;
      const media = controller.media;
      if (media.muted === false) {
        controller.internalMuteWrite = true;
        try {
          media.muted = true;
        } finally {
          queueMicrotask(() => {
            controller.internalMuteWrite = false;
          });
        }
        controller.budgetBypassed = false;
        controller.budgetBypassedUntil = 0;
      }
      if (controller.masterGain && !controller.sourceStale) {
        rampGain(controller.masterGain.gain, media.volume);
      }
    }
  }

  function enforceElementMute(controller) {
    if (!isAudible(controller)) return;
    const media = controller.media;
    if (!media || media.muted === true) return;
    if (controller.internalMuteWrite) return;
    if (!claimMuteCorrection(controller)) {
      const pausedUntil = controller.mutePausedUntil;
      controller.budgetBypassed = true;
      controller.budgetBypassedUntil = pausedUntil;
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

  function intendedPlaybackState(controller, rate) {
    const neutral = Math.abs(rate - 1) < 0.001;
    return {
      neutral,
      intendedRate: neutral ? controller.originalRate : parseFloat(rate.toFixed(2)),
      intendedPitch: neutral
        ? controller.originalPitch
        : { preservesPitch: false, mozPreservesPitch: false, webkitPreservesPitch: false },
    };
  }

  function writeIntendedRate(controller, rate) {
    const media = controller.media;
    const { neutral, intendedRate, intendedPitch } = intendedPlaybackState(controller, rate);
    if (media.playbackRate === intendedRate && pitchStateMatches(media, intendedPitch)) return true;

    controller.internalRateWrite = true;

    try {
      if (neutral) {
        applyPitchState(media, controller.originalPitch);
        media.playbackRate = controller.originalRate;
      } else {
        setPreservesPitch(media, false);
        media.playbackRate = parseFloat(rate.toFixed(2));
      }
    } finally {
      queueMicrotask(() => {
        controller.internalRateWrite = false;
      });
    }
    return media.playbackRate === intendedRate && pitchStateMatches(media, intendedPitch);
  }

  function alignBeforeAudible(controller) {
    if (!controller.attached) return false;

    if (!writeIntendedRate(controller, state.settings.slow)) {
      if (controller.masterGain) hardZero(controller.masterGain.gain);
      controller.sourceStale = true;
      return false;
    }

    controller.sourceStale = false;
    applyMixLevels(controller, computeMixLevels(state.settings.reverbIntensity));
    if (controller.masterGain) {
      rampGain(controller.masterGain.gain, controller.media.volume);
    }
    return true;
  }

  function setMediaPlaybackState(controller, rate) {
    const media = controller.media;
    const { intendedRate, intendedPitch } = intendedPlaybackState(controller, rate);
    const intendedMuted = isAudible(controller);

    if (media.playbackRate === intendedRate && media.muted === intendedMuted && pitchStateMatches(media, intendedPitch)) {
      return;
    }

    writeIntendedRate(controller, rate);

    if (intendedMuted) {
      enforceElementMute(controller);
    } else {
      media.muted = false;
    }
  }

  function teardownController(controller, removeCompletely, context) {
    if (!controller) return;
    cancelAttachRetry(controller);
    bumpGeneration(controller);

    if (controller.attached) {
      disconnectNode(controller.source);
      disconnectNode(controller.dryGain);
      disconnectNode(controller.reverbCompGain);
      disconnectNode(controller.masterGain);
      if (controller.dattorroNode) {
        try { controller.dattorroNode.disconnect(); } catch {}
      }
      if (controller.stream) {
        controller.stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {
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
    controller.reverbCompGain = null;
    controller.masterGain = null;
    controller.dattorroNode = null;

    if (removeCompletely && state.media.size <= 1) {
      clearSafetyPoll();
    }
    try {
      maybeSuspendContext();
    } catch {
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
    if (media && media.isConnected === false) {
      try {
        media.pause();
      } catch {
      }
    }
    resetMuteDampener(controller);
    controller.internalRateWrite = true;

    try {
      applyPitchState(media, controller.originalPitch);
      media.playbackRate = controller.originalRate;
      media.muted = false;
    } catch {
    } finally {
      queueMicrotask(() => {
        controller.internalRateWrite = false;
      });
    }
  }

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
