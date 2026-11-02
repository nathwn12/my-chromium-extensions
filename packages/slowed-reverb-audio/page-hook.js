(() => {
  const SENTINEL = '__slowedReverbAudioPageHook';
  const existing = window[SENTINEL];

  function emit(type, reason) {
    window.postMessage({
      __slra: true,
      type,
      reason: String(reason || ''),
      href: location.href,
    }, '*');
  }

  function revive(reason) {
    emit('SLRA_PAGE_REVIVE', reason);
  }

  if (existing?.revive) {
    existing.revive('reinject');
    return;
  }

  const state = {
    listenersReady: false,
  };

  function ensureListeners() {
    if (state.listenersReady) return;

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
  emit('SLRA_PAGE_HOOK_READY', 'install');
  revive('install');
})();
