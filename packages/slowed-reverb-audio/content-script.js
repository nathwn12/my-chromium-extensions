(() => {
  const existing = globalThis.__slowedReverbAudioContent;
  if (existing?.refresh) {
    existing.refresh();
    return;
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
    scanQueued: false,
    hookRefreshQueued: false,
    context: null,
    listenersReady: false,
    lifecycleListenersReady: false,
    pageHookReady: false,
    lastError: '',
    workletLoaded: false,
    lastNonzeroIntensity: 0,
  };

  globalThis.__slowedReverbAudioContent = {
    refresh() {
      queueScan();
      void bootstrap(false);
    },
  };

  void bootstrap(true);

  async function bootstrap(ensureHooks) {
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
        applyRuntimeState({ bypass: !message.enabled });
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
      syncMediaController(controller);
      void resumeContext().then(() => {
        syncMediaController(controller);
      });
    }, true);

    document.addEventListener('playing', (event) => {
      const media = event.target;
      if (!(media instanceof HTMLMediaElement)) return;
      trackMedia(media);
      void resumeContext().then(() => {
        syncMediaController(state.media.get(media));
      });
    }, true);

    ['pointerdown', 'keydown', 'mousedown', 'touchstart'].forEach((eventName) => {
      window.addEventListener(eventName, () => {
        void resumeContext().then(() => {
          syncAllMedia();
        });
      }, { passive: true, capture: true });
    });

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

    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.__slra !== true) return;

      if (data.type === 'SLRA_PAGE_REVIVE') {
        queueRecovery(data.reason || 'page-hook');
      }

      if (data.type === 'SLRA_PAGE_HOOK_READY') {
        state.pageHookReady = true;
        state.lastError = '';
      }
    });

    ['yt-navigate-start', 'yt-navigate-finish', 'yt-page-data-updated', 'spfdone'].forEach((eventName) => {
      window.addEventListener(eventName, () => revive(eventName), true);
    });

    state.lifecycleListenersReady = true;
  }

  function ensureObserver() {
    if (state.observer) return;

    let observerTimer = null;

    state.observer = new MutationObserver(() => {
      if (observerTimer) return;
      observerTimer = setTimeout(() => {
        observerTimer = null;
        queueScan();
      }, 50);
    });

    const root = document.documentElement || document;
    state.observer.observe(root, { childList: true, subtree: true });
  }

function applyRuntimeState(runtime) {
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

  function queueScan() {
    if (state.scanQueued) return;
    state.scanQueued = true;
    queueMicrotask(() => {
      state.scanQueued = false;
      scanMediaElements();
      syncAllMedia();
    });
  }

  let recoveryTimer = null;
  let rateWatchdogTimer = null;
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

    try {
      await chrome.runtime.sendMessage({
        type: 'ENSURE_TAB_HOOKS',
        reason: String(reason || 'recovery'),
      });
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
    document.querySelectorAll('audio,video').forEach((media) => {
      if (media instanceof HTMLMediaElement) {
        trackMedia(media);
      }
    });

    for (const [media, controller] of state.media.entries()) {
      if (media.isConnected) continue;
      teardownController(controller, true, state.context);
      state.media.delete(media);
    }
  }

  function trackMedia(media) {
    if (state.media.has(media)) return state.media.get(media);

    const controller = {
      media,
      attached: false,
      attachedSrc: '',
      sourceStale: false,
      failed: false,
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
      if (controller.attached) {
        controller.sourceStale = true;
        if (controller.masterGain) {
          rampGain(controller.masterGain.gain, 0);
        }
        controller.media.muted = false;
      }
      queueCriticalRecovery('emptied');
    };

    controller.loadHandler = () => {
      if (controller.attached) {
        controller.sourceStale = true;
        if (controller.masterGain) {
          rampGain(controller.masterGain.gain, 0);
        }
        controller.media.muted = false;
      }
      queueCriticalRecovery('loadedmetadata');
    };

    controller.volumeHandler = () => {
      if (controller.attached && controller.masterGain) {
        rampGain(controller.masterGain.gain, controller.media.volume);
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

  function shouldBeActiveForController(controller) {
    return state.eligible && !state.bypass && controller && controller.attached && !controller.failed;
  }

  function syncAllMedia(retryCount = 0) {
    for (const controller of state.media.values()) {
      syncMediaController(controller, retryCount);
    }
    if (state.eligible && !state.bypass && rateWatchdogTimer === null) {
      startRateWatchdog();
    } else if ((!state.eligible || state.bypass) && rateWatchdogTimer !== null) {
      stopRateWatchdog();
    }
  }

  function syncMediaController(controller, retryCount = 0) {
    if (!controller || !controller.media.isConnected) return;

    if (!state.eligible || state.bypass) {
      applyBypassState(controller);
      return;
    }

    void resumeContext();
    if (!ensureAttached(controller)) {
      scheduleAttachRetry(controller, retryCount);
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
      teardownController(controller, false, state.context);
      return;
    }
    const delay = Math.min(200 * (attempt + 1), ATTACH_RETRY_MAX_DELAY_MS);
    controller.attachAttempts = attempt + 1;
    controller.pendingRetry = setTimeout(() => {
      controller.pendingRetry = null;
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

  function ensureAttached(controller) {
    if (controller.attached) {
      if (controller.sourceStale) {
        // Source-only swap: keep the tank circulating, wait for a usable new src.
        if (!controller.media.currentSrc || !isMediaReadyForAttach(controller.media)) {
          return false;
        }
        return rebuildStreamSource(controller);
      }

      const currentSrc = controller.media.currentSrc;
      if (!currentSrc || currentSrc === controller.attachedSrc) {
        return true;
      }
      teardownController(controller, false, state.context);
    }
    if (!isMediaReadyForAttach(controller.media)) return false;

    const context = getAudioContext();
    if (!state.workletLoaded || context.state !== 'running') return false;

    controller.failed = false;
    controller.attachError = '';

    try {
      const stream = captureMediaStream(controller.media);
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

        // No audio track yet: leave the element unmuted and retry later rather
        // than muting it against a silent stream (mirrors rebuildStreamSource).
        stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {
            // Track already stopped.
          }
        });
        controller.sourceStale = true;
        controller.media.muted = false;
        return false;
      }

      const source = context.createMediaStreamSource(stream);
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
      rampGain(dryGain.gain, 1 - initialParams.wetGain);
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
      void resumeContext().then(() => {
        syncMediaController(controller, 0);
      });
      return true;
    } catch (error) {
      controller.failed = true;
      controller.attachError = 'Could not attach audio effect.';
      state.lastError = String(error && error.message ? error.message : error);
      return false;
    }
  }

  function rebuildStreamSource(controller) {
    let capturedStream = null;
    try {
      const stream = captureMediaStream(controller.media);
      if (!stream) {
        throw new Error('captureStream unavailable for this media element.');
      }
      capturedStream = stream;

      if (!stream.getAudioTracks().length) {
        // No audio track yet: leave the element unmuted and retry later rather
        // than muting it against a silent stream.
        stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {
            // Track already stopped.
          }
        });
        controller.sourceStale = true;
        controller.media.muted = false;
        return false;
      }

      const source = state.context.createMediaStreamSource(stream);
      source.connect(controller.dryGain);
      source.connect(controller.dattorroNode);

      const previousSource = controller.source;
      const previousStream = controller.stream;

      controller.source = source;
      controller.stream = stream;
      controller.attachedSrc = controller.media.currentSrc;
      controller.sourceStale = false;
      controller.failed = false;
      controller.attachError = '';

      void resumeContext();
      if (controller.masterGain) {
        rampGain(controller.masterGain.gain, controller.media.volume);
      }

      // The stale window unmuted the element on purpose; a live source means
      // the element goes back to mirroring `attached`.
      enforceElementMute(controller);

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
      return true;
    } catch (error) {
      // Never leave the element muted without an audio path.
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
    }
  }

  function getAudioContext() {
    if (!state.context) {
      // Chromium-only: AudioContext is unprefixed since Chrome 35 (2014).
      state.context = new AudioContext();
      void loadWorklet(state.context);
    }
    return state.context;
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
      const url = chrome.runtime.getURL('dattorro-worklet.js');
      await context.audioWorklet.addModule(url);
      state.workletLoaded = true;
      syncAllMedia();
    } catch (e) {
      state.lastError = 'Worklet: ' + (e.message || e);
    }
  }

  function computeDattorroParams(intensity) {
    const i = Math.max(0, Math.min(1, intensity));
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
      wetGain: Math.pow(i, 0.75) * 0.42,
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

  function updateWetChain(controller) {
    if (!controller.dattorroNode) return;
    const params = computePostParams(state.settings.reverbIntensity);
    const signature = JSON.stringify(params);
    if (signature === controller.lastPostedParams) return;
    controller.lastPostedParams = signature;
    controller.dattorroNode.port.postMessage({ type: 'setParams', params });
    if (controller.dryGain) {
      rampGain(controller.dryGain.gain, 1 - params.wetGain);
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
    if (!controller || !controller.attached || controller.sourceStale) return;
    const media = controller.media;
    if (!media || media.muted === true) return;
    if (controller.internalMuteWrite) return;
    if (!claimMuteCorrection(controller)) return;

    controller.internalMuteWrite = true;

    try {
      media.muted = true;
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
    const intendedMuted = controller.attached && !controller.sourceStale;

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

    if ((state.bypass || !state.eligible || removeCompletely) && context && typeof context.suspend === 'function') {
      let anyAttached = false;
      for (const remaining of state.media.values()) {
        if (remaining.attached) {
          anyAttached = true;
          break;
        }
      }
      if (!anyAttached && context.state === 'running') {
        try {
          void Promise.resolve(context.suspend()).catch(() => {
            // Best effort only.
          });
        } catch {
          // Best effort only.
        }
      }
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
    resetMuteDampener(controller);
    controller.internalRateWrite = true;

    try {
      applyPitchState(media, controller.originalPitch);
      media.playbackRate = controller.originalRate;
      media.muted = controller.originalMuted;
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

    for (const controller of state.media.values()) {
      if (controller.failed) failedCount += 1;
      if (controller.attached) attachedCount += 1;
    }

    const totalCount = state.media.size;
    const active = state.eligible && !state.bypass;
    let text = 'Waiting for media.';

    if (!state.eligible) {
      text = 'Unsupported page.';
    } else if (state.bypass) {
      text = 'Power off for this tab.';
    } else if (failedCount && !attachedCount) {
      text = 'Could not attach to page audio.';
    } else if (!totalCount) {
      text = 'Waiting for media.';
    } else if (isNeutral(state.settings)) {
      text = 'Active, neutral.';
    } else if (failedCount) {
      text = 'Active with some attach failures.';
    } else {
      text = 'Active.';
    }

    return {
      ok: true,
      eligible: state.eligible,
      bypass: state.bypass,
      active,
      neutral: active && isNeutral(state.settings),
      attachedCount,
      failedCount,
      totalCount,
      contextState: state.context ? state.context.state : 'idle',
      text,
      error: state.lastError || '',
    };
  }
})();
