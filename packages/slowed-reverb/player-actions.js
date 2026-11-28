/* global module */
(function (root) {
  'use strict';

  const WHEEL_PX_PER_STEP = 100;
  const VOLUME_STEP_PCT = 5;
  const YTM_ELEMENT_PER_PLAYER = 0.00741;
  const TICK_MS = 100;
  const NOTICE_VISIBLE_MS = 1200;
  const VOLUME_SAVE_MS = 300;
  const VOLUME_RESTORE_ATTEMPTS = 2;
  const VOLUME_RESTORE_RETRY_MS = 600;
  const VOLUME_RESTORE_TOLERANCE = 0.02;
  const SAVED_LIMIT = 1000;
  const RESTORE_DEADLINE_MS = 3000;
  const PLAYER_BAR_TAG = 'YTMUSIC-PLAYER-BAR';
  const MAIN_PANEL_ID = 'main-panel';
  const SEEK_RETRY_MS = 120;
  const SEEK_RETRY_ATTEMPTS = 3;
  const SEEK_TOLERANCE_SECONDS = 0.25;
  const SETTLE_MS = 1200;
  const SETTLE_NEAR_ZERO_SECONDS = 1;
const UNCONFIRMED_SEEK_GUARD_SECONDS = 1;
  const BOUNDARY_HOLD_MARGIN_SECONDS = 0.5;
  const STORAGE_KEY = 'playerActions';
  const HOST_ATTR = 'data-slra-player-actions';

  const TIME_PART = /^\d+$/;
  const FIELD_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
  const SCROLL_OVERFLOW = new Set(['auto', 'scroll', 'overlay']);
  const SONG_EVENTS = ['yt-navigate-finish', 'yt-page-data-updated', 'popstate', 'hashchange'];
  const USER_INPUT_EVENTS = ['pointerdown', 'keydown', 'touchstart'];


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

    const start = state.startSeconds === null ? 0 : state.startSeconds;
    if (!Number.isFinite(start)) return null;

    const end = state.endSeconds === null ? duration : state.endSeconds;
    if (!Number.isFinite(end)) return null;

    const clampedToSongEnd = state.endSeconds !== null && Number.isFinite(duration) && end >= duration;
    const toSongEnd = state.endSeconds === null || clampedToSongEnd;
    const loopEnd = toSongEnd ? duration : end;
    const threshold = toSongEnd ? loopEnd - 0.3 : loopEnd - 0.05;
    if (!Number.isFinite(threshold)) return null;
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

  /**
   * Strict check for a list that will be written back: every entry must already
   * be the stored schema, unique by videoId, and no entry may be a forget (both
   * bounds null). Nothing is dropped or rewritten; `sections` is the input.
   */
  function validateSavedList(value) {
    if (!Array.isArray(value)) return { ok: false, reason: 'list' };
    const seen = new Set();
    for (let index = 0; index < value.length; index += 1) {
      const entry = sanitizeEntry(value[index]);
      if (entry === null) return { ok: false, reason: 'entry', index: index };
      if (seen.has(entry.videoId)) return { ok: false, reason: 'duplicate', index: index };
      seen.add(entry.videoId);
    }
    return { ok: true, sections: value };
  }

  /**
   * Merges a validated batch into the saved list. An id that is already saved
   * keeps its saved entry (the destination always wins) and counts as skipped;
   * new ids append in batch order. A merge that would pass `limit` is refused
   * whole, so an import can never evict a saved section.
   */
  function mergeSavedLists(existing, incoming, limit) {
    const list = Array.isArray(existing) ? existing.slice() : [];
    const batch = Array.isArray(incoming) ? incoming : [];
    const known = new Set(list.map((entry) => entry.videoId));
    const max = Number.isFinite(limit) ? limit : SAVED_LIMIT;
    let imported = 0;
    let skipped = 0;
    for (let index = 0; index < batch.length; index += 1) {
      const entry = sanitizeEntry(batch[index]);
      if (entry === null) return { ok: false, error: 'invalid_entry', index: index };
      if (known.has(entry.videoId)) {
        skipped += 1;
        continue;
      }
      known.add(entry.videoId);
      list.push(entry);
      imported += 1;
    }
    if (list.length > max) {
      return { ok: false, error: 'capacity_exceeded', count: list.length, limit: max };
    }
    return { ok: true, imported: imported, skipped: skipped, sections: list };
  }


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
      identitySource: null,
      confirmedKey: null,
      everAdopted: false,
      identityPending: false,
      pressVouched: false,
      startSeconds: null,
      endSeconds: null,
      pendingRestore: false,
      restoreDeadlineAt: 0,
      ambiguousVless: false,
      lastSongKey: null,
      displayKey: null,
      displayStartSeconds: null,
      displayEndSeconds: null,
    };
  }

  /**
   * Adopts a new song. A null key never changes anything: an id that has not
   * arrived yet must defer, not restore the previous song's section.
   */
  function beginSong(session, key, source) {
    if (key === null || key === undefined || key === '') return false;
    if (session.songKey === key) return false;
    const firstEver = !session.everAdopted;
    session.everAdopted = true;
    session.lastSongKey = key;
    session.songKey = key;
    session.restoredSongKey = null;
    session.startSeconds = null;
    session.endSeconds = null;
    session.pendingRestore = false;
    session.restoreDeadlineAt = 0;
    session.ambiguousVless = false;
    session.displayKey = null;
    session.displayStartSeconds = null;
    session.displayEndSeconds = null;
    session.identitySource = source === 'push' || source === 'url' ? source : null;
    session.confirmedKey = session.identitySource === 'push' || firstEver ? key : null;
    session.pressVouched = false;
    return true;
  }

  /**
   * Drops a visit's points without touching the user's Repeat preference. A
   * navigation that leaves the song must not keep the old section armed.
   */
  function forgetSong(session) {
    session.songKey = null;
    session.identityKnown = false;
    session.restoredSongKey = null;
    session.startSeconds = null;
    session.endSeconds = null;
    session.pendingRestore = false;
    session.restoreDeadlineAt = 0;
    session.confirmedKey = null;
    session.pressVouched = false;
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
    session.restoreDeadlineAt = 0;
  }


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
   * Converts an element volume (0-1) to player scale (0-100) through the
   * measured YTM slope above. Only the vanilla seed before any applied page
   * reply has been seen; the reply is the only truth after that.
   */
  function playerVolumeFromElement(elementVolume) {
    const value = Number(elementVolume);
    if (!Number.isFinite(value)) return null;
    const clamped = Math.min(1, Math.max(0, value));
    return Math.min(100, Math.max(0, Math.round(clamped / YTM_ELEMENT_PER_PLAYER)));
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
    const stepped = steps > 0
      ? Math.floor(base / VOLUME_STEP_PCT) * VOLUME_STEP_PCT + steps * VOLUME_STEP_PCT
      : Math.ceil(base / VOLUME_STEP_PCT) * VOLUME_STEP_PCT + steps * VOLUME_STEP_PCT;
    const next = Math.min(100, Math.max(0, stepped));
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

  /**
   * The two surfaces that carry the wheel: the persistent player bar, and the
   * player panel (artwork in song mode, the video in video mode). The panel must
   * be visible: an inactive player keeps it offscreen with `visibility: hidden`,
   * which is exactly the state where the wheel belongs to the browse page.
   */
  function isPlayerSurface(node, getStyle) {
    if (!node || typeof node !== 'object') return false;
    if (typeof node.tagName === 'string' && node.tagName.toUpperCase() === PLAYER_BAR_TAG) return true;
    if (attributeOf(node, 'id') !== MAIN_PANEL_ID) return false;
    try {
      const computed = getStyle ? getStyle(node) : null;
      if (!computed) return true;
      if (String(computed.visibility || '').toLowerCase() === 'hidden') return false;
      if (String(computed.display || '').toLowerCase() === 'none') return false;
      return true;
    } catch {
      return true;
    }
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
   * must not preventDefault unless the verdict is `handle`; a handled player surface always blocks the wheel, even before a step lands.
   */
  function shouldHandleWheel(event, target, doc, getStyle) {
    if (!event || event.defaultPrevented) return { handle: false, reason: 'default-prevented' };
    if (event.ctrlKey || event.metaKey || event.altKey) return { handle: false, reason: 'modifier' };
    if (!event.deltaY) return { handle: false, reason: 'no-delta' };

    const chain = eventChain(event, target);

    for (const node of chain) {
      if (panelNode(node)) return { handle: false, reason: 'panel' };
    }

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

    const style = typeof getStyle === 'function' ? getStyle : () => null;
    let surface = -1;
    for (let index = 0; index < chain.length; index += 1) {
      if (isPlayerSurface(chain[index], style)) {
        surface = index;
        break;
      }
    }
    if (surface === -1) return { handle: false, reason: 'not-player-surface' };

    for (let index = 0; index < surface; index += 1) {
      const node = chain[index];
      if (!node || typeof node !== 'object') continue;
      if (!SCROLL_OVERFLOW.has(computedOverflowY(style, node))) continue;
      const scrollHeight = Number(node.scrollHeight);
      const clientHeight = Number(node.clientHeight);
      if (scrollHeight > clientHeight + 1) return { handle: false, reason: 'scrollable-ancestor' };
    }
    return { handle: true, reason: 'handle' };
  }


  const PANEL_CSS = [
    ':host{position:fixed;right:16px;bottom:96px;z-index:2147483000;display:block;pointer-events:none;font:12px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#f1f1f1;}',
    '.slra-shell{position:relative;display:flex;flex-direction:column;align-items:flex-end;gap:6px;}',
    '.slra-pill{pointer-events:auto;border:0;border-radius:999px;padding:6px 12px;background:rgba(0,0,0,.72);color:#f1f1f1;font:inherit;font-weight:600;cursor:pointer;}',
    '.slra-pill:hover{background:rgba(0,0,0,.85);}',
    '.slra-panel{display:none;pointer-events:auto;width:224px;padding:10px;border-radius:12px;background:rgba(15,15,15,.94);box-shadow:0 8px 24px rgba(0,0,0,.45);}',
    '.slra-panel.open{display:block;}',
    '.slra-bar{display:flex;align-items:center;gap:6px;}',
    '.slra-row{display:flex;align-items:center;gap:6px;margin-bottom:6px;}',
    '.slra-row span{flex:1;}',
    '.slra-row input[type=checkbox]{margin:0;}',
    '.slra-field{width:64px;padding:3px 6px;border:1px solid #3a3a3a;border-radius:6px;background:#0d0d0d;color:#f1f1f1;font:inherit;}',
    '.slra-field[aria-invalid="true"]{border-color:#e05252;}',
    '.slra-now,.slra-button{pointer-events:auto;border:1px solid #3a3a3a;border-radius:6px;background:#1c1c1c;color:#f1f1f1;font:inherit;padding:3px 8px;cursor:pointer;}',
    '.slra-button:disabled{opacity:.38;cursor:default;}',
    '.slra-icon{flex:0 0 auto;padding:3px 7px;font-size:14px;line-height:1;}',
    '.slra-status{min-height:16px;margin:4px 0 8px;color:#b3b3b3;}',
    '.slra-status.invalid{color:#e05252;}',
    '.slra-actions{display:flex;gap:6px;}',
    '.slra-actions .slra-button{flex:1;}',
    '.slra-actions .slra-icon{flex:0 0 auto;}',
    '.slra-volume{pointer-events:none;min-width:44px;padding:4px 8px;border-radius:999px;background:rgba(0,0,0,.72);color:#f1f1f1;font:600 12px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:center;opacity:1;transition:opacity 120ms ease;}',
    '@media (prefers-reduced-motion: reduce){.slra-volume{transition:none;}}',
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
    const now = typeof settings.now === 'function' ? settings.now : () => Date.now();
    const pageHook = settings.pageHook || null;
    const storage = settings.storage || null;
    const lockPitchApi = Boolean(storage)
      && typeof storage.getLockPitch === 'function'
      && typeof storage.saveLockPitch === 'function';

    function currentLockPitch() {
      return lockPitchApi && storage.getLockPitch() === true;
    }
    const getStyle = typeof settings.getStyle === 'function'
      ? settings.getStyle
      : (node) => win.getComputedStyle(node);

    let started = false;
    let generation = 0;
    let saved = [];
    let savedReady = false;
    let savedRevision = 0;
    let pageSongId = null;
    let songIdPushed = false;
    let pageSongHref = null;
    let boundaryHoldId = null;
    let boundaryHoldHref = null;
    let unsubscribeStorage = null;
    let session = createSectionSession();
    let active = true;
    let notice = null;
    let noticeTimer = null;
    let volume = 50;
    let hasVolumeTruth = false;
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
    let undoAvailable = false;
    let undoEntry = null;
    let undoSongKey = null;
    let saveInFlight = null;
    let pendingVolumeSave = null;
    let volumeSaveTimer = null;
    let volumeSaveInFlight = false;
    let volumeRestoreTarget = null;
    let volumeRestoreAttempts = 0;
    let volumeRestoreSettled = false;
    let volumeRestoreTimer = null;

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

    /**
     * The identity and where it came from. A push is usable only for the
     * navigation it was taken in: `pageSongHref` is the hook's own href at that
     * moment, so a URL that has moved since makes it stale, and a replay or a
     * repeat push cannot re-anchor itself to whatever URL is current now.
     *
     * `source` is 'push' (confirmed by the player), 'url' (a candidate until
     * the media confirms), 'blip' (no id, but the same navigation: keep the
     * points) or 'lost' (the navigation left the pushed song: drop them).
     */
    function currentSongIdentity() {
      if (boundaryHoldId !== null) {
        // A queued next id was pushed before this media ended. Keep identity
        // on the armed song until a genuine end or source change releases it.
        return { key: session.songKey, source: 'blip' };
      }
      const fromUrl = songKeyFrom(currentHref());
      if (!songIdPushed) {
        return { key: fromUrl, source: fromUrl === null ? null : 'url' };
      }
      const pushedForKey = songKeyFrom(pageSongHref);
      if (fromUrl === null) {
        if (pushedForKey !== null) return { key: null, source: 'lost' };
        return { key: pageSongId, source: pageSongId === null ? 'blip' : 'push' };
      }
      if (pushedForKey !== fromUrl) {
        return { key: fromUrl, source: 'url' };
      }
      return { key: pageSongId, source: pageSongId === null ? 'blip' : 'push' };
    }

    function currentSongKey() {
      return currentSongIdentity().key;
    }

    /**
     * A v-less Home push cannot vouch for a different song on a controller
     * that has already adopted one. forgetSong clears songKey on a watch
     * to Home drop while the old song still plays, so use the adoption
     * history instead. A first Home session and a same-id re-adoption stay
     * allowed; everything else waits for a watch URL to name the key.
     */
    function ambiguousVlessPush(identity, key) {
      return identity.source === 'push'
        && songKeyFrom(currentHref()) === null
        && session.everAdopted
        && session.lastSongKey !== key;
    }

    /**
     * A dropped identity or a replaced element clears the transport points.
     * Keep the saved range for display only. It never arms or seeks a loop.
     */
    function rememberSavedDisplay() {
      const key = session.lastSongKey;
      const entry = savedReady && key !== null ? lookupSaved(saved, key) : null;
      session.displayKey = entry ? key : null;
      session.displayStartSeconds = entry ? entry.startSeconds : null;
      session.displayEndSeconds = entry ? entry.endSeconds : null;
    }

    function clearSavedDisplay() {
      session.displayKey = null;
      session.displayStartSeconds = null;
      session.displayEndSeconds = null;
    }

    /**
     * Adopts native player-scale truth pushed by the page (a YTM slider drag
     * or keyboard step changes the player volume with no wheel involved). An
     * absolute value, so last-writer-wins is exact; like an applied reply, it
     * owns the cache from here on and syncs never overwrite it.
     */
    function setPlayerVolume(next, options) {
      const value = Number(next);
      if (!Number.isFinite(value)) return;
      volume = Math.min(100, Math.max(0, Math.round(value)));
      hasVolumeTruth = true;
      showVolumeHud(volume);
      if (options && options.user === true) {
        cancelPendingVolumeRestore();
        scheduleVolumeSave(volume);
      }
    }

    /**
     * The page hook force-pushes the queued next id on metadata and data
     * events. YTM can do that before the current media ends, so adopting it
     * now would clear the armed section and lose the loop's seek. Hold it
     * while an armed loop sits at its end boundary.
     */
    function shouldHoldAtBoundary(id) {
      if (!started || id === null || id === '') return false;
      if (session.songKey === null || id === session.songKey) return false;
      if (!isLoopEngaged(currentState())) return false;
      const armed = resolveArmedLoop(currentState(), media ? media.duration : undefined);
      if (armed === null || !media) return false;
      const at = Number(media.currentTime);
      return Number.isFinite(at) && at >= armed.threshold - BOUNDARY_HOLD_MARGIN_SECONDS;
    }

    function clearBoundaryHold() {
      boundaryHoldId = null;
      boundaryHoldHref = null;
    }

    function releaseBoundaryHold() {
      if (boundaryHoldId === null) return;
      const id = boundaryHoldId;
      const href = boundaryHoldHref;
      clearBoundaryHold();
      applySongId(id, href);
    }

    /**
     * A source signal may already be another song, and the read that decides it
     * is in flight. Suspend the latch until the answer lands: nothing seeks in
     * the meantime, and an unreadable answer invalidates.
     */
    function suspendSongIdentity() {
      clearBoundaryHold();
      clearSettleCheck();
      session.identityPending = true;
      session.confirmedKey = null;
      session.pressVouched = false;
    }

    /**
     * Fail closed: the media's source changed and nothing could confirm which
     * song it holds now. Drop the visit and the remembered push, so only a new
     * push or a readable player id adopts a song again. Repeat stays as the user
     * left it; nothing can seek until something vouches for the media.
     */
    function invalidateSongIdentity() {
      clearBoundaryHold();
      if (session.pressVouched) {
        session.pressVouched = false;
        session.identityPending = false;
        return;
      }
      session.identityPending = false;
      songIdPushed = false;
      pageSongId = null;
      pageSongHref = null;
      forgetSong(session);
      rememberSavedDisplay();
      cancelSeekRetry();
      clearSettleCheck();
      syncTick();
      syncPanel();
    }

    /** Adopts the id pushed by the page hook (null when no track is loaded). */
    function setSongId(next, href) {
      const normalized = typeof next === 'string' && next !== '' ? next : null;
      if (shouldHoldAtBoundary(normalized)) {
        boundaryHoldId = normalized;
        boundaryHoldHref = href;
        return;
      }
      applySongId(normalized, href);
    }

    function applySongId(normalized, href) {
      clearBoundaryHold();
      session.identityPending = false;
      songIdPushed = true;
      if (session.songKey === normalized && normalized !== null) {
        session.confirmedKey = normalized;
      }
      if (normalized === pageSongId && normalized !== null) {
        if (started) {
          syncSong();
          syncTick();
          syncPanel();
        }
        return;
      }
      pageSongId = normalized;
      pageSongHref = typeof href === 'string' && href !== '' ? href : currentHref();
      if (!started) return;
      syncSong();
      syncTick();
      syncPanel();
    }

    function isVisible() {
      return !doc || doc.visibilityState !== 'hidden';
    }

    function mediaTime() {
      if (!media) return null;
      return Number.isFinite(media.currentTime) ? media.currentTime : null;
    }

    /**
     * The one-time vanilla seed: before any page reply has been applied, the
     * element (converted to player scale) is all we know about the site volume.
     * Afterwards the applied replies and the native volume pushes own the
     * cache and the element must never overwrite it: on YTM the units differ,
     * so re-seeding here ratchets every scroll-UP into a volume drop and then
     * sticks at the floor.
     */
    function readMediaVolume() {
      if (!media) return null;
      return playerVolumeFromElement(media.volume);
    }

    function refreshVolume() {
      if (hasVolumeTruth) return volume;
      const next = readMediaVolume();
      if (next !== null) volume = next;
      if (Number.isFinite(volume)) showVolumeHud(volume);
      return volume;
    }


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

      const revision = savedRevision;
      let sections = [];
      try {
        sections = await readSections();
      } catch {
        sections = [];
      }
      if (!started || mine !== generation) return;
      if (revision === savedRevision) saved = sections;
      savedReady = true;
      syncSong();
      syncTick();
      syncPanel();
    }

    function stop() {
      generation += 1;
      started = false;
      clearBoundaryHold();
      stopTick();
      cancelSeekRetry();
      resetVolumePersistence();
      clearSettleCheck();
      if (unsubscribeStorage !== null) {
        try {
          unsubscribeStorage();
        } catch {
        }
        unsubscribeStorage = null;
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
      clearUndo();
      active = true;
      notice = null;
      accumulator = createWheelAccumulator();
      hasVolumeTruth = false;
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


    function bindMediaListener(type, handler) {
      media.addEventListener(type, handler);
      mediaCleanup.push({ type: type, handler: handler });
    }

    function bindMedia() {
      const next = mediaProvider();
      if (next === media) return;
      const replaced = everBound;
      detachMedia();
      media = next || null;
      if (!media) return;
      everBound = true;

      if (replaced) {
        clearBoundaryHold();
        cancelSeekRetry();
        clearSettleCheck();
        session.songKey = null;
        session.restoredSongKey = null;
        session.confirmedKey = null;
        session.identityKnown = false;
        session.startSeconds = null;
        session.endSeconds = null;
        clearPendingRestore(session);
        rememberSavedDisplay();
        fromDirty = false;
        toDirty = false;
        syncPanel();
      }

      bindMediaListener('ended', handleEnded);
      bindMediaListener('loadedmetadata', handleSourceChange);
      bindMediaListener('emptied', handleSourceChange);
      bindMediaListener('volumechange', refreshVolume);
      bindMediaListener('timeupdate', handleProgress);
      bindMediaListener('seeked', handleProgress);
      bindMediaListener('play', handleVolumeRestoreSignal);
      bindMediaListener('playing', handleVolumeRestoreSignal);
    }

    function detachMedia() {
      if (media) {
        for (const listener of mediaCleanup) {
          try {
            media.removeEventListener(listener.type, listener.handler);
          } catch {
          }
        }
      }
      mediaCleanup = [];
      media = null;
    }

    /**
     * A source load is not an identity. The element never says which song its
     * new resource belongs to, so a metadata event for the outgoing source would
     * authorise a seek on it. It only makes the controller look at the URL
     * again: confirmation stays with a push, or with the element observed back
     * at its top when the restore runs.
     */
    function handleSourceChange() {
      if (!started) return;
      clearBoundaryHold();
      syncSong();
      syncTick();
      syncPanel();
    }

    function handleEnded() {
      if (!media) return;
      if (!session.identityKnown) return;
      const target = resolveEndSeekTarget(currentState(), media.duration);
      if (target === null) {
        releaseBoundaryHold();
        return;
      }
      clearBoundaryHold();
      try {
        media.currentTime = target;
        const played = media.play();
        if (played && typeof played.catch === 'function') played.catch(() => {});
      } catch {
      }
    }


    function sameSection(left, right) {
      if (!left || !right) return left === right;
      return left.videoId === right.videoId
        && left.startSeconds === right.startSeconds
        && left.endSeconds === right.endSeconds;
    }

    function clearUndo() {
      undoAvailable = false;
      undoEntry = null;
      undoSongKey = null;
      syncUndo();
    }

    function rememberUndo(previous, videoId) {
      undoAvailable = true;
      undoEntry = previous
        ? { videoId: previous.videoId, startSeconds: previous.startSeconds, endSeconds: previous.endSeconds }
        : null;
      undoSongKey = videoId;
      syncUndo();
    }

    function syncUndo() {
      if (!ui || !ui.undo) return;
      ui.undo.disabled = !(undoAvailable && undoSongKey !== null && undoSongKey === session.songKey);
    }


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
      const identity = currentSongIdentity();
      const key = identity.key;
      session.identityKnown = key !== null;
      if (key === null) {
        if (identity.source === 'lost') {
          forgetSong(session);
          rememberSavedDisplay();
          syncPanel();
        }
        cancelSeekRetry();
        syncTick();
        return;
      }
      if (session.ambiguousVless && songKeyFrom(currentHref()) === key) {
        session.ambiguousVless = false;
      }
      const previousSong = session.songKey !== null;
      const ambiguous = ambiguousVlessPush(identity, key);
      if (beginSong(session, key, identity.source)) {
        session.ambiguousVless = ambiguous;
        clearUndo();
        cancelSeekRetry();
        clearSettleCheck();
        if (previousSong) {
          fromDirty = false;
          toDirty = false;
        }
        syncTick();
        syncPanel();
      }
      if (!songRestorePending(session, key)) return;
      applySavedSection(key);
    }

    function mediaIsMidStream() {
      const at = Number(media && media.currentTime);
      return Number.isFinite(at) && at > UNCONFIRMED_SEEK_GUARD_SECONDS;
    }

    function applySavedSection(key) {
      if (!savedReady) {
        session.pendingRestore = true;
        syncTick();
        return;
      }
      if (session.identityPending) {
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

      const confirmed = session.songKey !== null && session.confirmedKey === session.songKey;
      if (session.ambiguousVless || (!confirmed && (media === null || mediaIsMidStream()))) {
        session.pendingRestore = true;
        if (!session.restoreDeadlineAt) session.restoreDeadlineAt = now() + RESTORE_DEADLINE_MS;
        syncTick();
        syncPanel();
        return;
      }

      session.startSeconds = entry.startSeconds;
      session.endSeconds = entry.endSeconds;
      clearSavedDisplay();
      active = true;
      syncTick();
      syncPanel();

      const start = entry.startSeconds === null ? 0 : entry.startSeconds;
      if (!session.pendingRestore) session.restoreDeadlineAt = now() + RESTORE_DEADLINE_MS;
      session.pendingRestore = true;
      if (!media) return;
      if (seekRetryTimer !== null || seekOnLanded !== null) return;
      requestSeek(start, () => {
        if (!started || session.songKey !== key) return;
        markSongRestored(session, key);
        clearPendingRestore(session);
        armSettleCheck(key, entry.startSeconds);
      });
    }


    function stopTick() {
      if (tickTimer === null) return;
      timers.clearInterval(tickTimer);
      tickTimer = null;
    }

    /**
     * The armed section is the latch. One transient `wanted` false (a song id
     * that blips mid-transition) must never tear the backstop down for the rest
     * of the song, so the interval follows the section and the handlers refuse
     * to seek without an identity. Visibility is not a gate: a hidden tab may
     * have only late element events and a throttled interval, and crossing B
     * there still has to seek back to A.
     */
    function syncTick() {
      if (started && (isLoopEngaged(currentState()) || (session.pendingRestore && session.restoreDeadlineAt > 0))) {
        if (tickTimer === null) tickTimer = timers.setInterval(handleTick, TICK_MS);
        return;
      }
      stopTick();
    }

    function handleTick() {
      if (!started) return;
      if (session.pendingRestore && session.restoreDeadlineAt && now() > session.restoreDeadlineAt) {
        clearPendingRestore(session);
        cancelSeekRetry();
        syncTick();
        syncPanel();
        return;
      }
      bindMedia();
      if (!media) return;

      const identity = currentSongIdentity();
      const key = identity.key;
      session.identityKnown = key !== null;
      if (key === null) {
        if (identity.source === 'lost') {
          forgetSong(session);
          rememberSavedDisplay();
          syncPanel();
        }
        cancelSeekRetry();
        syncTick();
        return;
      }
      if (session.ambiguousVless && songKeyFrom(currentHref()) === key) {
        session.ambiguousVless = false;
      }
      const ambiguous = ambiguousVlessPush(identity, key);
      if (beginSong(session, key, identity.source)) {
        session.ambiguousVless = ambiguous;
        cancelSeekRetry();
        clearSettleCheck();
        fromDirty = false;
        toDirty = false;
        syncTick();
        syncPanel();
        applySavedSection(key);
        return;
      }
      if (session.pendingRestore && songRestorePending(session, key)) {
        applySavedSection(key);
        return;
      }
      if (session.identityPending) return;

      const target = resolveSeekTarget(currentState(), {
        currentTime: media.currentTime,
        duration: media.duration,
        paused: media.paused,
        seeking: media.seeking,
      });
      if (target === null) return;
      clearBoundaryHold();
      try {
        media.currentTime = target;
      } catch {
      }
    }

    /**
     * Applies the same decision as the backstop on the media's own events. It
     * is what makes the loop a latch: `timeupdate` keeps firing every ~250 ms
     * and `seeked` reports a landed seek, so a transient loss of identity or a
     * throttled interval cannot leave an armed section silent for the rest of
     * the song — including while the tab is hidden. Guards match the tick: no
     * identity means no seek, and `resolveSeekTarget` itself refuses a paused
     * or seeking player.
     */
    function handleProgress() {
      if (!started || !media) return;
      const key = currentSongKey();
      if (key !== null && key !== session.songKey) {
        syncSong();
        return;
      }
      if (session.pendingRestore) return;
      if (session.identityPending) return;
      if (!session.identityKnown || session.songKey === null) return;
      const target = resolveSeekTarget(currentState(), {
        currentTime: media.currentTime,
        duration: media.duration,
        paused: media.paused,
        seeking: media.seeking,
      });
      if (target === null) return;
      clearBoundaryHold();
      try {
        media.currentTime = target;
      } catch {
      }
    }


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
      if (typeof event.preventDefault === 'function') event.preventDefault();
      const step = stepVolumeFromWheel(accumulator, event, volume);
      if (!step.applied) return;
      volume = step.volume;
      cancelPendingVolumeRestore();
      applyVolume(step.volume);
      showVolumeHud(step.volume);
    }

    function applyVolume(percent, options) {
      const mine = generation;
      const seq = ++volumeSeq;
      const persist = !options || options.persist !== false;
      if (!pageHook || typeof pageHook.setVolume !== 'function') {
        writeMediaVolume(percent);
        if (persist) scheduleVolumeSave(percent);
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
        if (persist) scheduleVolumeSave(percent);
        return;
      }
      pending.then((reply) => {
        if (!started || mine !== generation || seq !== volumeSeq) return;
        if (!reply || reply.applied === false || reply.source === 'none') {
          writeMediaVolume(percent);
          if (persist) scheduleVolumeSave(percent);
          return;
        }
        const applied = Number(reply.volume);
        if (Number.isFinite(applied)) {
          volume = Math.round(applied);
          hasVolumeTruth = true;
        }
        if (persist) scheduleVolumeSave(volume);
      }).catch(() => {
        if (!started || mine !== generation || seq !== volumeSeq) return;
        writeMediaVolume(percent);
        if (persist) scheduleVolumeSave(percent);
      });
    }


    function canSaveVolume() {
      return Boolean(storage) && typeof storage.saveVolume === 'function';
    }

    /** Arms the coalescing window; the last wheel step inside it wins. */
    function scheduleVolumeSave(percent) {
      if (!canSaveVolume()) return;
      if (typeof percent !== 'number' || !Number.isFinite(percent)) return;
      pendingVolumeSave = Math.min(100, Math.max(0, Math.round(percent)));
      if (volumeSaveTimer !== null) timers.clearTimeout(volumeSaveTimer);
      volumeSaveTimer = timers.setTimeout(() => {
        volumeSaveTimer = null;
        writePendingVolume();
      }, VOLUME_SAVE_MS);
    }

    /** Writes now: the window elapsed, the page is going away, or the tab hid. */
    function flushVolumeSave() {
      if (volumeSaveTimer !== null) {
        timers.clearTimeout(volumeSaveTimer);
        volumeSaveTimer = null;
      }
      writePendingVolume();
    }

    function writePendingVolume() {
      if (!started || !canSaveVolume() || pendingVolumeSave === null) return;
      if (volumeSaveInFlight) return;
      const value = pendingVolumeSave;
      pendingVolumeSave = null;
      volumeSaveInFlight = true;
      const mine = generation;
      let write = null;
      try {
        write = storage.saveVolume(value);
      } catch {
        write = null;
      }
      Promise.resolve(write).catch(() => {}).then(() => {
        volumeSaveInFlight = false;
        if (!started || mine !== generation) return;
        if (pendingVolumeSave !== null) writePendingVolume();
      });
    }

    function onPageHide() {
      flushVolumeSave();
    }

    function resetVolumePersistence() {
      if (volumeSaveTimer !== null) {
        timers.clearTimeout(volumeSaveTimer);
        volumeSaveTimer = null;
      }
      if (volumeRestoreTimer !== null) {
        timers.clearTimeout(volumeRestoreTimer);
        volumeRestoreTimer = null;
      }
      pendingVolumeSave = null;
      volumeSaveInFlight = false;
      volumeRestoreTarget = null;
      volumeRestoreAttempts = 0;
      volumeRestoreSettled = false;
    }

    /**
     * Applies a stored volume once, through the same page-hook path the wheel
     * uses. It waits for the first real playback start, because that is when
     * YouTube Music has restored its own value, then leaves the page alone.
     */
    function restoreVolume(percent) {
      if (percent === null || percent === undefined || percent === '') return;
      if (typeof percent !== 'number' && typeof percent !== 'string') return;
      const value = Number(percent);
      if (!Number.isFinite(value) || volumeRestoreSettled) return;
      volumeRestoreTarget = Math.min(100, Math.max(0, Math.round(value)));
      attemptVolumeRestore();
    }

    function handleVolumeRestoreSignal() {
      if (volumeRestoreAttempts > 0) return;
      attemptVolumeRestore();
    }

    function attemptVolumeRestore() {
      if (volumeRestoreSettled || volumeRestoreTarget === null) return;
      if (!started || !media || media.paused) return;
      if (volumeRestoreAttempts >= VOLUME_RESTORE_ATTEMPTS) {
        settleVolumeRestore();
        return;
      }
      volumeRestoreAttempts += 1;
      const target = volumeRestoreTarget;
      volume = target;
      hasVolumeTruth = true;
      showVolumeHud(target);
      applyVolume(target, { persist: false });
      if (volumeRestoreAttempts >= VOLUME_RESTORE_ATTEMPTS) {
        settleVolumeRestore();
        return;
      }
      if (volumeRestoreTimer !== null) timers.clearTimeout(volumeRestoreTimer);
      volumeRestoreTimer = timers.setTimeout(() => {
        volumeRestoreTimer = null;
        if (!started || volumeRestoreSettled) return;
        if (mediaVolumeMatches(target)) {
          settleVolumeRestore();
          return;
        }
        attemptVolumeRestore();
      }, VOLUME_RESTORE_RETRY_MS);
    }

    /** A user wheel step owns the volume: drop a restore that has not run. */
    function cancelPendingVolumeRestore() {
      volumeRestoreSettled = true;
      volumeRestoreTarget = null;
      volumeRestoreAttempts = 0;
      if (volumeRestoreTimer !== null) {
        timers.clearTimeout(volumeRestoreTimer);
        volumeRestoreTimer = null;
      }
    }

    function mediaVolumeMatches(percent) {
      const element = Number(media && media.volume);
      if (!Number.isFinite(element)) return false;
      return Math.abs(element - percent * YTM_ELEMENT_PER_PLAYER) <= VOLUME_RESTORE_TOLERANCE;
    }

    function settleVolumeRestore() {
      volumeRestoreSettled = true;
      volumeRestoreTarget = null;
      volumeRestoreAttempts = 0;
      if (volumeRestoreTimer !== null) {
        timers.clearTimeout(volumeRestoreTimer);
        volumeRestoreTimer = null;
      }
    }

    function writeMediaVolume(percent) {
      if (media) {
        try {
          media.volume = Math.min(1, Math.max(0, percent * YTM_ELEMENT_PER_PLAYER));
        } catch {
        }
      }
      if (pageHook && typeof pageHook.syncVolumeUi === 'function') {
        try {
          pageHook.syncVolumeUi(percent);
        } catch {
        }
      }
    }


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
      if (seekRetryCount >= SEEK_RETRY_ATTEMPTS) {
        seekOnLanded = null;
        return false;
      }
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

      let lockRow = null;
      let lock = null;
      if (lockPitchApi) {
        lockRow = doc.createElement('label');
        lockRow.className = 'slra-row';
        lock = doc.createElement('input');
        lock.type = 'checkbox';
        lock.setAttribute('aria-label', 'Lock pitch');
        const lockText = doc.createElement('span');
        lockText.textContent = 'Lock pitch';
        lockRow.append(lock, lockText);
      }

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
      const undo = buildButton('\u21BA', 'Restore previous section');
      undo.classList.add('slra-icon');
      undo.title = 'Restore previous section';
      undo.disabled = true;
      actions.append(clear, save, undo);

      const panelRows = [repeatRow];
      if (lockRow) panelRows.push(lockRow);
      panelRows.push(fromRow.row, toRow.row, status, actions);
      panel.append(...panelRows);

      const volumeHud = doc.createElement('div');
      volumeHud.className = 'slra-volume';
      volumeHud.setAttribute('aria-hidden', 'true');

      const pill = doc.createElement('button');
      pill.type = 'button';
      pill.className = 'slra-pill';
      pill.textContent = 'Repeat';
      pill.setAttribute('aria-label', 'Section repeat');

      const bar = doc.createElement('div');
      bar.className = 'slra-bar';
      bar.append(volumeHud, pill);

      shell.append(panel, bar);
      shadow.appendChild(shell);
      parent.appendChild(host);

      ui = {
        host: host,
        shadow: shadow,
        panel: panel,
        repeat: repeat,
        lock: lock,
        from: fromRow.input,
        to: toRow.input,
        fromNow: fromRow.now,
        toNow: toRow.now,
        status: status,
        clear: clear,
        save: save,
        undo: undo,
        volumeHud: volumeHud,
        pill: pill,
      };

      repeat.addEventListener('change', () => {
        active = repeat.checked;
        notice = null;
        syncTick();
        syncPanel();
      });
      if (lock) {
        lock.addEventListener('change', () => {
          void storage.saveLockPitch(lock.checked);
          syncPanel();
        });
      }
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
      ui.undo.addEventListener('click', () => {
        requestUndo();
      });
      ui.pill.addEventListener('click', () => {
        ui.panel.classList.toggle('open');
      });

      syncPanel();
      if (Number.isFinite(volume)) showVolumeHud(volume);
    }

    function showVolumeHud(percent) {
      if (!ui) return;
      const value = Math.round(Number(percent));
      if (!Number.isFinite(value)) return;
      ui.volumeHud.textContent = Math.max(0, Math.min(100, value)) + '%';
    }

    function destroyUi() {
      if (!ui) return;
      try {
        ui.host.remove();
      } catch {
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
      const start = session.startSeconds;
      const end = session.endSeconds;
      let bad = live.invalid;

      if (!bad) {
        if (end !== null && end <= (start === null ? 0 : start)) bad = true;
      }
      setInvalid(ui.from, live.from.kind === 'invalid' || bad);
      setInvalid(ui.to, live.to.kind === 'invalid' || bad);
      if (fromDirty) ui.from.setAttribute('data-editing', 'true');
      else ui.from.removeAttribute('data-editing');
      if (toDirty) ui.to.setAttribute('data-editing', 'true');
      else ui.to.removeAttribute('data-editing');

      let text;
      if (bad) {
        text = 'Invalid range';
      } else if (notice === 'failed') {
        text = 'Save failed';
      } else if (notice === 'no-song') {
        text = 'Play a track to save';
      } else if (notice === 'saved') {
        text = 'Saved';
      } else if (notice === 'removed') {
        text = 'Removed';
      } else if (!session.identityKnown) {
        text = 'Play a track to repeat';
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
      if (ui.lock) ui.lock.checked = currentLockPitch();
      const fromSeconds = session.startSeconds === null ? session.displayStartSeconds : session.startSeconds;
      const toSeconds = session.endSeconds === null ? session.displayEndSeconds : session.endSeconds;
      if (!fromDirty) ui.from.value = fromSeconds === null ? '' : formatTime(fromSeconds);
      if (!toDirty) ui.to.value = toSeconds === null ? '' : formatTime(toSeconds);
      syncUndo();
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

      // An adopted song whose identity is being re-read owns the transport.
      // A commit now would seek the reused element and save the edit to the
      // outgoing song. A dropped song (null key) can still vouch by press.
      if (session.identityPending && session.songKey !== null) {
        paintStatus();
        return;
      }

      cancelSeekRetry();
      clearSettleCheck();
      clearPendingRestore(session);
      clearSavedDisplay();

      let adoptedByPress = false;
      if (session.songKey === null) {
        const identity = currentSongIdentity();
        if (identity.key !== null && identity.source !== 'lost') {
          session.songKey = identity.key;
          session.identityKnown = true;
          session.confirmedKey = identity.key;
          session.pressVouched = true;
          session.identityPending = false;
          adoptedByPress = true;
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

      if (source === 'from') {
        clearSettleCheck();
        const key = session.songKey;
        const vouched = adoptedByPress || (key !== null && session.confirmedKey === key);
        if (key !== null && (vouched || !mediaIsMidStream())) {
          requestSeek(live.startSeconds === null ? 0 : live.startSeconds, () => {
            if (!started || session.songKey !== key) return;
            armSettleCheck(key, live.startSeconds);
          });
        }
      }
      syncTick();
      syncPanel();
      requestSave({ erase: source === 'clear' });
    }


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
      savedRevision += 1;
      saved = sanitizeSaved(sections);
      savedReady = true;
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

    function requestSave(options) {
      if (!ui) return;
      const videoId = session.songKey;
      if (videoId === null || !session.identityKnown) {
        notice = 'no-song';
        syncPanel();
        return;
      }
      const entry = {
        videoId: videoId,
        startSeconds: session.startSeconds,
        endSeconds: session.endSeconds,
      };
      if (entry.startSeconds === null && entry.endSeconds === null && !(options && options.erase)) {
        syncPanel();
        return;
      }
      if (savedReady) {
        const current = lookupSaved(saved, videoId);
        const empty = entry.startSeconds === null && entry.endSeconds === null;
        if (current === null ? empty : sameSection(current, entry)) {
          syncPanel();
          return;
        }
      }
      notice = null;
      startSave(entry);
    }

    function sectionKey(entry) {
      return entry.videoId + '|' + entry.startSeconds + '|' + entry.endSeconds;
    }

    function startSave(entry, options) {
      const key = sectionKey(entry);
      if (saveInFlight && saveInFlight.key === key) return saveInFlight.promise;
      const promise = save(entry, options).finally(() => {
        if (saveInFlight && saveInFlight.promise === promise) saveInFlight = null;
      });
      saveInFlight = { key: key, promise: promise };
      return promise;
    }

    function requestUndo() {
      if (!ui || !undoAvailable || undoSongKey === null || undoSongKey !== session.songKey) return;
      const target = undoEntry;
      const videoId = undoSongKey;
      active = target !== null;
      session.startSeconds = target ? target.startSeconds : null;
      session.endSeconds = target ? target.endSeconds : null;
      fromDirty = false;
      toDirty = false;
      notice = null;
      cancelSeekRetry();
      clearSettleCheck();
      syncTick();
      syncPanel();
      if (target && target.startSeconds !== null) requestSeek(target.startSeconds, null);
      startSave(
        { videoId: videoId, startSeconds: session.startSeconds, endSeconds: session.endSeconds },
        { restoring: true },
      );
    }

    async function save(entry, options) {
      const opts = options || {};
      const mine = generation;
      const removed = entry.startSeconds === null && entry.endSeconds === null;
      const hadCache = savedReady;
      const previous = hadCache ? lookupSaved(saved, entry.videoId) : null;
      try {
        const reply = await requestSectionSave(entry, mine);
        if (!started || mine !== generation) return false;
        if (!reply || reply.ok !== true) {
          notice = 'failed';
          syncPanel();
          return false;
        }
        if (Array.isArray(reply.sections)) {
          saved = sanitizeSaved(reply.sections);
          savedReady = true;
        }
        if (opts.restoring) {
          clearUndo();
        } else if (hadCache && !sameSection(previous, entry)) {
          rememberUndo(previous, entry.videoId);
        }
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
          }, NOTICE_VISIBLE_MS);
        }
        return true;
      } catch {
        if (!started || mine !== generation) return false;
        notice = 'failed';
        syncPanel();
        return false;
      }
    }


    function onSongSignal() {
      if (!started) return;
      syncSong();
      syncTick();
      syncPanel();
    }

    function onVisibilityChange() {
      if (!started) return;
      if (!isVisible()) flushVolumeSave();
      syncTick();
    }

    function installSongListeners() {
      if (songListenersInstalled) return;
      songListenersInstalled = true;
      for (const name of SONG_EVENTS) win.addEventListener(name, onSongSignal, true);
      doc.addEventListener('visibilitychange', onVisibilityChange);
      win.addEventListener('pagehide', onPageHide);
    }

    function removeSongListeners() {
      if (!songListenersInstalled) return;
      songListenersInstalled = false;
      for (const name of SONG_EVENTS) win.removeEventListener(name, onSongSignal, true);
      doc.removeEventListener('visibilitychange', onVisibilityChange);
      win.removeEventListener('pagehide', onPageHide);
    }

    return {
      start: start,
      stop: stop,
      sync: sync,
      setSongId: setSongId,
      invalidateSongIdentity: invalidateSongIdentity,
      suspendSongIdentity: suspendSongIdentity,
      setPlayerVolume: setPlayerVolume,
      restoreVolume: restoreVolume,
    };
  }
  const api = {
    WHEEL_PX_PER_STEP: WHEEL_PX_PER_STEP,
    VOLUME_STEP_PCT: VOLUME_STEP_PCT,
    YTM_ELEMENT_PER_PLAYER: YTM_ELEMENT_PER_PLAYER,
    playerVolumeFromElement: playerVolumeFromElement,
    TICK_MS: TICK_MS,
    NOTICE_VISIBLE_MS: NOTICE_VISIBLE_MS,
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
    validateSavedList: validateSavedList,
    mergeSavedLists: mergeSavedLists,
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
