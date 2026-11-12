(() => {
  const SENTINEL = '__slowedReverbAudioPageHook';
  const existing = window[SENTINEL];

  // The content script mints a token into the shared DOM and drops any READY
  // that does not carry it. The hook must echo the live token, not post a
  // tokenless READY that can never be verified.
  function pageToken() {
    try {
      return (document.documentElement && document.documentElement.dataset.slraToken) || '';
    } catch {
      return '';
    }
  }

  function emit(type, reason, extra) {
    window.postMessage({
      __slra: true,
      type,
      reason: String(reason || ''),
      href: location.href,
      ...(extra || {}),
    }, '*');
  }

  function revive(reason) {
    emit('SLRA_PAGE_REVIVE', reason);
  }

  // Volume is written through YouTube's own player API so its slider stays
  // truthful and the content script's gain mirror keeps carrying media.volume.
  // The reply is always posted, even when the API is missing: the content
  // script then falls back to element volume itself.
  function playerApi() {
    try {
      const player = document.querySelector('#movie_player');
      if (!player) return null;
      if (typeof player.setVolume !== 'function') return null;
      if (typeof player.getVolume !== 'function') return null;
      return player;
    } catch {
      return null;
    }
  }

  function readPlayerVolume() {
    const player = playerApi();
    if (!player) return { volume: null, source: 'none' };
    try {
      const value = Number(player.getVolume());
      if (!Number.isFinite(value)) return { volume: null, source: 'none' };
      return { volume: Math.max(0, Math.min(100, value)), source: 'player' };
    } catch {
      return { volume: null, source: 'none' };
    }
  }

  // The content script owns `muted` while the graph is attached; a volume write
  // can flip it back, so the same task re-asserts the contract. Unmuting is
  // reserved for a detach of a session that had attached (we muted it).
  function setVideoMuted(muted) {
    try {
      const video = document.querySelector('video');
      if (video) video.muted = muted;
    } catch {
      // No element to touch.
    }
  }

  /**
   * Ordered attach state, posted by the content script on every attach and
   * before every teardown unmute. A SET_VOLUME may still be in flight when the
   * graph detaches, so `keepMuted` is honored only for the session that is
   * attached right now. When a detach arrives first, the late set sees
   * `attached: false` and skips the mute; when the set arrives first, this
   * handler unmutes after it. Both orders end unmuted.
   */
  function handleAttachState(data) {
    const previous = state.attach;
    const session = typeof data.session === 'string' ? data.session : '';
    const attached = data.attached === true;
    state.attach = { session: session, attached: attached };
    if (!attached && previous.attached) setVideoMuted(false);
  }

  function replyVolume(data, volume, applied, source) {
    emit('SLRA_VOLUME_STATE', '', {
      id: data.id,
      token: pageToken(),
      volume,
      applied,
      source,
    });
  }

  function handleVolumeRequest(data) {
    const token = pageToken();
    if (!token) return;
    if (typeof data.token !== 'string' || data.token !== token) return;

    if (data.type === 'SLRA_GET_VOLUME') {
      const reading = readPlayerVolume();
      replyVolume(data, reading.volume, reading.source === 'player', reading.source);
      return;
    }

    const keepMuted = data.keepMuted === true
      && state.attach.attached === true
      && state.attach.session === String(data.session || '');
    const percent = Number(data.percent);
    if (!Number.isFinite(percent)) {
      const reading = readPlayerVolume();
      replyVolume(data, reading.volume, false, reading.source);
      return;
    }

    const target = Math.max(0, Math.min(100, Math.round(percent)));
    const player = playerApi();
    if (!player) {
      if (keepMuted) setVideoMuted(true);
      replyVolume(data, null, false, 'none');
      return;
    }
    try {
      player.setVolume(target);
    } catch {
      if (keepMuted) setVideoMuted(true);
      replyVolume(data, null, false, 'none');
      return;
    }
    if (keepMuted) setVideoMuted(true);
    const reading = readPlayerVolume();
    replyVolume(data, reading.volume === null ? target : reading.volume, true, 'player');
  }

  if (existing?.revive) {
    existing.revive('reinject');
    return;
  }

  const state = {
    listenersReady: false,
    attach: { session: '', attached: false },
  };

  function ensureListeners() {
    if (state.listenersReady) return;

    // Volume and attach-state messages arrive on the same window bus as the
    // lifecycle signals; the token check keeps a page-injected message out.
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.__slra !== true) return;
      if (typeof data.token !== 'string' || data.token.length === 0) return;
      if (data.token !== pageToken()) return;
      if (data.type === 'SLRA_ATTACH_STATE') {
        handleAttachState(data);
        return;
      }
      if (data.type !== 'SLRA_SET_VOLUME' && data.type !== 'SLRA_GET_VOLUME') return;
      handleVolumeRequest(data);
    }, false);

    const reviveNow = (reason) => revive(reason);

    window.addEventListener('pageshow', () => reviveNow('pageshow'), { passive: true });
    window.addEventListener('focus', () => reviveNow('focus'), { passive: true });
    window.addEventListener('popstate', () => reviveNow('popstate'), { passive: true });
    window.addEventListener('hashchange', () => reviveNow('hashchange'), { passive: true });
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reviveNow('visibilitychange');
    }, { passive: true });

    ['yt-navigate-start', 'yt-navigate-finish', 'yt-page-data-updated', 'spfdone'].forEach((eventName) => {
      window.addEventListener(eventName, () => reviveNow(eventName), true);
    });

    state.listenersReady = true;
  }

  window[SENTINEL] = {
    revive(reason) {
      revive(reason);
    },
  };

  ensureListeners();
  emit('SLRA_PAGE_HOOK_READY', 'install', { token: pageToken() });
  revive('install');
})();
