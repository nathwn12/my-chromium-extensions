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
    // A re-bind is the normal case here (element replacement, SPA navigation):
    // re-state the id on every revive; deduped when it has not changed.
    postSong('revive:' + String(reason || ''), false);
  }

  // Volume only. This hook never writes `muted`: the content script is the only
  // writer of that flag, and its volumechange enforcement corrects a flip. A
  // second mute writer is exactly the bug that re-muted a detached graph.
  //
  // The token is an anti-collision marker, not authentication: a page script can
  // read it and forge a volume message, which can only change its own volume.
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

  /**
   * The real song id. The URL alone is not identity: YouTube Music Home plays
   * from `/` with no `?v=`, and the player can swap tracks without the URL
   * naming one. `getVideoData().video_id` is the player's own answer for the
   * media that is loaded, in song mode and video mode alike.
   */
  function playerSong() {
    try {
      const player = document.querySelector('#movie_player');
      if (!player || typeof player.getVideoData !== 'function') return null;
      const data = player.getVideoData();
      if (!data || typeof data !== 'object') return null;
      const videoId = typeof data.video_id === 'string' && data.video_id !== '' ? data.video_id : null;
      if (videoId === null) return null;
      return { videoId: videoId, title: typeof data.title === 'string' ? data.title : '' };
    } catch {
      return null;
    }
  }

  /**
   * Pushes the current id (or null) so the content script never depends on the
   * URL. Forced on song events; deduped on soft signals so a revive storm does
   * not re-post the same id.
   */
  function postSong(reason, force) {
    const song = playerSong();
    const videoId = song ? song.videoId : null;
    if (!force && state.songPosted && state.lastSongId === videoId) return;
    state.songPosted = true;
    state.lastSongId = videoId;
    emit('SLRA_SONG', reason, { token: pageToken(), videoId, title: song ? song.title : '' });
  }

  // --- YTM's own slider, tooltip and hover state -------------------------
  // setVolume() changes playback but not the rendered control; without this the
  // slider sits where the user left it while the audio moves. Mirrors pear's
  // precise-volume (updateVolumeSlider / setTooltip / showVolumeSlider).

  const VOLUME_SLIDER = '#volume-slider';
  const EXPAND_VOLUME_SLIDER = '#expand-volume-slider';
  const VOLUME_TOOLTIPS = [
    '#volume-slider',
    'tp-yt-paper-icon-button.volume',
    '#expand-volume-slider',
    '#expand-volume',
  ];
  const VOLUME_SLIDER_HIDE_MS = 2500;

  function setSliderValue(selector, percent) {
    try {
      const slider = document.querySelector(selector);
      if (!slider) return;
      slider.value = String(percent);
      if (typeof slider.setAttribute === 'function') slider.setAttribute('value', String(percent));
    } catch {
      // A slider that rejects writes is not worth a failure.
    }
  }

  function setVolumeTooltip(percent) {
    for (const selector of VOLUME_TOOLTIPS) {
      try {
        const target = document.querySelector(selector);
        if (target) target.title = percent + '%';
      } catch {
        // Ignore a hostile node.
      }
    }
  }

  function showVolumeSlider() {
    let slider = null;
    try {
      slider = document.querySelector(VOLUME_SLIDER);
    } catch {
      slider = null;
    }
    if (!slider) return;
    try {
      slider.classList.add('on-hover');
    } catch {
      return;
    }
    if (state.sliderHideTimer !== null) clearTimeout(state.sliderHideTimer);
    state.sliderHideTimer = setTimeout(() => {
      state.sliderHideTimer = null;
      try {
        slider.classList.remove('on-hover');
      } catch {
        // Detached.
      }
    }, VOLUME_SLIDER_HIDE_MS);
  }

  /**
   * Mirrors the applied percentage into YouTube Music's control. No input/change
   * event is dispatched: that could loop back into YTM's own volume write.
   */
  function syncVolumeUi(percent) {
    const value = Number(percent);
    if (!Number.isFinite(value)) return;
    const applied = Math.max(0, Math.min(100, Math.round(value)));
    setSliderValue(VOLUME_SLIDER, applied);
    setSliderValue(EXPAND_VOLUME_SLIDER, applied);
    setVolumeTooltip(applied);
    showVolumeSlider();
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
    const percent = Number(data.percent);
    if (!Number.isFinite(percent)) {
      const reading = readPlayerVolume();
      replyVolume(data, reading.volume, false, reading.source);
      return;
    }

    const target = Math.max(0, Math.min(100, Math.round(percent)));
    const player = playerApi();
    if (!player) {
      replyVolume(data, null, false, 'none');
      return;
    }
    try {
      player.setVolume(target);
    } catch {
      replyVolume(data, null, false, 'none');
      return;
    }
    // The read-back is the truth: the page may land on its own value.
    const reading = readPlayerVolume();
    const applied = reading.volume === null ? target : Math.round(reading.volume);
    syncVolumeUi(applied);
    replyVolume(data, applied, true, 'player');
  }

  if (existing?.revive) {
    existing.revive('reinject');
    return;
  }

  const state = {
    listenersReady: false,
    lastSongId: null,
    songPosted: false,
    sliderHideTimer: null,
  };

  function ensureListeners() {
    if (state.listenersReady) return;

    // Volume requests arrive on the same window bus as the lifecycle signals.
    // The token is an anti-collision marker, not authentication: it keeps a
    // stale request from an earlier injection from being applied, and a page
    // script that forges one can only change its own volume.
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.__slra !== true) return;
      if (data.type !== 'SLRA_SET_VOLUME' && data.type !== 'SLRA_SYNC_VOLUME_UI') return;
      if (typeof data.token !== 'string' || data.token.length === 0) return;
      if (data.token !== pageToken()) return;
      // The content script asks for the UI sync when it wrote media.volume
      // itself (no page player API available).
      if (data.type === 'SLRA_SYNC_VOLUME_UI') {
        syncVolumeUi(Number(data.percent));
        return;
      }
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

    // `videodatachange` is dispatched on document and may not bubble; capture
    // catches both. `loadedmetadata` fires on the replaced <video> and does not
    // bubble, but capture still traverses it.
    document.addEventListener('videodatachange', () => postSong('videodatachange', true), true);
    document.addEventListener('loadedmetadata', () => postSong('loadedmetadata', true), true);
    window.addEventListener('yt-navigate-finish', () => postSong('yt-navigate-finish', true), true);

    state.listenersReady = true;
  }

  window[SENTINEL] = {
    revive(reason) {
      revive(reason);
    },
  };

  ensureListeners();
  emit('SLRA_PAGE_HOOK_READY', 'install', { token: pageToken() });
  postSong('install', true);
  revive('install');
})();
