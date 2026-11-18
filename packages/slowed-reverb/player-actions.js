/* global module */
/*
 * player-actions.js - easy volume (wheel over non-scrolling player chrome) and
 * section repeat (A-B loop) for YouTube Music.
 *
 * Ported from pear-slowed-reverb: precise-volume/renderer.ts (wheel) and
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
  // YouTube Music's element volume is NOT player scale: `#movie_player.setVolume`
  // writes `video.volume ~= player * 0.00741` (element max ~= 0.741, measured
  // in-repo: 20 -> 0.148, 80 -> 0.593, 100 -> 0.741). The wheel cache below is
  // player scale, so element reads convert through this slope and fallback
  // writes scale into the element domain. Both uses are seeds only: the page's
  // applied reply is the truth and self-corrects them on the next wheel notch.
  const YTM_ELEMENT_PER_PLAYER = 0.00741;
  const TICK_MS = 100;
  const NOTICE_VISIBLE_MS = 1200;
  // Sticky volume: one coalesced write per wheel burst, and one bounded restore
  // per page load through the same page-hook path the wheel uses.
  const VOLUME_SAVE_MS = 300;
  const VOLUME_RESTORE_ATTEMPTS = 2;
  const VOLUME_RESTORE_RETRY_MS = 600;
  const VOLUME_RESTORE_TOLERANCE = 0.02;
  const SAVED_LIMIT = 100;
  const RESTORE_DEADLINE_MS = 3000;
  const PLAYER_BAR_TAG = 'YTMUSIC-PLAYER-BAR';
  const MAIN_PANEL_ID = 'main-panel';
  const SEEK_RETRY_MS = 120;
  const SEEK_RETRY_ATTEMPTS = 3;
  const SEEK_TOLERANCE_SECONDS = 0.25;
  const SETTLE_MS = 1200;
  const SETTLE_NEAR_ZERO_SECONDS = 1;
// An unconfirmed identity may only seek a media element that is still at its
// top. Past this point the element is already playing something, and moving it
// would drag the outgoing track into the new song's section.
const UNCONFIRMED_SEEK_GUARD_SECONDS = 1;
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
      // How the current identity was learned ('push' or 'url'), and which key a
      // source-change signal has confirmed. Tying the confirmation to a key -
      // never a bare flag - means it cannot authorise a later song.
      identitySource: null,
      confirmedKey: null,
      // True once any song has been adopted in this document. A URL-sourced
      // adoption is only a "first visit" (and therefore self-confirming) while
      // this is false; an invalidated visit is not virgin again.
      everAdopted: false,
      // Set while an on-demand read is in flight: nothing may seek until it
      // answers, because the media may already be another song.
      identityPending: false,
      // Set when a deliberate commit claimed this visit after an identity read
      // began. That read was already stale when the person pressed, so its later
      // answer or invalidation must not silently undo the press.
      pressVouched: false,
      startSeconds: null,
      endSeconds: null,
      pendingRestore: false,
      restoreDeadlineAt: 0,
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
    session.songKey = key;
    session.restoredSongKey = null;
    session.startSeconds = null;
    session.endSeconds = null;
    session.pendingRestore = false;
    // Each visit owns its restore window: one inherited from the previous song
    // would expire this one before its source could even load.
    session.restoreDeadlineAt = 0;
    session.identitySource = source === 'push' || source === 'url' ? source : null;
    // A push names the media the player loaded, and the first adoption of a
    // document has no outgoing track to disturb. A URL-only change may still be
    // playing the previous song, so it stays unconfirmed until a signal says
    // otherwise - and that confirmation is bound to this key.
    session.confirmedKey = session.identitySource === 'push' || firstEver ? key : null;
    session.pressVouched = false;
    return true;
  }

  /**
   * Drops a visit's points without touching the user's Repeat preference. A
   * navigation that leaves the song must not keep the old section armed.
   */
  function forgetSong(session) {
    // Clearing the key makes the return to the same song a fresh visit: with it
    // left behind, beginSong sees "no change" and the rearm never happens.
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
    // YouTube Music's slider is quantized to 5 %. Snap by direction instead of
    // adding 5 blindly, or 37 + 5 = 42 would land on 40 while we said 42.
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

    // Positive allowlist. YouTube Music's browse surfaces compute
    // `overflow-y: visible` on an actually scrolling document, so an overflow
    // heuristic cannot separate them from the player; only the player bar and
    // the player panel are ours. Everything else keeps native scrolling: browse
    // shelves, the guide, the queue, lyrics and the nav bar.
    const style = typeof getStyle === 'function' ? getStyle : () => null;
    let surface = -1;
    for (let index = 0; index < chain.length; index += 1) {
      if (isPlayerSurface(chain[index], style)) {
        surface = index;
        break;
      }
    }
    if (surface === -1) return { handle: false, reason: 'not-player-surface' };

    // Inside the surface, a genuinely scrollable descendant still wins.
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

  // -------------------------------------------------------------------------
  // DOM controller
  // -------------------------------------------------------------------------

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
    const getStyle = typeof settings.getStyle === 'function'
      ? settings.getStyle
      : (node) => win.getComputedStyle(node);

    let started = false;
    let generation = 0;
    let saved = [];
    let savedReady = false;
    // Bumped by every subscription update: a read that started earlier must not
    // overwrite a newer cache.
    let savedRevision = 0;
    let pageSongId = null;
    let songIdPushed = false;
    // The href the pushed id was taken in. The page hook sends its own href, so
    // a push describes the navigation it belongs to; one that arrives later (a
    // replay, or a URL that already moved on) cannot borrow a newer one.
    let pageSongHref = null;
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
    // One-level undo for the current song's saved section. `undoEntry === null`
    // with `undoAvailable` means the section did not exist before the last write.
    let undoAvailable = false;
    let undoEntry = null;
    let undoSongKey = null;
    // One write per identical section: auto-save and a Save click in quick
    // succession must not queue two writes for the same range.
    let saveInFlight = null;
    // Sticky volume: `pendingVolumeSave` is the newest wheel value waiting for
    // the coalescing window; one write is in flight at a time.
    let pendingVolumeSave = null;
    let volumeSaveTimer = null;
    let volumeSaveInFlight = false;
    // A restore runs once per controller session; after it settles the page
    // owns the value again and nothing here writes on its own.
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
      const fromUrl = songKeyFrom(currentHref());
      if (!songIdPushed) {
        return { key: fromUrl, source: fromUrl === null ? null : 'url' };
      }
      const pushedForKey = songKeyFrom(pageSongHref);
      if (fromUrl === null) {
        // A v-less URL is either the page the push was taken in (Home) or a
        // page we moved to afterwards. Only the first may keep the points.
        if (pushedForKey !== null) return { key: null, source: 'lost' };
        return { key: pageSongId, source: pageSongId === null ? 'blip' : 'push' };
      }
      if (pushedForKey !== fromUrl) {
        // The push was taken in another navigation. The URL is the newer one,
        // and its song is only a candidate until the media confirms the swap.
        return { key: fromUrl, source: 'url' };
      }
      // The push describes this navigation: the player's own id wins, even
      // before the history entry catches up.
      return { key: pageSongId, source: pageSongId === null ? 'blip' : 'push' };
    }

    function currentSongKey() {
      return currentSongIdentity().key;
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
      // Adopted truth is what the readout shows, whoever moved the number.
      showVolumeHud(volume);
      // A slider drag is a deliberate change, like a wheel step: it outranks a
      // restore that has not applied yet. An install/revive/poll push is only a
      // reading of the page's own value; cancelling there would kill the restore
      // this document exists to make.
      if (options && options.user === true) {
        cancelPendingVolumeRestore();
        // The dragged value is the user's number for this site: carry it to the
        // next document through the same coalesced writer the wheel uses. A
        // poll is only a reading, so it never writes storage.
        scheduleVolumeSave(volume);
      }
    }

    /**
     * A source signal may already be another song, and the read that decides it
     * is in flight. Suspend the latch until the answer lands: nothing seeks in
     * the meantime, and an unreadable answer invalidates.
     */
    function suspendSongIdentity() {
      session.identityPending = true;
      session.confirmedKey = null;
      // A fresh source signal gives the new read the visit, even if an earlier
      // press had vouched for it.
      session.pressVouched = false;
    }

    /**
     * Fail closed: the media's source changed and nothing could confirm which
     * song it holds now. Drop the visit and the remembered push, so only a new
     * push or a readable player id adopts a song again. Repeat stays as the user
     * left it; nothing can seek until something vouches for the media.
     */
    function invalidateSongIdentity() {
      // A deliberate press claimed this visit after the read began. That read
      // was stale at press time: its timeout or unreadable answer may not undo
      // the committed range. Provenance is left intact - nothing is cleared or
      // bypassed - only this stale invalidation is ignored.
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
      cancelSeekRetry();
      clearSettleCheck();
      syncTick();
      syncPanel();
    }

    /** Adopts the id pushed by the page hook (null when no track is loaded). */
    function setSongId(next, href) {
      const normalized = typeof next === 'string' && next !== '' ? next : null;
      // Any delivered id answers a pending read, and vouches for the visit it
      // names even when the URL adopted that song first: beginSong does not run
      // for an already adopted key, so without this a deferred restore waiting
      // on a player vouch could never proceed. Provenance still moves only with
      // the id, and the one-restore-per-visit latch stops a repeat from seeking.
      session.identityPending = false;
      songIdPushed = true;
      if (session.songKey === normalized && normalized !== null) {
        session.confirmedKey = normalized;
      }
      // Provenance moves only when the id does. A repeat push of the same id
      // taken on a newer URL would otherwise re-anchor the old song to the new
      // navigation, which is how it kept running there.
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
      const revision = savedRevision;
      let sections = [];
      try {
        sections = await readSections();
      } catch {
        sections = [];
      }
      if (!started || mine !== generation) return;
      // A subscription update during the read is newer than this read.
      if (revision === savedRevision) saved = sections;
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
      resetVolumePersistence();
      clearSettleCheck();
      if (unsubscribeStorage !== null) {
        try {
          unsubscribeStorage();
        } catch {
          // Already detached.
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
        session.confirmedKey = null;
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
      // The section must loop on the media's own clock, not only on the backstop
      // interval: timeupdate fires while playing and seeked when a seek lands.
      bindMediaListener('timeupdate', handleProgress);
      bindMediaListener('seeked', handleProgress);
      // The stored volume is applied once the page has restored its own value,
      // which happens around the first real playback start.
      bindMediaListener('play', handleVolumeRestoreSignal);
      bindMediaListener('playing', handleVolumeRestoreSignal);
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

    /**
     * A source load is not an identity. The element never says which song its
     * new resource belongs to, so a metadata event for the outgoing source would
     * authorise a seek on it. It only makes the controller look at the URL
     * again: confirmation stays with a push, or with the element observed back
     * at its top when the restore runs.
     */
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

    // -- undo ---------------------------------------------------------------

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
      const identity = currentSongIdentity();
      const key = identity.key;
      session.identityKnown = key !== null;
      if (key === null) {
        if (identity.source === 'lost') {
          forgetSong(session);
          syncPanel();
        }
        cancelSeekRetry();
        syncTick();
        return;
      }
      // Captured before adoption: beginSong overwrites the key.
      const previousSong = session.songKey !== null;
      if (beginSong(session, key, identity.source)) {
        // Undo belongs to one song visit; a new song never inherits it.
        clearUndo();
        cancelSeekRetry();
        clearSettleCheck();
        // A genuine song change drops the previous song's typed text; the first
        // adoption of the current song leaves an in-progress edit alone (the
        // cache landing must not clobber it).
        if (previousSong) {
          fromDirty = false;
          toDirty = false;
        }
        syncTick();
        syncPanel();
      }
      // One restore per song visit; a repeat event must not re-seek.
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
      // An identity read is in flight: nothing may seek or adopt an identity
      // until it lands. The reloaded element being at its top is not the
      // player's answer, so the deferred visit stays pending.
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
      if (!confirmed && (media === null || mediaIsMidStream())) {
        // Fail closed: the URL named this song, but nothing has shown that the
        // page media switched with it (a push for it, or a loaded new source).
        // An element already playing would be dragged into this song's range,
        // and with no element yet the first one to appear may be the outgoing
        // track - arming the section now is what lets handleProgress seek it.
        // A fresh element at its top has nothing to drag, so a normal load
        // still restores instantly.
        session.pendingRestore = true;
        if (!session.restoreDeadlineAt) session.restoreDeadlineAt = now() + RESTORE_DEADLINE_MS;
        syncTick();
        syncPanel();
        return;
      }

      session.startSeconds = entry.startSeconds;
      session.endSeconds = entry.endSeconds;
      // A saved section comes back armed: Repeat off must not mute its range.
      active = true;
      // Dirty fields are left alone: an in-progress edit outranks a cache restore
      // and its commit will win.
      syncTick();
      syncPanel();

      const start = entry.startSeconds === null ? 0 : entry.startSeconds;
      // Pending until the seek lands: no element yet, or every attempt so far
      // was swallowed. The tick retries, and the deadline below ends it.
      if (!session.pendingRestore) session.restoreDeadlineAt = now() + RESTORE_DEADLINE_MS;
      session.pendingRestore = true;
      if (!media) return;
      // One ladder at a time: the tick must not restart an in-flight seek.
      if (seekRetryTimer !== null || seekOnLanded !== null) return;
      requestSeek(start, () => {
        if (!started || session.songKey !== key) return;
        // Latch only when the seek actually lands.
        markSongRestored(session, key);
        clearPendingRestore(session);
        armSettleCheck(key, entry.startSeconds);
      });
    }

    // -- loop tick ---------------------------------------------------------

    function stopTick() {
      if (tickTimer === null) return;
      timers.clearInterval(tickTimer);
      tickTimer = null;
    }

    /**
     * The armed section is the latch. One transient `wanted` false (a song id
     * that blips mid-transition, a hidden tab) must never tear the backstop
     * down for the rest of the song, so the interval follows the section and
     * the handlers refuse to seek without an identity or in a hidden tab.
     */
    function syncTick() {
      // A deferred restore keeps the tick alive: the element returning to its
      // top is itself the confirmation that a new source loaded, and the tick is
      // what retries the seek then. The restore deadline bounds it.
      // Only a deferred restore that owns a deadline keeps the backstop: a
      // cache read that never lands must not leave a tick firing forever.
      if (started && (isLoopEngaged(currentState()) || (session.pendingRestore && session.restoreDeadlineAt > 0))) {
        if (tickTimer === null) tickTimer = timers.setInterval(handleTick, TICK_MS);
        return;
      }
      stopTick();
    }

    function handleTick() {
      if (!started) return;
      // Deadline first: a pending restore with no media must still expire
      // instead of waking every tick forever.
      if (session.pendingRestore && session.restoreDeadlineAt && now() > session.restoreDeadlineAt) {
        // The window ends the retry, not the visit. Marking it restored here
        // consumed an unrestored song and left its saved section dead for the
        // rest of the visit, even when the player vouched for it later.
        clearPendingRestore(session);
        cancelSeekRetry();
        syncTick();
        syncPanel();
        return;
      }
      // A hidden tab keeps the backstop but does no work, as before.
      if (!isVisible()) return;
      bindMedia();
      if (!media) return;

      const identity = currentSongIdentity();
      const key = identity.key;
      session.identityKnown = key !== null;
      if (key === null) {
        if (identity.source === 'lost') {
          forgetSong(session);
          syncPanel();
        }
        cancelSeekRetry();
        syncTick();
        return;
      }
      if (beginSong(session, key, identity.source)) {
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
      if (session.pendingRestore && songRestorePending(session, key)) {
        applySavedSection(key);
        return;
      }
      // The latch is suspended while an identity read is in flight.
      if (session.identityPending) return;

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

    /**
     * Applies the same decision as the backstop on the media's own events. It
     * is what makes the loop a latch: `timeupdate` keeps firing every ~250 ms
     * and `seeked` reports a landed seek, so a transient loss of identity or a
     * throttled interval cannot leave an armed section silent for the rest of
     * the song. Guards match the tick: no identity and no visible tab means no
     * seek, and `resolveSeekTarget` itself refuses a paused or seeking player.
     */
    function handleProgress() {
      if (!started || !media || !isVisible()) return;
      const key = currentSongKey();
      if (key !== null && key !== session.songKey) {
        // A reused element plus a missed push: adopt the new song before any
        // seek, so the previous song's points can never move this one.
        syncSong();
        return;
      }
      if (session.pendingRestore) return;
      // The latch is suspended while an identity read is in flight.
      if (session.identityPending) return;
      if (!session.identityKnown || session.songKey === null) return;
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
      // The player surfaces own the wheel: never let it scroll the page, even
      // at a rail or while a trackpad delta is still banking toward a step.
      if (typeof event.preventDefault === 'function') event.preventDefault();
      const step = stepVolumeFromWheel(accumulator, event, volume);
      if (!step.applied) return;
      volume = step.volume;
      // A wheel step is a deliberate change and outranks a restore that has not
      // applied yet: a paused page can be scrolled before playback starts.
      cancelPendingVolumeRestore();
      applyVolume(step.volume);
      showVolumeHud(step.volume);
    }

    function applyVolume(percent, options) {
      // One sequence per write, scoped by generation: a late reply from before a
      // stop cannot overwrite the new session's volume.
      const mine = generation;
      const seq = ++volumeSeq;
      // A restore is not a user change: it must not write storage again.
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
        // The page's applied value is the truth; the element mirrors it.
        // From here the cache follows replies only, never element re-reads.
        const applied = Number(reply.volume);
        if (Number.isFinite(applied)) {
          volume = Math.round(applied);
          hasVolumeTruth = true;
        }
        // Persist what the page ended up with, not what was asked for.
        if (persist) scheduleVolumeSave(volume);
      }).catch(() => {
        if (!started || mine !== generation || seq !== volumeSeq) return;
        writeMediaVolume(percent);
        if (persist) scheduleVolumeSave(percent);
      });
    }

    // -- sticky volume -----------------------------------------------------

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
      // One write in flight; the newest value waits for it and then goes.
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
      // `Number(null)` is 0: a missing value must never restore silence.
      if (percent === null || percent === undefined || percent === '') return;
      if (typeof percent !== 'number' && typeof percent !== 'string') return;
      const value = Number(percent);
      if (!Number.isFinite(value) || volumeRestoreSettled) return;
      volumeRestoreTarget = Math.min(100, Math.max(0, Math.round(value)));
      attemptVolumeRestore();
    }

    function handleVolumeRestoreSignal() {
      // play/playing only wait for the right moment: once a value has been
      // written, the single bounded retry owns the after-the-fact check.
      if (volumeRestoreAttempts > 0) return;
      attemptVolumeRestore();
    }

    function attemptVolumeRestore() {
      if (volumeRestoreSettled || volumeRestoreTarget === null) return;
      // No element yet, or no playback yet: the next play/playing retries.
      if (!started || !media || media.paused) return;
      if (volumeRestoreAttempts >= VOLUME_RESTORE_ATTEMPTS) {
        settleVolumeRestore();
        return;
      }
      volumeRestoreAttempts += 1;
      const target = volumeRestoreTarget;
      // Seed the cache and the permanent readout, so both agree with the value
      // being applied; the next wheel step starts from it too.
      volume = target;
      hasVolumeTruth = true;
      showVolumeHud(target);
      applyVolume(target, { persist: false });
      if (volumeRestoreAttempts >= VOLUME_RESTORE_ATTEMPTS) {
        settleVolumeRestore();
        return;
      }
      // One bounded retry, only if the page put its own value back.
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
          // A detached element cannot be written.
        }
      }
      // The page player API was unavailable, so the hook did not touch YTM's
      // control: ask it for the same UI sync with the value we just wrote.
      if (pageHook && typeof pageHook.syncVolumeUi === 'function') {
        try {
          pageHook.syncVolumeUi(percent);
        } catch {
          // Failure to paint the slider is not a failed volume write.
        }
      }
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
      if (seekRetryCount >= SEEK_RETRY_ATTEMPTS) {
        // Out of attempts: the landing callback can never fire, so the next
        // signal or tick may start a fresh ladder.
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
      // One glyph, not a word: the least footprint for a one-step undo.
      const undo = buildButton('\u21BA', 'Restore previous section');
      undo.classList.add('slra-icon');
      undo.title = 'Restore previous section';
      undo.disabled = true;
      actions.append(clear, save, undo);

      panel.append(repeatRow, fromRow.row, toRow.row, status, actions);

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
      // Seed the persistent readout from whatever the page currently reports.
      if (Number.isFinite(volume)) showVolumeHud(volume);
    }

    // The readout is permanent: it always shows the live volume, so a wheel
    // step updates the number and nothing schedules a hide.
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
        text = 'Play a track to save';
      } else if (notice === 'saved') {
        text = 'Saved';
      } else if (notice === 'removed') {
        text = 'Removed';
      } else if (!session.identityKnown) {
        // No player id: repeat needs a track. Live looping still works.
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
      if (!fromDirty) ui.from.value = session.startSeconds === null ? '' : formatTime(session.startSeconds);
      if (!toDirty) ui.to.value = session.endSeconds === null ? '' : formatTime(session.endSeconds);
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

      // Any commit (From, To, Clear) cancels outstanding position work first: the
      // new points own playback, and Clear must never jump.
      cancelSeekRetry();
      clearSettleCheck();
      clearPendingRestore(session);

      // A deliberate press is a vouch (A-semantics): when a suspended read or
      // an invalidation left no song, the URL still names one and this edit
      // adopts it. Provenance is not bypassed - currentSongIdentity still decides
      // which key may be adopted, and a 'lost' v-less identity adopts nothing.
      // The press owns the visit from here: a read that was already in flight is
      // stale relative to it and cannot silently undo it.
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

      // A committed From jumps playback there at once, armed or not and without
      // a known duration; To/clear never seek. The press vouches for the song it
      // adopted, so that seek is bounded to the URL's song. When the song was
      // adopted earlier (an unconfirmed URL candidate after a navigation) the
      // element is not known to hold that song: a mid-stream, unconfirmed source
      // is never dragged into the range, which is how a section got onto another
      // song. A fresh element at its top, or one the player already vouched for,
      // still seeks at once.
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
      // Now, Enter, blur and Clear all land here: the committed range is the
      // saved range, so no separate Save click is needed. Only Clear is an
      // erasure: an identity drop repaints the fields empty, and an Enter or a
      // blur on those empty fields must never delete the stored section.
      requestSave({ erase: source === 'clear' });
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
      savedRevision += 1;
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

    function requestSave(options) {
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
      // Empty fields after an identity drop are not a Clear: commit() re-adopts
      // the id from the URL, which would otherwise turn a stray Enter or blur
      // into a forget. Only an explicit Clear (or undo) may erase a section.
      if (entry.startSeconds === null && entry.endSeconds === null && !(options && options.erase)) {
        syncPanel();
        return;
      }
      // A commit that matches what is already saved (a blur after Enter, a
      // repeated Save, Clear on an unsaved song) is not a write.
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
      // Undo is one step: restore the fields, then write the previous state.
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
      // Snapshot the destination before the write: that is what undo restores.
      const hadCache = savedReady;
      const previous = hadCache ? lookupSaved(saved, entry.videoId) : null;
      try {
        const reply = await requestSectionSave(entry, mine);
        // A stop (or a new session) owns the state now: mutate nothing.
        if (!started || mine !== generation) return false;
        // `ok:false` is a storage failure, not a rejection: never claim a save
        // and never touch the cache.
        if (!reply || reply.ok !== true) {
          notice = 'failed';
          syncPanel();
          return false;
        }
        // Adopt the writer's list now; the onChanged echo is then a no-op.
        if (Array.isArray(reply.sections)) {
          saved = sanitizeSaved(reply.sections);
          savedReady = true;
        }
        if (opts.restoring) {
          clearUndo();
        } else if (hadCache && !sameSection(previous, entry)) {
          rememberUndo(previous, entry.videoId);
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

    // -- page signals ------------------------------------------------------

    function onSongSignal() {
      if (!started) return;
      syncSong();
      syncTick();
      syncPanel();
    }

    function onVisibilityChange() {
      if (!started) return;
      // A hidden tab may be about to be discarded: land the pending wheel value.
      if (!isVisible()) flushVolumeSave();
      syncTick();
    }

    function installSongListeners() {
      if (songListenersInstalled) return;
      songListenersInstalled = true;
      // Independent of the tick: a swap while disarmed must still be seen.
      for (const name of SONG_EVENTS) win.addEventListener(name, onSongSignal, true);
      doc.addEventListener('visibilitychange', onVisibilityChange);
      // A refresh moments after a scroll must keep the value.
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
