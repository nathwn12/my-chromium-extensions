/**
 * presence-suite - MV3 service worker (module).
 *
 * One native port, one shared send budget, two independent sources. Tab state
 * is kept per source so a Crunchyroll iframe merge can never overwrite a
 * YouTube Music tab. The status payload carries a per-source activities map and
 * the host's per-source bridge map. Messages are presence-state / presence-gone
 * / presence-get-status - new names that cannot collide with the older
 * single-site extensions' message kinds.
 *
 * Pure helpers are exported so tests can import this file without a chrome
 * global; createWorker takes the API object. Identity comes from config.js,
 * activity rules from activity.js and sources/crunchy/activity.js, status copy
 * from bridge-status.js. A total seen once is cached locally (TOTALS_KEY) and
 * reused on a cold sample so the first card is timed; a live total wins only
 * with ownership evidence, else the remembered one drives the outgoing card.
 */

import {
  DEFAULT_CLIENT_ID,
  DEFAULT_TRANSPORT,
  ENABLED_KEY,
  HOST_NAME,
  SOURCES,
  SOURCE_CRUNCHY,
  SOURCE_YOUTUBE_MUSIC,
  STATUS_KEY,
  TABS_KEY,
  TOTALS_KEY,
  enabledMap,
  resolveEnabled,
  sourceForUrl,
} from "./config.js";
import {
  AVAILABILITY,
  BRIDGE,
  REASON,
  bridgeStatusOf,
  classifyBridgeFailure,
} from "./bridge-status.js";
import {
  RATE_EPSILON,
  SAMPLE_SKEW_MS,
  buildActivity as buildYoutube,
  clampText as clampYoutube,
} from "./activity.js";
import { buildActivity as buildCrunchy } from "./sources/crunchy/activity.js";
import {
  applyGoneToEntry,
  isTrustedFrameUrl,
  mergeFrame,
  pickBestTab as pickCrunchyTab,
  resolveTab,
} from "./sources/crunchy/frame-merge.js";

export const ALARM_NAME = "presence-watchdog";
export const ALARM_PERIOD_MINUTES = 0.5;
export const TAB_TTL_MS = 30 * 60 * 1000;
export const PONG_TIMEOUT_MS = 10000;
export const MAX_UPDATES = 8;
export const UPDATE_WINDOW_MS = 20000;
export const MIN_GAP_MS = 1500;
/** Playback rates off 1x are re-anchored on this cadence. */
export const RATE_INTERVAL_MS = 2500;
/**
 * A playhead this close to the start proves a fresh play. Mirrors the
 * content script's FRESH_POSITION_SECONDS hold-gate evidence.
 */
export const FRESH_POSITION_SECONDS = 2;
/**
 * Cap on remembered totals; least recently remembered entries go first.
 * ~80 bytes per entry x 1000 = ~80 KB against chrome.storage.local's 10 MB
 * quota, so the cap needs no unlimitedStorage permission and stays the bound.
 */
export const TOTALS_MAX_ENTRIES = 1000;
/** A play is a session: a new key, or this much time after the last one. */
export const TOTALS_SESSION_GAP_MS = 10 * 60 * 1000;
/**
 * score = plays * 0.5 ** (ageDays / 90). Relistening beats mere recency, yet an
 * abandoned favourite still decays below current listening.
 */
export const TOTALS_HALF_LIFE_DAYS = 90;
/** At most one local-storage write of the totals map per this interval. */
export const TOTALS_WRITE_INTERVAL_MS = 5000;
export const BACKOFF_MIN_MS = 500;
export const BACKOFF_MAX_MS = 8000;
export const SOURCE_LIST = SOURCES;

/** States in which a desired activity may be handed to the host. */
const SENDABLE = new Set([BRIDGE.CONNECTED, BRIDGE.CONNECTING, BRIDGE.WAITING]);

/**
 * Paced limiter: at most max sends per windowMs, with a minGapMs floor for
 * a caller that does not mark a payload urgent. Newest wins; a pending
 * payload replaces the previous one. urgent skips the gap but never the
 * window cap; force bypasses both so a toggle-off clear goes out at once.
 */
export function createCoalescingLimiter({
  send,
  max = MAX_UPDATES,
  windowMs = UPDATE_WINDOW_MS,
  minGapMs = MIN_GAP_MS,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
}) {
  let sentAt = [];
  let lastSentAt = -Infinity;
  let pending = null;
  let hasPending = false;
  let timer = null;

  function nextSendAt(at) {
    const afterGap = lastSentAt + minGapMs;
    if (sentAt.length >= max) return Math.max(afterGap, sentAt[0] + windowMs);
    return afterGap;
  }

  function emit(payload, at) {
    if (timer !== null) { cancel(timer); timer = null; }
    pending = null;
    hasPending = false;
    sentAt.push(at);
    lastSentAt = at;
    try { send(payload); } catch (_) {}
  }

  function flush() {
    timer = null;
    if (!hasPending) return;
    const at = now();
    sentAt = sentAt.filter((t) => at - t < windowMs);
    if (sentAt.length >= max || at - lastSentAt < minGapMs) {
      timer = schedule(flush, Math.max(1, nextSendAt(at) - at));
      return;
    }
    emit(pending, at);
  }

  return {
    push(payload, { force = false, urgent = false } = {}) {
      const at = now();
      pending = payload;
      hasPending = true;
      sentAt = sentAt.filter((t) => at - t < windowMs);
      const gapOpen = at - lastSentAt >= minGapMs;
      if (force || (sentAt.length < max && (gapOpen || urgent))) {
        emit(payload, at);
        return;
      }
      if (timer === null) timer = schedule(flush, Math.max(1, nextSendAt(at) - at));
    },
    cancelPending() {
      pending = null;
      hasPending = false;
      if (timer !== null) { cancel(timer); timer = null; }
    },
    reset() {
      sentAt = [];
      lastSentAt = -Infinity;
      pending = null;
      hasPending = false;
      if (timer !== null) { cancel(timer); timer = null; }
    },
    get pending() { return pending; },
    get hasPending() { return hasPending; },
  };
}

/** Playing beats paused, newest report wins; unshowable titles never win. */
export function pickBestYoutubeTab(entries) {
  const list = (Array.isArray(entries) ? entries : [...(entries?.values?.() ?? [])]).filter(
    (entry) => entry && entry.state && clampYoutube(entry.state.title)
  );
  if (!list.length) return null;
  const rank = (entry) => (entry.state.paused === false ? 2 : 1);
  const stamp = (entry) => entry.rankAt ?? entry.at ?? 0;
  list.sort((a, b) => (rank(b) - rank(a)) || (stamp(b) - stamp(a)));
  return list[0] || null;
}

/** A ping awaiting its pong past the window means the bridge is hung. */
export function isPongOverdue(lastPingAt, lastPongAt, at, timeoutMs = PONG_TIMEOUT_MS) {
  if (!Number.isFinite(lastPingAt) || lastPingAt <= 0) return false;
  if (Number.isFinite(lastPongAt) && lastPongAt >= lastPingAt) return false;
  return at - lastPingAt >= timeoutMs;
}

/**
 * A finite rate more than RATE_EPSILON from 1. Missing or junk means 1x: an
 * absent field must never change the cadence or the anchor by itself.
 */
export function isRateScaled(state) {
  const rate = state && typeof state === "object" ? state.playbackRate : undefined;
  if (typeof rate !== "number" || !Number.isFinite(rate)) return false;
  return Math.abs(rate - 1) > RATE_EPSILON;
}

/**
 * Anchor offset for a non-1x sample: half a rate interval of drift, negated,
 * so the error straddles the truth instead of always lagging. Discord counts
 * elapsed in wall time and carries no rate. Clamped to half the interval and
 * to what has already played, so a track at 0:00 still reads 0:00.
 */
export function rateBiasMs(state) {
  if (!isRateScaled(state)) return 0;
  const limit = RATE_INTERVAL_MS / 2;
  const bias = Math.max(-limit, Math.min(limit, (1 - state.playbackRate) * limit));
  const position = Number(state.position);
  if (!Number.isFinite(position)) return bias;
  const played = Math.floor(Math.max(0, position)) * 1000;
  return Math.max(-played, Math.min(played, bias));
}

/**
 * The instant a sample was taken: its state.at when finite and no more than
 * SAMPLE_SKEW_MS ahead of the stored receipt fallback, else that fallback. A
 * stored fallback keeps a rejected stamp from drifting with every rebuild; a
 * future stamp would put the card's bar in the future.
 */
export function sampleAt(entry, fallback = 0) {
  if (!entry || typeof entry !== "object") return fallback;
  const sampled = entry.state ? entry.state.at : undefined;
  if (typeof sampled === "number" && Number.isFinite(sampled)) {
    return sampled - fallback <= SAMPLE_SKEW_MS ? sampled : fallback;
  }
  const reported = entry.at;
  if (typeof reported === "number" && Number.isFinite(reported)) return reported;
  return fallback;
}

/** Build the worker around a chrome-like API object. */
export function createWorker({
  chrome: api,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
} = {}) {
  const tabs = new Map(SOURCES.map((source) => [source, new Map()]));
  const enabled = enabledMap(null);
  const desired = {};
  const lastSent = {};
  for (const source of SOURCES) {
    desired[source] = undefined;
    lastSent[source] = "null";
  }

  let port = null;
  let disconnectHandler = null;
  let sequence = 0;
  let limiter = null;
  let bridgeState = BRIDGE.IDLE;
  let availability = AVAILABILITY.UNKNOWN;
  let reason = null;
  let reasonKind = null;
  let detail = null;
  let chosenTransport = null;
  let hostSources = {};
  let hungCount = 0;
  let backoffMs = BACKOFF_MIN_MS;
  let reconnectTimer = null;
  let lastPingAt = 0;
  let lastPongAt = 0;
  let lastPersisted = "";
  let lastTabsJson = "";
  let restorePromise = null;
  const totals = new Map();
  let totalsWriteTimer = null;
  let lastTotalsWriteAt = -Infinity;
  /** Session state is per source; the other source's publishes cannot add plays. */
  const lastRemembered = new Map();
  /** Last published timed sample per source; a changed total mid-play is stale. */
  const lastTimed = new Map();
  let restored = false;
  let tabsReadable = true;

  function status() {
    const activities = {};
    for (const source of SOURCES) activities[source] = desired[source] ?? null;
    return {
      bridgeState,
      availability,
      reason,
      reasonKind,
      detail,
      transportPreference: DEFAULT_TRANSPORT,
      transport: chosenTransport,
      activities,
      hostSources,
      enabled: { ...enabled },
      sources: { ...enabled },
      updatedAt: now(),
    };
  }

  function persist() {
    const payload = status();
    const { updatedAt: _drop, ...stable } = payload;
    const key = JSON.stringify(stable);
    if (key === lastPersisted) return;
    lastPersisted = key;
    const writes = [];
    try {
      if (api.storage?.session) writes.push(api.storage.session.set({ [STATUS_KEY]: payload }));
      if (api.storage?.local) writes.push(api.storage.local.set({ [STATUS_KEY]: payload }));
    } catch (_) {}
    for (const write of writes) if (write && typeof write.catch === "function") write.catch(() => {});
  }

  function setBridge(state, nextDetail = null, extra = {}) {
    bridgeState = state;
    detail = nextDetail;
    if (extra.availability !== undefined) availability = extra.availability;
    if (extra.reason !== undefined) reason = extra.reason;
    if (extra.reasonKind !== undefined) reasonKind = extra.reasonKind;
    persist();
  }

  function applyFailure(text, options = {}) {
    const verdict = classifyBridgeFailure(text, options);
    setBridge(verdict.bridgeState, verdict.detail || text || null, {
      availability: verdict.availability,
      reason: verdict.reason,
      reasonKind: verdict.kind,
    });
    if (verdict.kind === REASON.HUNG) hungCount += 1;
    else hungCount = 0;
    return verdict;
  }

  function snapshotTabs() {
    const out = {};
    for (const source of SOURCES) {
      const bucket = {};
      for (const [tabId, entry] of tabs.get(source)) {
        if (source === SOURCE_CRUNCHY) {
          bucket[tabId] = { entry, at: entry.updatedAt || 0 };
        } else {
          bucket[tabId] = { state: entry.state, at: entry.at, rankAt: entry.rankAt };
        }
      }
      out[source] = bucket;
    }
    return out;
  }

  function persistTabs() {
    if (!restored || !tabsReadable || !api.storage?.session) return;
    const snapshot = snapshotTabs();
    const json = JSON.stringify(snapshot);
    if (json === lastTabsJson) return;
    lastTabsJson = json;
    try {
      const write = api.storage.session.set({ [TABS_KEY]: snapshot });
      if (write && typeof write.catch === "function") write.catch(() => {});
    } catch (_) {}
  }

  function hydrateTabs(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    let restoredAny = false;
    for (const source of SOURCES) {
      const bucket = raw[source];
      if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) continue;
      for (const [key, entry] of Object.entries(bucket)) {
        const tabId = Number(key);
        if (!Number.isInteger(tabId) || tabId < 0 || !entry || typeof entry !== "object") continue;
        const at = Number(entry.at);
        if (!Number.isFinite(at) || at <= 0) continue;
        if (source === SOURCE_CRUNCHY) {
          if (!entry.entry || typeof entry.entry !== "object") continue;
          tabs.get(source).set(tabId, entry.entry);
        } else {
          if (!entry.state || typeof entry.state !== "object") continue;
          const rankAt = Number(entry.rankAt);
          tabs.get(source).set(tabId, {
            state: entry.state,
            at,
            rankAt: Number.isFinite(rankAt) ? rankAt : at,
            restored: true,
          });
        }
        restoredAny = true;
      }
    }
    return restoredAny;
  }

  function restore() {
    if (restorePromise) return restorePromise;
    restorePromise = (async () => {
      try {
        if (!api.storage?.session) return false;
        const stored = await api.storage.session.get(TABS_KEY);
        return hydrateTabs(stored ? stored[TABS_KEY] : null);
      } catch (_) {
        tabsReadable = false;
        return false;
      } finally {
        restored = true;
      }
    })();
    return restorePromise;
  }

  function dropPort() {
    if (!port) return;
    const dying = port;
    port = null;
    const handler = disconnectHandler;
    disconnectHandler = null;
    chosenTransport = null;
    try { dying.onMessage.removeListener(onNativeMessage); } catch (_) {}
    try { dying.onDisconnect.removeListener(handler); } catch (_) {}
    try { dying.disconnect(); } catch (_) {}
  }

  function post(message) {
    if (!port) return false;
    try {
      port.postMessage(message);
      return true;
    } catch (error) {
      detail = String((error && error.message) || error);
      dropPort();
      scheduleReconnect();
      return false;
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer !== null || !SOURCES.some((source) => enabled[source])) return;
    const delay = backoffMs;
    backoffMs = Math.min(BACKOFF_MAX_MS, Math.round(backoffMs * 1.6));
    reconnectTimer = schedule(() => {
      reconnectTimer = null;
      ensurePort();
    }, delay);
  }

  function onNativeMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.t === "status") {
      if (message.sources && typeof message.sources === "object") hostSources = message.sources;
      const next = bridgeStatusOf(
        { bridgeState, lastError: detail, availability, reason, reasonKind, transport: chosenTransport },
        message,
        hungCount
      );
      if (next.transport !== null) chosenTransport = next.transport;
      if (next.bridgeState === BRIDGE.CONNECTED) {
        backoffMs = BACKOFF_MIN_MS;
        hungCount = 0;
        setBridge(BRIDGE.CONNECTED, null, { availability: AVAILABILITY.AVAILABLE, reason: null, reasonKind: null });
        push(true);
      } else {
        setBridge(next.bridgeState, next.lastError, {
          availability: next.availability,
          reason: next.reason,
          reasonKind: next.reasonKind,
        });
      }
      return;
    }
    if (message.t === "ack") {
      if (message.ok) {
        backoffMs = BACKOFF_MIN_MS;
        hungCount = 0;
        if (bridgeState !== BRIDGE.CONNECTED) {
          setBridge(BRIDGE.CONNECTED, null, { availability: AVAILABILITY.AVAILABLE, reason: null, reasonKind: null });
        }
      } else {
        const text = typeof message.error === "string" && message.error ? message.error : "activity not delivered";
        const verdict = classifyBridgeFailure(text, { reason: message.reason });
        setBridge(verdict.bridgeState, text, {
          availability: verdict.availability,
          reason: verdict.reason,
          reasonKind: verdict.kind,
        });
      }
      return;
    }
    if (message.t === "pong") {
      backoffMs = BACKOFF_MIN_MS;
      hungCount = 0;
      lastPongAt = now();
    }
  }

  function onPortDisconnect(owner) {
    if (port !== owner) return;
    const message = api.runtime?.lastError?.message;
    dropPort();
    if (limiter) limiter.cancelPending();
    applyFailure(message || "native host disconnected");
    scheduleReconnect();
  }

  function ensurePort() {
    if (port) return;
    if (!SOURCES.some((source) => enabled[source])) {
      setBridge(BRIDGE.IDLE, null, { availability: AVAILABILITY.UNKNOWN, reason: null, reasonKind: null });
      return;
    }
    try {
      port = api.runtime.connectNative(HOST_NAME);
    } catch (error) {
      applyFailure(String((error && error.message) || error));
      scheduleReconnect();
      return;
    }
    port.onMessage.addListener(onNativeMessage);
    disconnectHandler = () => onPortDisconnect(port);
    port.onDisconnect.addListener(disconnectHandler);
    setBridge(BRIDGE.CONNECTING, null, { availability: AVAILABILITY.UNKNOWN, reason: null, reasonKind: null });
    post({ t: "hello", clientId: DEFAULT_CLIENT_ID, version: 1, transport: DEFAULT_TRANSPORT });
  }

  function push(force = false) {
    if (!port || !SENDABLE.has(bridgeState)) return;
    if (!limiter) {
      limiter = createCoalescingLimiter({
        send: (payload) => {
          const id = payload.source + ":" + (++sequence);
          post({ t: "activity", source: payload.source, id, activity: payload.activity });
        },
        now,
        schedule,
        cancel,
      });
    }
    for (const source of SOURCES) {
      if (desired[source] === undefined) continue;
      const json = JSON.stringify(desired[source]);
      if (!force && json === lastSent[source]) continue;
      limiter.push({ source, activity: desired[source] }, { force, urgent: !force });
      lastSent[source] = json;
    }
  }

  function pruneStale(map, at) {
    for (const [tabId, entry] of map) {
      const stamp = entry.at ?? entry.updatedAt ?? 0;
      if (at - stamp > TAB_TTL_MS) map.delete(tabId);
    }
  }

  /** Only card text is cached; art and links always come from the live page. */
  const CACHED_TEXT_FIELDS = ["title", "channel", "album", "views"];
  const YT_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

  function cachedText(value) {
    if (typeof value !== "string") return null;
    const text = value.replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 256) : null;
  }

  function youtubeIdFromUrl(raw) {
    if (typeof raw !== "string" || !raw) return null;
    try {
      const parsed = new URL(raw);
      if (
        parsed.hostname !== "music.youtube.com" && parsed.hostname !== "www.youtube.com" &&
        parsed.hostname !== "youtube.com"
      ) return null;
      const id = parsed.searchParams.get("v");
      return id && YT_VIDEO_ID.test(id) ? id : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * The page URL and the player-bar track link must name the same video. An
   * SPA can leave the URL on the previous song, and a title names nothing, so
   * neither alone may borrow or persist named fields under a new ID.
   */
  function confirmedYoutubeId(state) {
    if (!state || typeof state !== "object") return null;
    const fromUrl =
      typeof state.mediaId === "string" && YT_VIDEO_ID.test(state.mediaId) ? state.mediaId : null;
    const fromBar = youtubeIdFromUrl(state.trackUrl);
    return fromUrl && fromUrl === fromBar ? fromUrl : null;
  }

  function cachedTextKey(source, state) {
    if (source !== SOURCE_YOUTUBE_MUSIC) return null;
    const id = confirmedYoutubeId(state);
    return id ? source + "|" + id : null;
  }

  /** A cache key needs a source and a stable identity; no identity, no borrow. */
  function totalsKey(source, state) {
    if (!state || typeof state !== "object") return null;
    let identity = null;
    if (source === SOURCE_YOUTUBE_MUSIC) {
      identity = state.mediaId || state.trackUrl;
    } else if (source === SOURCE_CRUNCHY) {
      const composite = state.seriesUrl &&
        state.seasonNumber !== null && state.seasonNumber !== undefined &&
        state.episodeNumber !== null && state.episodeNumber !== undefined
        ? `${state.seriesUrl}|${state.seasonNumber}|${state.episodeNumber}`
        : null;
      identity = state.episodeUrl || composite;
    }
    if (typeof identity !== "string" && typeof identity !== "number") return null;
    const text = String(identity).trim();
    return text ? source + "|" + text : null;
  }

  /** Decayed play count; a missing count is one play, never NaN. */
  function totalScore(entry, at) {
    const plays = Number.isFinite(entry.plays) && entry.plays > 0 ? entry.plays : 1;
    const stamp = Number(entry.at);
    const ageDays = Number.isFinite(stamp)
      ? Math.max(0, (at - stamp) / (24 * 60 * 60 * 1000))
      : 0;
    return plays * Math.pow(0.5, ageDays / TOTALS_HALF_LIFE_DAYS);
  }

  /** Evict the lowest score first; an older `at` breaks ties. */
  function capTotals() {
    if (totals.size <= TOTALS_MAX_ENTRIES) return;
    const at = now();
    const lowestFirst = [...totals.entries()].sort((a, b) => {
      const delta = totalScore(a[1], at) - totalScore(b[1], at);
      return delta !== 0 ? delta : a[1].at - b[1].at;
    });
    for (const [key] of lowestFirst.slice(0, totals.size - TOTALS_MAX_ENTRIES)) totals.delete(key);
  }

  /** Corrupt or absent storage starts empty, the same way loadConfig does. */
  async function loadTotals() {
    let stored = null;
    try {
      stored = await api.storage.local.get([TOTALS_KEY]);
    } catch (_) {
      stored = null;
    }
    const raw = stored && stored[TOTALS_KEY];
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw)) {
        if (typeof key !== "string" || !key || !value || typeof value !== "object") continue;
        const total = Number(value.total);
        const stamp = Number(value.at);
        if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(stamp) || stamp <= 0) continue;
        const plays = Number(value.plays);
        const record = {
          total,
          at: stamp,
          plays: Number.isFinite(plays) && plays > 0 ? plays : 1,
        };
        // Duration-only records stay valid; only card text is ever read back,
        // so a legacy art/link field cannot survive a reload.
        if (key.startsWith(SOURCE_YOUTUBE_MUSIC + "|")) {
          for (const field of CACHED_TEXT_FIELDS) {
            const text = cachedText(value[field]);
            if (text) record[field] = text;
          }
        }
        totals.set(key, record);
      }
    }
    capTotals();
  }

  /** One write at a time; the flushed snapshot is always the current map. */
  function flushTotals() {
    if (totalsWriteTimer !== null) {
      cancel(totalsWriteTimer);
      totalsWriteTimer = null;
    }
    if (!api.storage?.local) return;
    lastTotalsWriteAt = now();
    capTotals();
    const snapshot = {};
    for (const [key, value] of totals) snapshot[key] = value;
    try {
      const write = api.storage.local.set({ [TOTALS_KEY]: snapshot });
      if (write && typeof write.catch === "function") write.catch(() => {});
    } catch (_) {}
  }

  function scheduleTotalsWrite() {
    if (!api.storage?.local || totalsWriteTimer !== null) return;
    const wait = Math.max(0, TOTALS_WRITE_INTERVAL_MS - (now() - lastTotalsWriteAt));
    totalsWriteTimer = schedule(flushTotals, wait);
  }

  function rememberTotal(source, state, total) {
    const value = Number(total);
    if (!Number.isFinite(value) || value <= 0) return;
    const key = totalsKey(source, state);
    if (!key) return;
    const at = now();
    const previous = totals.get(key);
    const last = lastRemembered.get(source);
    const session = !last || last.key !== key || at - last.at > TOTALS_SESSION_GAP_MS;
    const plays = previous ? (session ? previous.plays + 1 : previous.plays) : 1;
    const totalChanged = !previous || Math.abs(previous.total - value) > 0.5;
    const playsChanged = !previous || plays !== previous.plays;
    const record = { total: value, at, plays };
    // Only live text for the exact confirmed ID is written; a cache-filled
    // sample cannot launder the previous song's fields under a new identity.
    if (cachedTextKey(source, state) === key) {
      for (const field of CACHED_TEXT_FIELDS) {
        const live = cachedText(state[field]);
        const old = previous ? cachedText(previous[field]) : null;
        if (live) record[field] = live;
        else if (old) record[field] = old;
      }
    }
    totals.set(key, record);
    lastRemembered.set(source, { key, at });
    capTotals();
    // A new total, or a new play, must survive suspension; a timestamp refresh can wait.
    if (totalChanged || playsChanged) flushTotals();
    else scheduleTotalsWrite();
  }

  /**
   * A changed live total for an identity we already remember is trusted only
   * with ownership evidence. The worker has no media-element source, so a
   * near-zero playhead counts only on a coherent identity with no timed sample
   * yet in this play - a cold start or a genuinely new source. A read taken
   * mid-play fails closed: its total belongs to an outgoing element. A
   * different key has no remembered total and is always accepted. Mirrors the
   * content script's ownsFreshTiming / playheadInside / pendingTiming gates.
   */
  function ownsLiveTotal(source, state, key, cachedTotal, live) {
    if (!(Number.isFinite(live) && live > 0)) return true;
    if (!(Number.isFinite(cachedTotal) && cachedTotal > 0)) return true;
    if (Math.abs(cachedTotal - live) <= 0.5) return true;
    if (lastTimed.get(source) === key) return false;
    const coherent = source === SOURCE_YOUTUBE_MUSIC
      ? Boolean(confirmedYoutubeId(state))
      : Boolean(key);
    if (!coherent) return false;
    const raw = state.position;
    const position = Number(raw);
    const measured = raw !== null && raw !== undefined && raw !== "" && Number.isFinite(position);
    return measured && position >= 0 && position <= FRESH_POSITION_SECONDS;
  }

  /**
   * Decide the outgoing card's total before the builder stamps it. Without
   * ownership evidence the remembered total drives the card and the cache is
   * left untouched; cached text still fills warm cards exactly as before.
   */
  function withGuardedTotals(source, state) {
    if (!state || state.paused !== false) return { state, trusted: true };
    const key = totalsKey(source, state);
    const cached = key ? totals.get(key) : null;
    if (!cached) return { state: withCachedMetadata(source, state), trusted: true };
    const live = Number(state.duration);
    const trusted = ownsLiveTotal(source, state, key, Number(cached.total), live);
    const effective = trusted ? state : { ...state, duration: Number(cached.total) };
    return { state: withCachedMetadata(source, effective), trusted };
  }

  /** Remember the key we just published so a later changed total reads as stale. */
  function markTimed(source, state) {
    lastTimed.set(source, totalsKey(source, state));
  }

  /**
   * A remembered total fills only a missing total; text fills only fields the
   * live read left empty. An owned live value wins, art and links are never
   * borrowed, and no position is ever invented.
   */
  function withCachedMetadata(source, state) {
    if (!state || state.paused !== false) return state;
    const key = totalsKey(source, state);
    const cached = key ? totals.get(key) : null;
    if (!cached) return state;
    const out = { ...state };
    const live = Number(out.duration);
    if (!(Number.isFinite(live) && live > 0) && Number(cached.total) > 0) {
      out.duration = Number(cached.total);
    }
    if (cachedTextKey(source, state) === key) {
      for (const field of CACHED_TEXT_FIELDS) {
        if (!cachedText(out[field])) {
          const text = cachedText(cached[field]);
          if (text) out[field] = text;
        }
      }
    }
    return out;
  }

  function youtubeActivity(entry) {
    const { state, trusted } = withGuardedTotals(SOURCE_YOUTUBE_MUSIC, entry.state);
    const bias = rateBiasMs(state);
    const anchor = sampleAt(entry, entry.at) + bias;
    const activity = buildYoutube(bias ? { ...state, at: anchor } : state, anchor);
    if (activity?.timestamps) {
      markTimed(SOURCE_YOUTUBE_MUSIC, state);
      if (trusted) rememberTotal(SOURCE_YOUTUBE_MUSIC, state, state.duration);
    }
    return activity;
  }

  function crunchyActivity(state, at) {
    const { state: effective, trusted } = withGuardedTotals(SOURCE_CRUNCHY, state);
    const activity = buildCrunchy(effective, at, { synopsis: false });
    if (activity?.timestamps) {
      markTimed(SOURCE_CRUNCHY, effective);
      if (trusted) rememberTotal(SOURCE_CRUNCHY, effective, effective.duration);
    }
    return activity;
  }

  function recompute() {
    const at = now();
    pruneStale(tabs.get(SOURCE_YOUTUBE_MUSIC), at);
    pruneStale(tabs.get(SOURCE_CRUNCHY), at);
    persistTabs();

    // A warm card is eligible only when the exact current ID can fill its
    // title; an arbitrary title or a stale page ID never promotes a tab.
    const youtubeEntries = [...tabs.get(SOURCE_YOUTUBE_MUSIC).values()]
      .filter((entry) => !entry.restored && entry.state && entry.state.paused === false)
      .map((entry) => ({
        ...entry,
        state: withCachedMetadata(SOURCE_YOUTUBE_MUSIC, entry.state),
      }));
    const bestYoutube = pickBestYoutubeTab(youtubeEntries);
    desired[SOURCE_YOUTUBE_MUSIC] = bestYoutube ? youtubeActivity(bestYoutube) : null;

    const crunchyEntries = {};
    for (const [tabId, entry] of tabs.get(SOURCE_CRUNCHY)) crunchyEntries[tabId] = resolveTab(entry, at);
    const bestCrunchy = pickCrunchyTab(crunchyEntries);
    desired[SOURCE_CRUNCHY] = bestCrunchy && bestCrunchy.paused === false && !bestCrunchy.adBreak
      ? crunchyActivity(bestCrunchy, at)
      : null;

    persist();
    push(false);
  }

  function handleYoutubeState(message, sender) {
    if (!api) return;
    const tab = sender && sender.tab;
    if (!tab || tab.id === undefined) return;
    if (sender.id !== api.runtime.id) return;
    if (sender.frameId !== undefined && sender.frameId !== 0) return;
    const state = message.state;
    if (!state || typeof state !== "object") return;
    const url = typeof state.pageUrl === "string" && state.pageUrl ? state.pageUrl : tab.url;
    if (sourceForUrl(url) !== SOURCE_YOUTUBE_MUSIC) return;
    const at = now();
    tabs.get(SOURCE_YOUTUBE_MUSIC).set(tab.id, { state, at, rankAt: at });
    recompute();
  }

  function handleCrunchyState(message, sender) {
    if (!api) return;
    const tab = sender && sender.tab;
    if (!tab || tab.id === undefined) return;
    if (sender.id !== api.runtime.id) return;
    const state = message.state;
    if (!state || typeof state !== "object") return;
    const tabUrl = tab.url || "";
    if (sourceForUrl(tabUrl) !== SOURCE_CRUNCHY) return;
    const carriesData = state.hasVideo === true || [
      "series", "episodeTitle", "seasonNumber", "episodeNumber", "artworkUrl",
      "seriesUrl", "episodeUrl", "synopsis",
    ].some((field) => state[field] !== null && state[field] !== undefined);
    if (!carriesData) return;

    const bucket = tabs.get(SOURCE_CRUNCHY);
    let entry = bucket.get(tab.id);
    if (!entry) {
      entry = { tabId: tab.id, top: null, frames: {}, pageUrl: tabUrl, updatedAt: 0, rankAt: 0 };
      bucket.set(tab.id, entry);
    }
    if (tabUrl) entry.pageUrl = tabUrl;
    const frameId = sender && Number.isFinite(sender.frameId) ? sender.frameId : 0;
    const trusted = frameId === 0 || isTrustedFrameUrl(sender.url, tabUrl);
    mergeFrame(entry, {
      frameId,
      series: trusted ? state.series ?? null : null,
      episodeTitle: trusted ? state.episodeTitle ?? null : null,
      seasonNumber: trusted ? state.seasonNumber ?? null : null,
      episodeNumber: trusted ? state.episodeNumber ?? null : null,
      artworkUrl: trusted ? state.artworkUrl ?? null : null,
      seriesUrl: trusted ? state.seriesUrl ?? null : null,
      episodeUrl: trusted ? state.episodeUrl ?? null : null,
      synopsis: trusted ? state.synopsis ?? null : null,
      duration: state.duration ?? null,
      position: state.position ?? null,
      paused: state.paused ?? null,
      playbackRate: state.playbackRate ?? null,
      hasVideo: state.hasVideo === true,
      visible: state.visible !== false,
      signals: Array.isArray(state.signals) ? state.signals : [],
      keepalive: state.keepalive === true,
      receivedAt: now(),
    });
    recompute();
  }

  function handleState(message, sender) {
    if (message.source === SOURCE_YOUTUBE_MUSIC) return handleYoutubeState(message, sender);
    if (message.source === SOURCE_CRUNCHY) return handleCrunchyState(message, sender);
  }

  function handleGone(message, sender) {
    if (!api) return;
    const tab = sender && sender.tab;
    if (!tab || tab.id === undefined) return;
    const source = message.source;
    if (source === SOURCE_YOUTUBE_MUSIC) {
      if (tabs.get(source).delete(tab.id)) recompute();
      return;
    }
    if (source === SOURCE_CRUNCHY) {
      const bucket = tabs.get(source);
      const entry = bucket.get(tab.id);
      if (!entry) return;
      const frameId = sender && Number.isFinite(sender.frameId) ? sender.frameId : 0;
      const scope = typeof message.scope === "string" ? message.scope : "frame";
      if (applyGoneToEntry(entry, frameId, scope, now()) === "delete") bucket.delete(tab.id);
      recompute();
    }
  }

  function handleTabRemoved(tabId) {
    let changed = false;
    for (const source of SOURCES) if (tabs.get(source).delete(tabId)) changed = true;
    if (changed) recompute();
  }

  function handleAlarm(alarm) {
    if (!alarm || alarm.name !== ALARM_NAME) return;
    if (!restored) { void restore().then(() => handleAlarm(alarm)); return; }
    if (!port) {
      ensurePort();
    } else if (bridgeState === BRIDGE.CONNECTED) {
      if (isPongOverdue(lastPingAt, lastPongAt, now())) {
        dropPort();
        applyFailure("native host pong timeout", { retries: hungCount + 1 });
        scheduleReconnect();
      } else if (post({ t: "ping" })) {
        lastPingAt = now();
      }
    }
    recompute();
  }

  function setEnabled(source, next) {
    if (enabled[source] === next) return;
    enabled[source] = next;
    if (!next) {
      desired[source] = null;
      lastSent[source] = "null";
      push(true);
    } else {
      recompute();
    }
    persist();
  }

  function handleStorageChange(changes, area) {
    if (area !== "local" || !changes) return;
    if (changes[ENABLED_KEY]) {
      const map = changes[ENABLED_KEY].newValue;
      for (const source of SOURCES) {
        const next = resolveEnabled(map, source);
        if (next !== enabled[source]) setEnabled(source, next);
      }
    }
  }

  function handleMessage(message, sender, sendResponse) {
    if (!message || typeof message !== "object") return false;
    switch (message.t) {
      case "presence-state":
        handleState(message, sender);
        return false;
      case "presence-gone":
        handleGone(message, sender);
        return false;
      case "presence-get-status":
        if (typeof sendResponse === "function") sendResponse(status());
        return false;
      default:
        return false;
    }
  }

  async function loadConfig() {
    let stored = null;
    try {
      stored = await api.storage.local.get([ENABLED_KEY]);
    } catch (_) {
      stored = null;
    }
    const map = stored && stored[ENABLED_KEY];
    for (const source of SOURCES) enabled[source] = resolveEnabled(map, source);
  }

  function armWatchdog() {
    if (!api.alarms) return;
    const create = () => {
      try {
        api.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES, delayInMinutes: ALARM_PERIOD_MINUTES });
      } catch (_) {}
    };
    try {
      const getter = api.alarms.get;
      if (typeof getter !== "function") { create(); return; }
      const probed = getter.call(api.alarms, ALARM_NAME);
      if (probed && typeof probed.then === "function") {
        probed.then((existing) => { if (!existing) create(); }, create);
        return;
      }
      getter.call(api.alarms, ALARM_NAME, (existing) => { if (!existing) create(); });
    } catch (_) {}
  }

  async function start() {
    await loadConfig();
    await loadTotals();
    await restore();
    armWatchdog();
    if (SOURCES.some((source) => enabled[source])) ensurePort();
    recompute();
  }

  return {
    status,
    start,
    handleMessage,
    handleState,
    handleGone,
    handleTabRemoved,
    handleAlarm,
    handleStorageChange,
  };
}

/** Register the worker's handlers on a chrome-like API object. */
export function wire(worker, api) {
  api.runtime.onMessage.addListener((message, sender, sendResponse) =>
    worker.handleMessage(message, sender, sendResponse)
  );
  if (api.tabs?.onRemoved) api.tabs.onRemoved.addListener((tabId) => worker.handleTabRemoved(tabId));
  if (api.alarms?.onAlarm) api.alarms.onAlarm.addListener((alarm) => worker.handleAlarm(alarm));
  if (api.storage?.onChanged) api.storage.onChanged.addListener((changes, area) => worker.handleStorageChange(changes, area));
  return worker;
}

const chromeApi = typeof globalThis.chrome !== "undefined" ? globalThis.chrome : null;
export const hasChrome = Boolean(chromeApi && chromeApi.runtime && typeof chromeApi.runtime.connectNative === "function");

if (hasChrome) {
  const worker = createWorker({ chrome: chromeApi });
  wire(worker, chromeApi);
  worker.start();
}
