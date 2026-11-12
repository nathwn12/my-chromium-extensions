/* global module */
/*
 * player-actions.js - easy volume (wheel over non-scrolling player chrome) and
 * section repeat (A-B loop) for YouTube Music.
 *
 * Ported from pear-slowed-reverb: precise-volume/renderer.ts (wheel + HUD) and
 * section-repeat/{engine,saved,section,controller}.ts at a418ecb8.
 *
 * Two halves:
 *   - the pure engine (time parsing, loop thresholds, saved sections, the wheel
 *     predicate and accumulator, song latches). No DOM, no chrome APIs.
 *   - createPlayerActions(), the thin DOM controller the content script starts.
 *
 * No new permission, no second volume path: the wheel writes volume through the
 * page player API (page-hook.js) and falls back to media.volume, which the
 * existing graph mirrors. This module never creates a gain node and never
 * writes `muted`.
 */
(function (root) {
  'use strict';

  const WHEEL_PX_PER_STEP = 100;
  const VOLUME_STEP_PCT = 5;
  const TICK_MS = 100;
  const HUD_VISIBLE_MS = 1200;
  const SAVED_LIMIT = 100;
  const SEEK_RETRY_MS = 120;
  const SEEK_RETRY_ATTEMPTS = 3;
  const SEEK_TOLERANCE_SECONDS = 0.25;
  const SETTLE_MS = 1200;
  const SETTLE_NEAR_ZERO_SECONDS = 1;
  const STORAGE_KEY = 'playerActions';
  const HOST_ATTR = 'data-slra-player-actions';

  const TIME_PART = /^\d+$/;
  const FIELD_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
  const SCROLL_OVERFLOW = new Set(['auto', 'scroll', 'overlay']);
  const SONG_EVENTS = ['yt-navigate-finish', 'yt-page-data-updated', 'popstate', 'hashchange'];
  const USER_INPUT_EVENTS = ['pointerdown', 'keydown', 'touchstart'];

  // -------------------------------------------------------------------------
  // Loop engine (verbatim behavior from pear engine.ts)
  // -------------------------------------------------------------------------

  function parseTimeInput(raw) {
    const trimmed = String(raw === undefined || raw === null ? '' : raw).trim();
    if (trimmed === '') return { kind: 'empty' };

    const parts = trimmed.split(':');
    if (parts.length > 3) return { kind: 'invalid' };

    const values = [];
    for (const part of parts) {
      if (!TIME_PART.test(part)) return { kind: 'invalid' };
      const value = Number(part);
      if (!Number.isFinite(value)) return { kind: 'invalid' };
      values.push(value);
    }

    let seconds;
    if (values.length === 1) {
      seconds = values[0];
    } else if (values.length === 2) {
      const minutes = values[0];
      const secs = values[1];
      if (secs >= 60) return { kind: 'invalid' };
      seconds = minutes * 60 + secs;
    } else {
      const hours = values[0];
      const minutes = values[1];
      const secs = values[2];
      if (minutes >= 60 || secs >= 60) return { kind: 'invalid' };
      seconds = hours * 3600 + minutes * 60 + secs;
    }

    if (!Number.isFinite(seconds) || seconds < 0) return { kind: 'invalid' };
    return { kind: 'time', seconds };
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';

    const total = Math.floor(seconds);
    const secs = total % 60;
    const minutes = Math.floor((total % 3600) / 60);
    const hours = Math.floor(total / 3600);
    const pad = (value) => String(value).padStart(2, '0');

    if (hours > 0) return hours + ':' + pad(minutes) + ':' + pad(secs);
    return minutes + ':' + pad(secs);
  }

  function isLoopEngaged(state) {
    return Boolean(state) && state.active === true && (state.startSeconds !== null || state.endSeconds !== null);
  }

  function resolveArmedLoop(state, duration) {
    if (!isLoopEngaged(state)) return null;

    // Blank From means the start of the song.
    const start = state.startSeconds === null ? 0 : state.startSeconds;
    if (!Number.isFinite(start)) return null;

    const end = state.endSeconds === null ? duration : state.endSeconds;
    if (!Number.isFinite(end)) return null;

    // A typed end at or past the song end sits just before the end instead of
    // beyond it, so the trigger is reachable.
    const clampedToSongEnd = state.endSeconds !== null && Number.isFinite(duration) && end >= duration;
    const toSongEnd = state.endSeconds === null || clampedToSongEnd;
    const loopEnd = toSongEnd ? duration : end;
    const threshold = toSongEnd ? loopEnd - 0.3 : loopEnd - 0.05;
    if (!Number.isFinite(threshold)) return null;
    // A range collapsed to 50 ms or less would re-seek on every tick.
    if (!(threshold > start + 0.05)) return null;
    return { start: start, threshold: threshold };
  }

  function resolveSeekTarget(state, player) {
    const sample = player || {};
    const armed = resolveArmedLoop(state, sample.duration);
    if (armed === null) return null;
    if (sample.paused || sample.seeking) return null;
    if (!Number.isFinite(sample.currentTime)) return null;
    return sample.currentTime >= armed.threshold ? armed.start : null;
  }

  function resolveEndSeekTarget(state, duration) {
    const armed = resolveArmedLoop(state, duration);
    return armed === null ? null : armed.start;
  }

  // -------------------------------------------------------------------------
  // Saved sections (verbatim behavior from pear saved.ts, plus the 100 cap)
  // -------------------------------------------------------------------------

  function sanitizeTime(value) {
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
    return value;
  }

  function sanitizeEntry(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const videoId = raw.videoId;
    if (typeof videoId !== 'string' || videoId === '') return null;

    const startSeconds = sanitizeTime(raw.startSeconds);
    const endSeconds = sanitizeTime(raw.endSeconds);
    if (startSeconds === undefined || endSeconds === undefined) return null;
    if (startSeconds === null && endSeconds === null) return null;

    return { videoId: videoId, startSeconds: startSeconds, endSeconds: endSeconds };
  }

  function sanitizeSaved(raw) {
    if (!Array.isArray(raw)) return [];
    const sanitized = [];
    for (const item of raw) {
      const itemValue = sanitizeEntry(item);
      if (itemValue === null) continue;
      const previous = sanitized.findIndex((existing) => existing.videoId === itemValue.videoId);
      if (previous !== -1) sanitized.splice(previous, 1);
      sanitized.push(itemValue);
    }
    return sanitized;
  }

  function lookupSaved(saved, videoId) {
    if (!Array.isArray(saved)) return null;
    for (let index = saved.length - 1; index >= 0; index -= 1) {
      if (saved[index].videoId === videoId) return saved[index];
    }
    return null;
  }

  function upsertSaved(saved, entry) {
    const remaining = (Array.isArray(saved) ? saved : []).filter((item) => item.videoId !== entry.videoId);
    if (entry.startSeconds === null && entry.endSeconds === null) return remaining;
    return [...remaining, entry];
  }

  /** Keeps the newest `limit` entries; the oldest fall off the front. */
  function capSaved(saved, limit) {
    const list = Array.isArray(saved) ? saved : [];
    const max = Number.isFinite(limit) ? limit : SAVED_LIMIT;
    if (list.length <= max) return list;
    return list.slice(list.length - max);
  }

  // -------------------------------------------------------------------------
  // Song identity and the restore latches
  // -------------------------------------------------------------------------

  /**
   * The URL's `v` param is the only song id. A media source is never used: blob
   * and signed track URLs are transient and can be reused by the next track, so
   * they cannot identify a song. No id means live looping still works, but
   * nothing is saved or restored.
   */
  function songKeyFrom(href) {
    try {
      const parsed = new URL(String(href === undefined || href === null ? '' : href));
      const videoId = parsed.searchParams.get('v');
      if (typeof videoId === 'string' && videoId !== '') return videoId;
    } catch {
      return null;
    }
    return null;
  }

  function createSectionSession() {
    return {
      songKey: null,
      restoredSongKey: null,
      identityKnown: false,
      startSeconds: null,
      endSeconds: null,
      pendingRestore: false,
    };
  }

  /**
   * Adopts a new song. A null key never changes anything: an id that has not
   * arrived yet must defer, not restore the previous song's section.
   */
  function beginSong(session, key) {
    if (key === null || key === undefined || key === '') return false;
    if (session.songKey === key) return false;
    session.songKey = key;
    session.restoredSongKey = null;
    session.startSeconds = null;
    session.endSeconds = null;
    session.pendingRestore = false;
    return true;
  }

  function songRestorePending(session, key) {
    if (key === null || key === undefined || key === '') return false;
    return session.restoredSongKey !== key;
  }

  function markSongRestored(session, key) {
    session.restoredSongKey = key;
  }

  function clearPendingRestore(session) {
    session.pendingRestore = false;
  }

  // -------------------------------------------------------------------------
  // Wheel: pixels, accumulation, predicate ladder
  // -------------------------------------------------------------------------

  function wheelPixels(event) {
    const deltaY = Number(event && event.deltaY);
    if (!Number.isFinite(deltaY)) return 0;
    const mode = Number(event && event.deltaMode);
    if (mode === 1) return deltaY * 16;
    if (mode === 2) return deltaY * 100;
    return deltaY;
  }

  function createWheelAccumulator() {
    return { remainder: 0 };
  }

  /**
   * Signed pixels accumulate; each crossed 100 px applies one 5 % step. Volume
   * is clamped at 0/100 and the accumulator is reset there, so running off the
   * end cannot bank steps for the way back.
   */
  function stepVolumeFromWheel(accumulator, event, currentVolume) {
    accumulator.remainder += wheelPixels(event);

    let steps = 0;
    while (accumulator.remainder <= -WHEEL_PX_PER_STEP) {
      accumulator.remainder += WHEEL_PX_PER_STEP;
      steps += 1;
    }
    while (accumulator.remainder >= WHEEL_PX_PER_STEP) {
      accumulator.remainder -= WHEEL_PX_PER_STEP;
      steps -= 1;
    }
    if (steps === 0) return { steps: 0, volume: null, applied: false };

    const current = Number(currentVolume);
    const base = Number.isFinite(current) ? Math.round(current) : 0;
    const next = Math.min(100, Math.max(0, base + steps * VOLUME_STEP_PCT));
    if (next === 0 || next === 100) accumulator.remainder = 0;
    return { steps: steps, volume: next, applied: next !== base };
  }

  function panelNode(node) {
    try {
      return Boolean(node) && typeof node.hasAttribute === 'function' && node.hasAttribute(HOST_ATTR);
    } catch {
      return false;
    }
  }

  function attributeOf(node, name) {
    try {
      return typeof node.getAttribute === 'function' ? node.getAttribute(name) : null;
    } catch {
      return null;
    }
  }

  function eventChain(event, target) {
    const chain = [];
    if (event && typeof event.composedPath === 'function') {
      try {
        for (const node of event.composedPath()) chain.push(node);
      } catch {
        // Fall back to the parent walk.
      }
    }
    if (chain.length === 0) {
      let node = target || null;
      while (node) {
        chain.push(node);
        node = node.parentElement || null;
      }
    }
    return chain;
  }

  function viewportHeight(doc) {
    if (!doc) return 0;
    const view = doc.defaultView;
    if (view && Number.isFinite(Number(view.innerHeight))) return Number(view.innerHeight);
    if (Number.isFinite(Number(doc.innerHeight))) return Number(doc.innerHeight);
    return 0;
  }

  function computedOverflowY(getStyle, node) {
    try {
      const computed = getStyle(node);
      if (!computed) return '';
      return String(computed.overflowY || '').toLowerCase();
    } catch {
      return '';
    }
  }

  /**
   * Ordered ladder: native scroll always wins over a volume step. The caller
   * must not preventDefault unless the verdict is `handle` and a step lands.
   */
  function shouldHandleWheel(event, target, doc, getStyle) {
    if (!event || event.defaultPrevented) return { handle: false, reason: 'default-prevented' };
    if (event.ctrlKey || event.metaKey || event.altKey) return { handle: false, reason: 'modifier' };
    if (!event.deltaY) return { handle: false, reason: 'no-delta' };

    const chain = eventChain(event, target);

    // The panel owns its own wheel.
    for (const node of chain) {
      if (panelNode(node)) return { handle: false, reason: 'panel' };
    }

    // Fields, contenteditable surfaces and open dialogs keep the wheel.
    for (const node of chain) {
      if (!node || typeof node !== 'object') continue;
      const tagName = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : '';
      if (FIELD_TAGS.has(tagName)) return { handle: false, reason: 'field' };
      if (node.isContentEditable === true) return { handle: false, reason: 'field' };
      const editable = attributeOf(node, 'contenteditable');
      if (editable !== null && editable !== 'false') return { handle: false, reason: 'field' };
      if (tagName === 'DIALOG' && typeof node.hasAttribute === 'function' && node.hasAttribute('open')) {
        return { handle: false, reason: 'dialog' };
      }
      if (attributeOf(node, 'aria-modal') === 'true') return { handle: false, reason: 'dialog' };
    }

    // Nearest scrollable ancestor: native scroll wins unless it is the document
    // scroller that does not actually scroll.
    const style = typeof getStyle === 'function' ? getStyle : () => null;
    const documentElement = doc ? doc.documentElement : null;
    const viewport = viewportHeight(doc);
    for (const node of chain) {
      if (!node || typeof node !== 'object') continue;
      if (!SCROLL_OVERFLOW.has(computedOverflowY(style, node))) continue;
      const scrollHeight = Number(node.scrollHeight);
      const clientHeight = Number(node.clientHeight);
      const overflows = scrollHeight > clientHeight + 1;
      if (!overflows) continue;
      if (node === documentElement || (doc && node === doc.body)) {
        if (scrollHeight > viewport + 1) return { handle: false, reason: 'document-scroller' };
        return { handle: true, reason: 'handle' };
      }
      return { handle: false, reason: 'scrollable-ancestor' };
    }

    return { handle: true, reason: 'handle' };
  }

  // -------------------------------------------------------------------------
  // DOM controller
  // -------------------------------------------------------------------------

  const PANEL_CSS = [
    ':host{position:fixed;right:16px;bottom:96px;z-index:2147483000;display:block;pointer-events:none;font:12px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#f1f1f1;}',
    '.slra-shell{display:flex;flex-direction:column;align-items:flex-end;gap:6px;}',
    '.slra-hud{min-width:54px;padding:4px 8px;border-radius:8px;background:rgba(0,0,0,.82);text-align:center;font-size:15px;font-weight:600;opacity:0;transition:opacity .15s ease;pointer-events:none;}',
    '.slra-hud.visible{opacity:1;}',
    '.slra-pill{pointer-events:auto;border:0;border-radius:999px;padding:6px 12px;background:rgba(0,0,0,.72);color:#f1f1f1;font:inherit;font-weight:600;cursor:pointer;}',
    '.slra-pill:hover{background:rgba(0,0,0,.85);}',
    '.slra-panel{display:none;pointer-events:auto;width:224px;padding:10px;border-radius:12px;background:rgba(15,15,15,.94);box-shadow:0 8px 24px rgba(0,0,0,.45);}',
    '.slra-panel.open{display:block;}',
    '.slra-row{display:flex;align-items:center;gap:6px;margin-bottom:6px;}',
    '.slra-row span{flex:1;}',
    '.slra-row input[type=checkbox]{margin:0;}',
    '.slra-field{width:64px;padding:3px 6px;border:1px solid #3a3a3a;border-radius:6px;background:#0d0d0d;color:#f1f1f1;font:inherit;}',
    '.slra-field[aria-invalid="true"]{border-color:#e05252;}',
    '.slra-now,.slra-button{pointer-events:auto;border:1px solid #3a3a3a;border-radius:6px;background:#1c1c1c;color:#f1f1f1;font:inherit;padding:3px 8px;cursor:pointer;}',
    '.slra-status{min-height:16px;margin:4px 0 8px;color:#b3b3b3;}',
    '.slra-status.invalid{color:#e05252;}',
    '.slra-actions{display:flex;gap:6px;}',
    '.slra-actions .slra-button{flex:1;}',
  ].join('\n');

  function createPlayerActions(options) {
    const settings = options || {};
    const win = settings.window;
    const doc = settings.document || (win && win.document);
    if (!win || !doc) throw new Error('player actions need a window and a document');

    const timers = settings.timers || {
      setTimeout: (fn, ms) => win.setTimeout(fn, ms),
      clearTimeout: (id) => win.clearTimeout(id),
      setInterval: (fn, ms) => win.setInterval(fn, ms),
      clearInterval: (id) => win.clearInterval(id),
    };
    const mediaProvider = typeof settings.mediaProvider === 'function'
      ? settings.mediaProvider
      : () => doc.querySelector('video');
    const pageHook = settings.pageHook || null;
    const storage = settings.storage || null;
    const getStyle = typeof settings.getStyle === 'function'
      ? settings.getStyle
      : (node) => win.getComputedStyle(node);

    let started = false;
    let generation = 0;
    let saved = [];
    let savedReady = false;
    let unsubscribeStorage = null;
    let session = createSectionSession();
    let active = true;
    let notice = null;
    let noticeTimer = null;
    let volume = 50;
    let hudTimer = null;
    let tickTimer = null;
    let media = null;
    let mediaCleanup = [];
    let wheelInstalled = false;
    let userInputInstalled = false;
    let songListenersInstalled = false;
    let accumulator = createWheelAccumulator();
    let ui = null;
    let fromDirty = false;
    let toDirty = false;
    let everBound = false;
    let seekRetryTimer = null;
    let seekRetryCount = 0;
    let seekToken = 0;
    let seekOnLanded = null;
    let settleTimer = null;
    let saveChain = Promise.resolve();
    let volumeSeq = 0;

    function currentState() {
      return {
        active: active,
        startSeconds: session.startSeconds,
        endSeconds: session.endSeconds,
      };
    }

    function currentHref() {
      try {
        return (win.location && win.location.href) || '';
      } catch {
        return '';
      }
    }

    function currentSongKey() {
      return songKeyFrom(currentHref());
    }

    function isVisible() {
      return !doc || doc.visibilityState !== 'hidden';
    }

    function mediaTime() {
      if (!media) return null;
      return Number.isFinite(media.currentTime) ? media.currentTime : null;
    }

    /**
     * The element volume is the actual playback volume and the gain source: the
     * existing graph mirrors `media.volume` into its single output gain. The page
     * player API is used for writes and slider truth only, never as a second
     * read, so this stays the single seed for the wheel.
     */
    function readMediaVolume() {
      if (!media) return null;
      const value = Number(media.volume);
      if (!Number.isFinite(value)) return null;
      return Math.round(Math.min(1, Math.max(0, value)) * 100);
    }

    function refreshVolume() {
      const next = readMediaVolume();
      if (next !== null) volume = next;
      return volume;
    }

    // -- lifecycle ---------------------------------------------------------

    async function start() {
      if (started) return;
      started = true;
      const mine = ++generation;
      cancelSeekRetry();
      clearSettleCheck();
      installWheel();
      installUserInput();
      installUi();
      installSongListeners();
      bindMedia();
      refreshVolume();
      subscribeStorage();

      // One cache load for the whole session. Every later change arrives through
      // storage.subscribe, so a restore is a synchronous lookup that cannot
      // interleave with an edit, a transition or another restore.
      let sections = [];
      try {
        sections = await readSections();
      } catch {
        sections = [];
      }
      if (!started || mine !== generation) return;
      saved = sections;
      savedReady = true;
      syncSong();
      syncTick();
      syncPanel();
    }

    function stop() {
      generation += 1;
      started = false;
      stopTick();
      cancelSeekRetry();
      clearSettleCheck();
      if (unsubscribeStorage !== null) {
        try {
          unsubscribeStorage();
        } catch {
          // Already detached.
        }
        unsubscribeStorage = null;
      }
      if (hudTimer !== null) {
        timers.clearTimeout(hudTimer);
        hudTimer = null;
      }
      if (noticeTimer !== null) {
        timers.clearTimeout(noticeTimer);
        noticeTimer = null;
      }
      removeWheel();
      removeUserInput();
      removeSongListeners();
      detachMedia();
      destroyUi();
      saved = [];
      savedReady = false;
      session = createSectionSession();
      active = true;
      notice = null;
      accumulator = createWheelAccumulator();
      fromDirty = false;
      toDirty = false;
      everBound = false;
      saveChain = Promise.resolve();
    }

    /** Re-reads what the page currently shows and re-syncs every derived bit. */
    function sync() {
      if (!started) return;
      if (!ui) installUi();
      bindMedia();
      refreshVolume();
      syncSong();
      syncTick();
      syncPanel();
    }

    // -- media -------------------------------------------------------------

    function bindMediaListener(type, handler) {
      media.addEventListener(type, handler);
      mediaCleanup.push({ type: type, handler: handler });
    }

    function bindMedia() {
      const next = mediaProvider();
      if (next === media) return;
      // Any element after a previous one is a new song context, even when a scan
      // saw no media in between: stale points must never fire on the new one.
      const replaced = everBound;
      detachMedia();
      media = next || null;
      if (!media) return;
      everBound = true;

      if (replaced) {
        cancelSeekRetry();
        clearSettleCheck();
        session.songKey = null;
        session.restoredSongKey = null;
        session.identityKnown = false;
        session.startSeconds = null;
        session.endSeconds = null;
        clearPendingRestore(session);
        fromDirty = false;
        toDirty = false;
        syncPanel();
      }

      bindMediaListener('ended', handleEnded);
      bindMediaListener('loadedmetadata', handleSourceChange);
      bindMediaListener('emptied', handleSourceChange);
      bindMediaListener('volumechange', refreshVolume);
    }

    function detachMedia() {
      if (media) {
        for (const listener of mediaCleanup) {
          try {
            media.removeEventListener(listener.type, listener.handler);
          } catch {
            // Already detached.
          }
        }
      }
      mediaCleanup = [];
      media = null;
    }

    function handleSourceChange() {
      if (!started) return;
      syncSong();
      syncTick();
      syncPanel();
    }

    function handleEnded() {
      if (!media) return;
      // Without an identity the points may belong to another song: never restart.
      if (!session.identityKnown) return;
      const target = resolveEndSeekTarget(currentState(), media.duration);
      if (target === null) return;
      try {
        media.currentTime = target;
        const played = media.play();
        if (played && typeof played.catch === 'function') played.catch(() => {});
      } catch {
        // Best effort: a removed element cannot resume.
      }
    }

    // -- song identity and the cached restore ------------------------------

    /**
     * Adopts the URL's song id and restores its saved section from the cache.
     *
     * Synchronous by design: the cache makes the lookup a plain read, so no edit,
     * transition or second restore can interleave with it. While the cache is
     * still loading the visit is marked pending and re-run once it lands.
     *
     * While the id is missing nothing seeks: the points are kept (the same song
     * can come back) but the loop tick is stopped.
     */
    function syncSong() {
      const key = currentSongKey();
      session.identityKnown = key !== null;
      if (key === null) {
        cancelSeekRetry();
        syncTick();
        return;
      }
      if (beginSong(session, key)) {
        cancelSeekRetry();
        clearSettleCheck();
        fromDirty = false;
        toDirty = false;
        syncTick();
        syncPanel();
      }
      // One restore per song visit; a repeat event must not re-seek.
      if (!songRestorePending(session, key)) return;
      applySavedSection(key);
    }

    function applySavedSection(key) {
      if (!savedReady) {
        session.pendingRestore = true;
        syncTick();
        return;
      }
      const entry = lookupSaved(saved, key);
      if (entry === null) {
        markSongRestored(session, key);
        clearPendingRestore(session);
        syncTick();
        syncPanel();
        return;
      }

      session.startSeconds = entry.startSeconds;
      session.endSeconds = entry.endSeconds;
      // A saved section comes back armed: Repeat off must not mute its range.
      active = true;
      fromDirty = false;
      toDirty = false;
      // Latched before the seek: a second signal in this visit cannot re-apply.
      markSongRestored(session, key);
      clearPendingRestore(session);
      syncTick();
      syncPanel();

      const start = entry.startSeconds === null ? 0 : entry.startSeconds;
      if (!media) return;
      requestSeek(start, () => {
        if (!started || session.songKey !== key) return;
        armSettleCheck(key, entry.startSeconds);
      });
    }

    // -- loop tick ---------------------------------------------------------

    function stopTick() {
      if (tickTimer === null) return;
      timers.clearInterval(tickTimer);
      tickTimer = null;
    }

    function syncTick() {
      // No identity means no loop: a stale range must never seek the media that
      // happens to be loaded during a transition.
      const wanted = started
        && session.identityKnown
        && session.songKey !== null
        && isLoopEngaged(currentState())
        && isVisible();
      if (wanted) {
        if (tickTimer === null) tickTimer = timers.setInterval(handleTick, TICK_MS);
        return;
      }
      stopTick();
    }

    function handleTick() {
      if (!started) return;
      bindMedia();
      if (!media) return;

      const key = currentSongKey();
      session.identityKnown = key !== null;
      if (key === null) {
        cancelSeekRetry();
        syncTick();
        return;
      }
      if (beginSong(session, key)) {
        // A URL change with no delivered event: adopt it and never seek with
        // the previous song's points.
        cancelSeekRetry();
        clearSettleCheck();
        fromDirty = false;
        toDirty = false;
        syncTick();
        syncPanel();
        applySavedSection(key);
        return;
      }

      const target = resolveSeekTarget(currentState(), {
        currentTime: media.currentTime,
        duration: media.duration,
        paused: media.paused,
        seeking: media.seeking,
      });
      if (target === null) return;
      try {
        media.currentTime = target;
      } catch {
        // Detached element.
      }
    }

    // -- wheel -------------------------------------------------------------

    function installWheel() {
      if (wheelInstalled) return;
      win.addEventListener('wheel', onWheel, { capture: true, passive: false });
      wheelInstalled = true;
    }

    function removeWheel() {
      if (!wheelInstalled) return;
      win.removeEventListener('wheel', onWheel, { capture: true });
      wheelInstalled = false;
    }

    function onWheel(event) {
      if (!started) return;
      const target = event.target || (doc && doc.documentElement);
      const verdict = shouldHandleWheel(event, target, doc, getStyle);
      if (!verdict.handle) return;
      const step = stepVolumeFromWheel(accumulator, event, volume);
      if (!step.applied) return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      volume = step.volume;
      applyVolume(step.volume);
    }

    function applyVolume(percent) {
      // One sequence per write, scoped by generation: a late reply from before a
      // stop cannot overwrite the new session's volume.
      const mine = generation;
      const seq = ++volumeSeq;
      showHud(percent);
      if (!pageHook || typeof pageHook.setVolume !== 'function') {
        writeMediaVolume(percent);
        return;
      }
      let pending = null;
      try {
        pending = pageHook.setVolume(percent);
      } catch {
        pending = null;
      }
      if (!pending || typeof pending.then !== 'function') {
        writeMediaVolume(percent);
        return;
      }
      pending.then((reply) => {
        if (!started || mine !== generation || seq !== volumeSeq) return;
        if (!reply || reply.applied === false || reply.source === 'none') {
          writeMediaVolume(percent);
          return;
        }
        const applied = Number(reply.volume);
        if (Number.isFinite(applied)) {
          volume = Math.round(applied);
          showHud(volume);
        }
      }).catch(() => {
        if (!started || mine !== generation || seq !== volumeSeq) return;
        writeMediaVolume(percent);
      });
    }

    function writeMediaVolume(percent) {
      if (!media) return;
      try {
        media.volume = Math.min(1, Math.max(0, percent / 100));
      } catch {
        // A detached element cannot be written.
      }
    }

    function showHud(percent) {
      if (!ui) return;
      ui.hud.textContent = percent + ' %';
      ui.hud.classList.add('visible');
      if (hudTimer !== null) timers.clearTimeout(hudTimer);
      hudTimer = timers.setTimeout(() => {
        hudTimer = null;
        if (ui) ui.hud.classList.remove('visible');
      }, HUD_VISIBLE_MS);
    }

    // -- user input --------------------------------------------------------

    function installUserInput() {
      if (userInputInstalled) return;
      userInputInstalled = true;
      for (const name of USER_INPUT_EVENTS) {
        win.addEventListener(name, onUserInput, { capture: true, passive: true });
      }
    }

    function removeUserInput() {
      if (!userInputInstalled) return;
      userInputInstalled = false;
      for (const name of USER_INPUT_EVENTS) {
        win.removeEventListener(name, onUserInput, { capture: true });
      }
    }

    /**
     * Real input disowns every position this controller asked for: a retry must
     * not fight a user seek. It never touches the points or the cache — a section
     * that has not restored yet still restores when the cache lands.
     */
    function onUserInput() {
      cancelSeekRetry();
      clearSettleCheck();
      clearPendingRestore(session);
    }

    // -- seeking -----------------------------------------------------------

    function cancelSeekRetry() {
      seekToken += 1;
      seekRetryCount = 0;
      seekOnLanded = null;
      if (seekRetryTimer !== null) {
        timers.clearTimeout(seekRetryTimer);
        seekRetryTimer = null;
      }
    }

    /**
     * Writes a position and retries a bounded number of times while the player
     * ignores the write. `onLanded` runs whenever the position finally lands,
     * first try or retry. A newer seek, user input, song change or stop cancels.
     */
    function requestSeek(target, onLanded) {
      if (!media) return false;
      const value = Number(target);
      if (!Number.isFinite(value) || value < 0) return false;
      cancelSeekRetry();
      seekOnLanded = typeof onLanded === 'function' ? onLanded : null;
      return writeSeek(value, seekToken);
    }

    function writeSeek(target, token) {
      if (!started || token !== seekToken || !media) return false;
      let wrote = false;
      try {
        media.currentTime = target;
        wrote = true;
      } catch {
        wrote = false;
      }
      const actual = Number(media.currentTime);
      if (wrote && Number.isFinite(actual) && Math.abs(actual - target) <= SEEK_TOLERANCE_SECONDS) {
        const landed = seekOnLanded;
        seekOnLanded = null;
        if (landed) landed();
        return true;
      }
      if (seekRetryCount >= SEEK_RETRY_ATTEMPTS) return false;
      seekRetryCount += 1;
      seekRetryTimer = timers.setTimeout(() => {
        seekRetryTimer = null;
        writeSeek(target, token);
      }, SEEK_RETRY_MS);
      return false;
    }

    function clearSettleCheck() {
      if (settleTimer === null) return;
      timers.clearTimeout(settleTimer);
      settleTimer = null;
    }

    /**
     * One late correction after a restore seek: YTM can apply its own startup
     * position after ours lands. Re-apply the saved start once, and only when
     * the URL still names the same song and the player reset to the top.
     */
    function armSettleCheck(key, startSeconds) {
      clearSettleCheck();
      if (!Number.isFinite(startSeconds) || startSeconds <= SETTLE_NEAR_ZERO_SECONDS) return;
      settleTimer = timers.setTimeout(() => {
        settleTimer = null;
        if (!started || !media) return;
        if (currentSongKey() !== key) return;
        const at = Number(media.currentTime);
        if (!Number.isFinite(at) || at > SETTLE_NEAR_ZERO_SECONDS) return;
        requestSeek(startSeconds);
      }, SETTLE_MS);
    }

    // -- UI ---------------------------------------------------------------

    function buildRow(labelText, nowLabel) {
      const row = doc.createElement('div');
      row.className = 'slra-row';
      const label = doc.createElement('span');
      label.textContent = labelText;
      const input = doc.createElement('input');
      input.type = 'text';
      input.className = 'slra-field';
      input.setAttribute('aria-label', labelText);
      input.placeholder = labelText === 'From' ? '0:00' : 'end';
      const nowButton = doc.createElement('button');
      nowButton.type = 'button';
      nowButton.className = 'slra-now';
      nowButton.textContent = 'Now';
      nowButton.setAttribute('aria-label', nowLabel);
      row.append(label, input, nowButton);
      return { row: row, input: input, now: nowButton };
    }

    function buildButton(labelText, ariaLabel) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'slra-button';
      button.textContent = labelText;
      button.setAttribute('aria-label', ariaLabel);
      return button;
    }

    function installUi() {
      if (ui) return;
      // document_start can precede <html>; the next sync installs the panel.
      const parent = doc.documentElement;
      if (!parent) return;
      const host = doc.createElement('div');
      host.setAttribute(HOST_ATTR, '');
      const shadow = host.attachShadow({ mode: 'open' });

      const style = doc.createElement('style');
      style.textContent = PANEL_CSS;
      shadow.appendChild(style);

      const shell = doc.createElement('div');
      shell.className = 'slra-shell';

      const hud = doc.createElement('div');
      hud.className = 'slra-hud';
      hud.setAttribute('aria-live', 'polite');

      const panel = doc.createElement('div');
      panel.className = 'slra-panel';
      panel.setAttribute('aria-label', 'Section repeat');

      const repeatRow = doc.createElement('label');
      repeatRow.className = 'slra-row';
      const repeat = doc.createElement('input');
      repeat.type = 'checkbox';
      repeat.setAttribute('aria-label', 'Repeat');
      const repeatText = doc.createElement('span');
      repeatText.textContent = 'Repeat section';
      repeatRow.append(repeat, repeatText);

      const fromRow = buildRow('From', 'Set From to now');
      const toRow = buildRow('To', 'Set To to now');

      const status = doc.createElement('div');
      status.className = 'slra-status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-label', 'Section status');

      const actions = doc.createElement('div');
      actions.className = 'slra-actions';
      const clear = buildButton('Clear', 'Clear section');
      const save = buildButton('Save', 'Save section');
      actions.append(clear, save);

      panel.append(repeatRow, fromRow.row, toRow.row, status, actions);

      const pill = doc.createElement('button');
      pill.type = 'button';
      pill.className = 'slra-pill';
      pill.textContent = 'Repeat';
      pill.setAttribute('aria-label', 'Section repeat');

      shell.append(hud, panel, pill);
      shadow.appendChild(shell);
      parent.appendChild(host);

      ui = {
        host: host,
        shadow: shadow,
        hud: hud,
        panel: panel,
        repeat: repeat,
        from: fromRow.input,
        to: toRow.input,
        fromNow: fromRow.now,
        toNow: toRow.now,
        status: status,
        clear: clear,
        save: save,
        pill: pill,
      };

      repeat.addEventListener('change', () => {
        active = repeat.checked;
        notice = null;
        syncTick();
        syncPanel();
      });
      ui.from.addEventListener('input', () => {
        fromDirty = true;
        paintStatus();
      });
      ui.to.addEventListener('input', () => {
        toDirty = true;
        paintStatus();
      });
      ui.from.addEventListener('change', () => commit('from'));
      ui.to.addEventListener('change', () => commit('to'));
      ui.from.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') commit('from');
      });
      ui.to.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') commit('to');
      });
      ui.fromNow.addEventListener('click', () => {
        const at = mediaTime();
        if (at === null) return;
        ui.from.value = formatTime(at);
        commit('from');
      });
      ui.toNow.addEventListener('click', () => {
        const at = mediaTime();
        if (at === null) return;
        ui.to.value = formatTime(at);
        commit('to');
      });
      ui.clear.addEventListener('click', () => {
        ui.from.value = '';
        ui.to.value = '';
        commit('clear');
      });
      ui.save.addEventListener('click', () => {
        requestSave();
      });
      ui.pill.addEventListener('click', () => {
        ui.panel.classList.toggle('open');
      });

      syncPanel();
    }

    function destroyUi() {
      if (!ui) return;
      try {
        ui.host.remove();
      } catch {
        // Already detached.
      }
      ui = null;
    }

    function setInvalid(input, invalid) {
      if (invalid) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }

    function readInputs() {
      const parsedFrom = parseTimeInput(ui.from.value);
      const parsedTo = parseTimeInput(ui.to.value);
      return {
        from: parsedFrom,
        to: parsedTo,
        invalid: parsedFrom.kind === 'invalid' || parsedTo.kind === 'invalid',
        startSeconds: parsedFrom.kind === 'time' ? parsedFrom.seconds : null,
        endSeconds: parsedTo.kind === 'time' ? parsedTo.seconds : null,
      };
    }

    function paintStatus() {
      if (!ui) return;
      const live = readInputs();
      let bad = live.invalid;
      const start = live.startSeconds;
      const end = live.endSeconds;

      if (!bad) {
        // A blank From starts at 0:00, so a To at or below zero is reversed.
        if (end !== null && end <= (start === null ? 0 : start)) bad = true;
      }
      setInvalid(ui.from, live.from.kind === 'invalid' || bad);
      setInvalid(ui.to, live.to.kind === 'invalid' || bad);

      let text;
      if (bad) {
        text = 'Invalid range';
      } else if (notice === 'failed') {
        text = 'Save failed';
      } else if (notice === 'no-song') {
        text = 'Play a song to save';
      } else if (notice === 'saved') {
        text = 'Saved';
      } else if (notice === 'removed') {
        text = 'Removed';
      } else if (!session.identityKnown) {
        // No `?v=`: repeat needs a song. Live looping still works while playing.
        text = 'Play a song to repeat';
      } else if (!active) {
        text = 'Repeat off';
      } else if (start === null && end === null) {
        text = 'Set From or To';
      } else if (end === null) {
        text = formatTime(start === null ? 0 : start) + ' → end of song';
      } else {
        text = formatTime(start === null ? 0 : start) + ' → ' + formatTime(end);
      }

      ui.status.textContent = text;
      ui.status.classList.toggle('invalid', bad);
    }

    /** Repaints from state; a dirty field keeps whatever is being typed. */
    function syncPanel() {
      if (!ui) return;
      ui.repeat.checked = active;
      if (!fromDirty) ui.from.value = session.startSeconds === null ? '' : formatTime(session.startSeconds);
      if (!toDirty) ui.to.value = session.endSeconds === null ? '' : formatTime(session.endSeconds);
      paintStatus();
    }

    function commit(source) {
      if (!ui) return;
      const live = readInputs();
      if (live.invalid) {
        paintStatus();
        return;
      }
      if (live.endSeconds !== null && live.endSeconds <= (live.startSeconds === null ? 0 : live.startSeconds)) {
        setInvalid(ui.from, true);
        setInvalid(ui.to, true);
        ui.status.textContent = 'Invalid range';
        ui.status.classList.add('invalid');
        return;
      }

      // Any commit (From, To, Clear) cancels outstanding position work first: the
      // new points own playback, and Clear must never jump.
      cancelSeekRetry();
      clearSettleCheck();
      clearPendingRestore(session);

      // Adopt the identity when the cache load has not reached syncSong yet, so
      // this edit latches the visit and the landing cannot overwrite it.
      if (session.songKey === null) {
        const earlyKey = currentSongKey();
        if (earlyKey !== null) {
          session.songKey = earlyKey;
          session.identityKnown = true;
        }
      }
      if (session.songKey !== null) markSongRestored(session, session.songKey);

      notice = null;
      session.startSeconds = live.startSeconds;
      session.endSeconds = live.endSeconds;
      fromDirty = false;
      toDirty = false;
      ui.from.value = live.startSeconds === null ? '' : formatTime(live.startSeconds);
      ui.to.value = live.endSeconds === null ? '' : formatTime(live.endSeconds);

      // A committed From jumps playback there at once, armed or not and without
      // a known duration; To/clear never seek.
      if (source === 'from') {
        clearSettleCheck();
        const key = session.songKey;
        requestSeek(live.startSeconds === null ? 0 : live.startSeconds, () => {
          if (!started || session.songKey !== key) return;
          armSettleCheck(key, live.startSeconds);
        });
      }
      syncTick();
      syncPanel();
    }

    // -- storage -----------------------------------------------------------

    async function readSections() {
      if (!storage || typeof storage.get !== 'function') return [];
      const result = await storage.get(STORAGE_KEY);
      const raw = result && typeof result === 'object' ? result[STORAGE_KEY] : null;
      return sanitizeSaved(raw ? raw.sections : undefined);
    }

    function subscribeStorage() {
      if (!storage || typeof storage.subscribe !== 'function') return;
      try {
        unsubscribeStorage = storage.subscribe(onStorageChange);
      } catch {
        unsubscribeStorage = null;
      }
    }

    /**
     * Another tab (or this one, echoed) changed the section list. The cache is
     * the only source for restores, so this is what makes a save visible.
     */
    function onStorageChange(sections) {
      if (!started) return;
      saved = sanitizeSaved(sections);
      savedReady = true;
      // A visit still waiting for its first restore can now apply; a visit that
      // already restored, or was edited, is left alone by the latch.
      syncSong();
      syncTick();
      syncPanel();
    }

    /**
     * Hands the write to the one ordered writer: the service worker when the
     * content script supplies it (across every tab), else a local promise chain.
     * The controller never read-modify-writes: it adopts the reply.
     */
    function requestSectionSave(entry, mine) {
      if (storage && typeof storage.saveSection === 'function') {
        return Promise.resolve(storage.saveSection(entry));
      }
      saveChain = saveChain.catch(() => ({ ok: false, sections: [] })).then(async () => {
        if (!started || mine !== generation) return { ok: false, sections: null };
        const current = await readSections();
        if (!started || mine !== generation) return { ok: false, sections: null };
        const next = capSaved(upsertSaved(current, entry), SAVED_LIMIT);
        if (storage && typeof storage.set === 'function') {
          const write = {};
          write[STORAGE_KEY] = { sections: next };
          await storage.set(write);
        }
        return { ok: true, sections: next };
      });
      return saveChain;
    }

    function requestSave() {
      if (!ui) return;
      const videoId = session.songKey;
      if (videoId === null || !session.identityKnown) {
        notice = 'no-song';
        syncPanel();
        return;
      }
      // Snapshot at the click: nothing that happens while the write is in
      // flight can change what is being saved.
      const entry = {
        videoId: videoId,
        startSeconds: session.startSeconds,
        endSeconds: session.endSeconds,
      };
      notice = null;
      void save(entry);
    }

    async function save(entry) {
      const mine = generation;
      const removed = entry.startSeconds === null && entry.endSeconds === null;
      try {
        const reply = await requestSectionSave(entry, mine);
        // A stop (or a new session) owns the state now: mutate nothing.
        if (!started || mine !== generation) return;
        // `ok:false` is a storage failure, not a rejection: never claim a save
        // and never touch the cache.
        if (!reply || reply.ok !== true) {
          notice = 'failed';
          syncPanel();
          return;
        }
        // Adopt the writer's list now; the onChanged echo is then a no-op.
        if (Array.isArray(reply.sections)) {
          saved = sanitizeSaved(reply.sections);
          savedReady = true;
        }
        // A song change (or a changed range) also owns the state now; the
        // notice for the old compose would be stale.
        if (
          session.songKey === entry.videoId &&
          session.startSeconds === entry.startSeconds &&
          session.endSeconds === entry.endSeconds
        ) {
          notice = removed ? 'removed' : 'saved';
          syncPanel();
          if (noticeTimer !== null) timers.clearTimeout(noticeTimer);
          noticeTimer = timers.setTimeout(() => {
            noticeTimer = null;
            notice = null;
            syncPanel();
          }, HUD_VISIBLE_MS);
        }
      } catch {
        if (!started || mine !== generation) return;
        notice = 'failed';
        syncPanel();
      }
    }

    // -- page signals ------------------------------------------------------

    function onSongSignal() {
      if (!started) return;
      syncSong();
      syncTick();
      syncPanel();
    }

    function onVisibilityChange() {
      if (!started) return;
      syncTick();
    }

    function installSongListeners() {
      if (songListenersInstalled) return;
      songListenersInstalled = true;
      // Independent of the tick: a swap while disarmed must still be seen.
      for (const name of SONG_EVENTS) win.addEventListener(name, onSongSignal, true);
      doc.addEventListener('visibilitychange', onVisibilityChange);
    }

    function removeSongListeners() {
      if (!songListenersInstalled) return;
      songListenersInstalled = false;
      for (const name of SONG_EVENTS) win.removeEventListener(name, onSongSignal, true);
      doc.removeEventListener('visibilitychange', onVisibilityChange);
    }

    return {
      start: start,
      stop: stop,
      sync: sync,
    };
  }
  const api = {
    WHEEL_PX_PER_STEP: WHEEL_PX_PER_STEP,
    VOLUME_STEP_PCT: VOLUME_STEP_PCT,
    TICK_MS: TICK_MS,
    HUD_VISIBLE_MS: HUD_VISIBLE_MS,
    SAVED_LIMIT: SAVED_LIMIT,
    STORAGE_KEY: STORAGE_KEY,
    parseTimeInput: parseTimeInput,
    formatTime: formatTime,
    isLoopEngaged: isLoopEngaged,
    resolveSeekTarget: resolveSeekTarget,
    resolveEndSeekTarget: resolveEndSeekTarget,
    sanitizeSaved: sanitizeSaved,
    lookupSaved: lookupSaved,
    upsertSaved: upsertSaved,
    capSaved: capSaved,
    songKeyFrom: songKeyFrom,
    createSectionSession: createSectionSession,
    beginSong: beginSong,
    songRestorePending: songRestorePending,
    markSongRestored: markSongRestored,
    clearPendingRestore: clearPendingRestore,
    wheelPixels: wheelPixels,
    createWheelAccumulator: createWheelAccumulator,
    stepVolumeFromWheel: stepVolumeFromWheel,
    shouldHandleWheel: shouldHandleWheel,
    createPlayerActions: createPlayerActions,
  };

  root.SlowedReverbPlayerActions = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
