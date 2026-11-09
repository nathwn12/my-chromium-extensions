/**
 * Crunchy Presence — MV3 service worker (module).
 *
 * The pure helpers at the top are exported so the test suite can import this
 * file without a `chrome` global; everything that touches the extension APIs
 * sits behind `hasChrome`. Identity comes from config.js, the single copy of
 * the built-in application ID.
 *
 * Crunchyroll plays inside an iframe on static.crunchyroll.com: the top frame
 * carries the series/episode metadata and the watch URL, the player iframe
 * carries the <video>. State is therefore merged per TAB, never per frame.
 */

import { HOST_NAME, resolveClientId } from "./config.js";
import { classifyBridgeFailure } from "./bridge-status.js";

const ALARM_NAME = "crp-watchdog";
const ALARM_PERIOD_MINUTES = 0.5; // 30s watchdog
const MAX_UPDATES = 4;
const UPDATE_WINDOW_MS = 20000;
const MAX_TEXT = 128;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 8000;

export const FRAME_TTL_MS = 120000;
export const METADATA_FIELDS = [
  "series",
  "episodeTitle",
  "seasonNumber",
  "episodeNumber",
  "artworkUrl",
  "seriesUrl",
  "episodeUrl",
  "synopsis"
];
const VIDEO_FIELDS = ["duration", "position", "paused", "playbackRate"];

const chromeApi = typeof globalThis.chrome !== "undefined" ? globalThis.chrome : null;
export const hasChrome = Boolean(
  chromeApi && chromeApi.runtime && typeof chromeApi.runtime.connectNative === "function"
);

/* ================================================================ pure ==== */

/** Collapse whitespace, drop empties and single chars, hard-cap at 128 characters. */
export function clampText(value, max = MAX_TEXT) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  // Discord requires details/state to be 2-128 chars: a single char is
  // invalid, so fall back instead of sending it.
  if (!text || text.length < 2) return null;
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Fit text into `max` characters: cut at the last sentence end, else the last
 * space, strip a dangling separator and append "…" only when text was cut.
 */
export function smartTruncate(value, max = MAX_TEXT) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length <= max) return text;

  const body = text.slice(0, max);
  let end = -1;
  for (const mark of [". ", "! ", "? "]) {
    const at = body.lastIndexOf(mark);
    if (at > end) end = at;
  }
  if (end >= 0) {
    end += 1; // keep the punctuation, drop the space
  } else {
    const space = body.lastIndexOf(" ");
    end = space > 0 ? space : Math.max(1, max - 1);
  }
  const cut = body.slice(0, end).replace(/[\s·,]+$/, "");
  return `${cut || body.slice(0, max - 1).trim()}…`;
}

/** Seconds -> "m:ss" (or "h:mm:ss" past an hour). */
export function clock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** "S1 E5 · 12:34 / 24:00" when the numbers exist, otherwise "Crunchyroll". */
export function formatStateLine(state) {
  if (!state) return "Crunchyroll";
  const season = Number.isFinite(Number(state.seasonNumber)) && state.seasonNumber !== null
    ? Number(state.seasonNumber)
    : null;
  const episode = Number.isFinite(Number(state.episodeNumber)) && state.episodeNumber !== null
    ? Number(state.episodeNumber)
    : null;

  let base = null;
  if (season !== null && episode !== null) base = `S${season} E${episode}`;
  else if (episode !== null) base = `E${episode}`;
  else return "Crunchyroll";

  const duration = Number(state.duration);
  const position = Number(state.position);
  if (Number.isFinite(duration) && duration > 0) {
    base += ` · ${clock(Number.isFinite(position) ? position : 0)} / ${clock(duration)}`;
  }
  return clampText(base) || "Crunchyroll";
}

function httpsUrl(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Only an https Crunchyroll watch page may become a Discord button. */
export function pickButtonUrl(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    if (!/(^|\.)crunchyroll\.com$/i.test(url.hostname)) return null;
    const out = url.toString();
    // Discord rejects button URLs over 512 chars: reject so the caller
    // falls back to the next candidate instead of sending an invalid card.
    if (out.length > 512) return null;
    return out;
  } catch {
    return null;
  }
}

/** Discord SET_ACTIVITY payload for one merged tab state, or null. */
export function buildActivity(state, now = Date.now(), options = {}) {
  if (!state) return null;

  const season =
    Number.isFinite(Number(state.seasonNumber)) && state.seasonNumber !== null
      ? Number(state.seasonNumber)
      : null;
  const episode =
    Number.isFinite(Number(state.episodeNumber)) && state.episodeNumber !== null
      ? Number(state.episodeNumber)
      : null;

  // The synopsis is opt-in: an absent option means off, so a spoiler never
  // appears without the user asking for it.
  const synopsis = options.synopsis === true ? smartTruncate(state.synopsis) : null;
  let details;
  let stateLine;
  if (synopsis) {
    details = clampText(state.series);
    if (details && season !== null && episode !== null) {
      details = clampText(`${details} · S${season} E${episode}`);
    }
    if (!details) details = clampText(state.episodeTitle);
    stateLine = synopsis;
  } else {
    details = clampText(state.series) || clampText(state.episodeTitle);
    stateLine = formatStateLine(state);
  }
  if (!details) return null;

  const activity = {
    type: 3, // WATCHING
    details,
    state: stateLine
  };

  const artwork = pickButtonUrl(state.artworkUrl);
  const largeText = clampText(state.episodeTitle) || clampText(state.series);
  if (artwork) {
    activity.assets = { large_image: artwork };
    if (largeText) activity.assets.large_text = largeText;
  }

  // Episode link first, then series link; pageUrl is only the phase-1 fallback
  // when neither direct link was extracted.
  const seriesUrl = pickButtonUrl(state.seriesUrl);
  let episodeUrl = pickButtonUrl(state.episodeUrl);
  if (!episodeUrl && !seriesUrl) episodeUrl = pickButtonUrl(state.pageUrl);
  const buttons = [];
  if (episodeUrl) {
    const label = seriesUrl ? "Watch Episode" : "Watch on Crunchyroll";
    buttons.push({ label: clampText(label, 32), url: episodeUrl });
  }
  if (seriesUrl) buttons.push({ label: clampText("View Series", 32), url: seriesUrl });
  if (buttons.length) activity.buttons = buttons.slice(0, 2);

  const position = Number(state.position);
  const duration = Number(state.duration);
  if (state.paused === false && Number.isFinite(duration) && duration > 0) {
    // Stable per reported second: flooring both the wall clock and the
    // position keeps start/end identical across 1 Hz reports while the
    // position second is unchanged, so the worker dedupe can fire. A
    // playing position advances in lockstep with the clock, so start stays
    // fixed instead of jittering on sub-second fractions.
    const atSec =
      Number.isFinite(position) && position >= 0 ? Math.floor(position) : 0;
    const baseSec = Math.floor(now / 1000) * 1000;
    const durationSec = Math.floor(duration);
    activity.timestamps = {
      start: Math.round(baseSec - atSec * 1000),
      end: Math.round(baseSec + Math.max(0, durationSec - atSec) * 1000)
    };
  }

  return activity;
}

/**
 * True when a playing video looks like an ad break: it is under a minute long
 * and less than half the episode length this tab has already reported. A short
 * episode or a missing prior duration never triggers it (safe false negative).
 */
export function isAdBreak(video, knownDuration) {
  if (!video || video.paused !== false) return false;
  const duration = Number(video.duration);
  const known = Number(knownDuration);
  if (!Number.isFinite(duration) || duration <= 0 || duration >= 60) return false;
  return Number.isFinite(known) && known >= 120 && duration * 2 < known;
}

/** A tab counts only while it has a video and is either playing or on screen. */
export function isEligible(tab) {
  if (!tab || tab.hasVideo === false) return false;
  return tab.paused === false || tab.visible !== false;
}

/** Playing beats paused; ties break on the last real playback event.
 * A 30 s keepalive refreshes liveness (receivedAt/updatedAt) but never
 * re-ranks: only a non-keepalive report advances `rankAt`. */
export function pickBestTab(tabs) {
  const list = Object.values(tabs || {}).filter(isEligible);
  if (!list.length) return null;
  const rank = (tab) => (tab.paused === false ? 2 : 1);
  const stamp = (tab) => tab.rankAt ?? tab.updatedAt ?? 0;
  list.sort((a, b) => {
    const byRank = rank(b) - rank(a);
    if (byRank !== 0) return byRank;
    return stamp(b) - stamp(a);
  });
  return list[0] || null;
}

/** Drop frames that stopped reporting more than 120s ago. */
export function pruneFrames(entry, now = Date.now()) {
  if (!entry) return entry;
  if (entry.top && now - entry.top.receivedAt > FRAME_TTL_MS) entry.top = null;
  const frames = entry.frames || {};
  for (const key of Object.keys(frames)) {
    if (now - frames[key].receivedAt > FRAME_TTL_MS) delete frames[key];
  }
  return entry;
}

/** Store one frame report on its tab entry (frameId 0 = top frame). */
export function mergeFrame(entry, frame, now = Date.now()) {
  if (!entry) return entry;
  if (!entry.frames) entry.frames = {};
  const reportedDuration = Number(frame.duration);
  if (Number.isFinite(reportedDuration) && reportedDuration >= 60) {
    // Remember the episode length; a later short-duration video is an ad.
    entry.knownDuration = reportedDuration;
  }
  const stored = {
    frameId: Number.isFinite(frame.frameId) ? frame.frameId : 0,
    series: frame.series ?? null,
    episodeTitle: frame.episodeTitle ?? null,
    seasonNumber: frame.seasonNumber ?? null,
    episodeNumber: frame.episodeNumber ?? null,
    artworkUrl: frame.artworkUrl ?? null,
    seriesUrl: frame.seriesUrl ?? null,
    episodeUrl: frame.episodeUrl ?? null,
    synopsis: frame.synopsis ?? null,
    duration: frame.duration ?? null,
    position: frame.position ?? null,
    paused: typeof frame.paused === "boolean" ? frame.paused : null,
    playbackRate: frame.playbackRate ?? null,
    hasVideo: frame.hasVideo === true,
    visible: frame.visible !== false,
    signals: Array.isArray(frame.signals) ? frame.signals : [],
    receivedAt: Number.isFinite(frame.receivedAt) ? frame.receivedAt : now
  };
  if (stored.frameId === 0) entry.top = stored;
  else entry.frames[stored.frameId] = stored;
  entry.updatedAt = Math.max(entry.updatedAt || 0, stored.receivedAt);
  // A keepalive keeps frames alive for pruning but must never re-rank the
  // winner: only a real playback event advances rankAt.
  if (frame.keepalive !== true) {
    entry.rankAt = Math.max(entry.rankAt || 0, stored.receivedAt);
  } else if (entry.rankAt === undefined) {
    entry.rankAt = entry.rankAt || 0;
  }
  pruneFrames(entry, now);
  return entry;
}

/**
 * Merge a tab's frames into one state.
 * Video truth comes from the newest frame that has a video; every metadata
 * field prefers the top frame, then any frame that actually carries it.
 */
export function resolveTab(entry, now = Date.now()) {
  if (!entry) return null;
  pruneFrames(entry, now);

  const frames = [];
  if (entry.top) frames.push(entry.top);
  for (const frame of Object.values(entry.frames || {})) frames.push(frame);
  if (!frames.length) return null;

  const top = frames.find((frame) => frame.frameId === 0) || null;
  const byRecency = frames
    .slice()
    .sort((a, b) => b.receivedAt - a.receivedAt || a.frameId - b.frameId);
  const videoFrame = byRecency.find((frame) => frame.hasVideo) || null;

  const pick = (field) => {
    // Metadata is trusted from the top frame only: any subdomain iframe
    // could otherwise forge the card via the old any-frame fallback. Video
    // truth still comes from the newest video frame below.
    if (top && top[field] !== null && top[field] !== undefined) return top[field];
    return null;
  };

  const resolved = {
    tabId: entry.tabId ?? null,
    pageUrl: entry.pageUrl ?? null,
    hasVideo: Boolean(videoFrame),
    // Smallest reliable ad signal: a playing video much shorter than the
    // episode length this tab already reported. The card is frozen (no
    // advancing timer) for the break instead of showing the ad as playback.
    adBreak: isAdBreak(videoFrame, entry.knownDuration),
    visible: top ? top.visible !== false : byRecency[0].visible !== false,
    signals: [...new Set(frames.flatMap((frame) => frame.signals))],
    updatedAt: entry.updatedAt || 0,
    rankAt: entry.rankAt ?? entry.updatedAt ?? 0
  };
  for (const field of METADATA_FIELDS) resolved[field] = pick(field);
  for (const field of VIDEO_FIELDS) resolved[field] = videoFrame ? videoFrame[field] : null;
  return resolved;
}

/**
 * Rolling-window limiter: at most `max` ordinary sends per `windowMs`,
 * newest wins. A null clear bypasses the bucket entirely — it is sent
 * immediately and never counted — so at most `max` ordinary sends plus
 * clears share a window (Discord allows 5/20 s; the worker sends at most
 * 4 ordinary). A pause/resume transition (timestamps appear or vanish)
 * bypasses the same way: a pause must not wait ~20 s while Discord
 * animates a live bar past the pause point. `schedule` is injectable so
 * tests never need real timers.
 */
export function createCoalescingLimiter({
  send,
  max = MAX_UPDATES,
  windowMs = UPDATE_WINDOW_MS,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms)
}) {
  let sentAt = [];
  let pending = null;
  let hasPending = false;
  let timer = null;
  // Timestamps presence of the last payload that actually sent: true while
  // playing, false while paused/cleared, null before the first send.
  let lastHadTimestamps = null;

  function markSent(payload) {
    if (payload === null || payload === undefined) lastHadTimestamps = false;
    else lastHadTimestamps = Boolean(payload.timestamps);
  }

  function sendBypass(payload) {
    try {
      send(payload);
    } catch {
      /* a dead port is handled by the port's own disconnect path */
    }
    markSent(payload);
  }

  function flush() {
    timer = null;
    if (!hasPending) return;
    const at = now();
    sentAt = sentAt.filter((t) => at - t < windowMs);
    if (sentAt.length >= max) {
      timer = schedule(flush, Math.max(1, windowMs - (at - sentAt[0]) + 1));
      return;
    }
    const payload = pending;
    pending = null;
    hasPending = false;
    sentAt.push(at);
    try {
      send(payload);
    } catch {
      /* a dead port is handled by the port's own disconnect path */
    }
    markSent(payload);
  }

  return {
    push(payload) {
      if (payload === null) {
        // A clear never waits behind an ordinary update and never spends the
        // budget: bypass the bucket, keep any deferred ordinary payload for
        // its own window.
        sendBypass(payload);
        return;
      }
      const had = Boolean(payload && payload.timestamps);
      if (lastHadTimestamps !== null && had !== lastHadTimestamps) {
        // Pause/resume transition: send immediately without spending the
        // budget and drop any stale deferred ordinary payload it supersedes.
        pending = null;
        hasPending = false;
        if (timer) {
          try {
            clearTimeout(timer);
          } catch {
            /* timer already fired */
          }
          timer = null;
        }
        sendBypass(payload);
        return;
      }
      pending = payload;
      hasPending = true;
      if (!timer) flush();
    },
    clear() {
      pending = null;
      hasPending = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    /** Drop the rolling-window history so a reconnect republishes immediately. */
    resetWindow() {
      sentAt = [];
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (hasPending) flush();
    },
    get pending() {
      return pending;
    },
    get hasPending() {
      return hasPending;
    }
  };
}

/**
 * Pure status classifier used by the worker and its tests.
 *
 * Returns the next `{ bridgeState, lastError, availability, reason, reasonKind }`
 * from one native `status` frame. Absence is neutral: `no discord ipc pipe
 * found` becomes `waiting` with friendly copy, while the raw diagnostic stays
 * in `lastError` for the options diagnostics. Only a fatal host rejection is
 * allowed to become `error`.
 */
export const STATUS_DEFAULT = Object.freeze({
  bridgeState: "idle",
  lastError: null,
  availability: "unknown",
  reason: null,
  reasonKind: null
});

export function bridgeStatusOf(current, message, retries = 0) {
  const base = { ...STATUS_DEFAULT, ...(current || {}) };
  if (!message || message.t !== "status") return base;

  if (message.state === "connected") {
    return {
      ...base,
      bridgeState: "connected",
      lastError: null,
      availability: "available",
      reason: null,
      reasonKind: null
    };
  }

  if (message.state === "waiting" || message.state === "disconnected") {
    const verdict = classifyBridgeFailure(message.detail, { reason: message.reason });
    return {
      ...base,
      bridgeState: verdict.bridgeState,
      lastError: message.detail || verdict.detail || null,
      availability: verdict.availability,
      reason: verdict.reason,
      reasonKind: verdict.kind
    };
  }

  if (message.state === "error") {
    // The host marks every non-permanent failure `fatal: false`; never promote
    // one to an error just because its diagnostic text matched a pattern.
    const verdict =
      message.fatal === false
        ? {
            ...classifyBridgeFailure(message.detail, {
              reason: message.reason ?? "hung"
            }),
            bridgeState: "waiting",
            error: null,
            fatal: false,
            retryable: true
          }
        : classifyBridgeFailure(message.detail, {
            retries,
            fatal: message.fatal === true
          });
    return {
      ...base,
      bridgeState: verdict.bridgeState,
      lastError: message.detail || verdict.detail || null,
      availability: verdict.availability,
      reason: verdict.reason,
      reasonKind: verdict.kind
    };
  }

  if (message.state === "connecting") {
    return {
      ...base,
      bridgeState: "connecting",
      availability: "unknown",
      reason: null,
      reasonKind: null
    };
  }

  return { ...base, bridgeState: String(message.state || "unknown") };
}

/**
 * Pure ack classifier: ok:true connects, ok:false only records lastError and
 * never latches the bridge to "error" — a slow connect acks "not connected"
 * while the handshake is still in flight, which must not look like a rejection.
 */
export function applyAckResult(current, ack) {
  if (ack && ack.ok) return { bridgeState: "connected", lastError: current.lastError ?? null };
  const detail =
    ack && typeof ack.error === "string" && ack.error ? ack.error : "Discord rejected the activity";
  return { bridgeState: current.bridgeState, lastError: detail };
}

/** True while the URL is an https Crunchyroll page; used to drop tab state on navigate-away. */
export function isCrunchyrollPageUrl(raw) {
  if (typeof raw !== "string" || !raw) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    return /(^|\.)crunchyroll\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

/**
 * True while a non-top frame URL may contribute state: an https Crunchyroll
 * watch page on the same origin as the tab. Any other subdomain frame is
 * untrusted for card metadata (video truth still merges, metadata does not).
 */
export function isTrustedFrameUrl(frameUrl, tabUrl) {
  try {
    if (typeof frameUrl !== "string" || typeof tabUrl !== "string") return false;
    const frame = new URL(frameUrl);
    const tab = new URL(tabUrl);
    if (frame.protocol !== "https:" || tab.protocol !== "https:") return false;
    if (frame.origin !== tab.origin) return false;
    if (!/(^|\.)crunchyroll\.com$/i.test(frame.hostname)) return false;
    return /\/watch\/[A-Z0-9]+/i.test(frame.pathname + frame.search + frame.hash);
  } catch {
    return false;
  }
}

/**
 * Apply a crp-gone report to one tab entry. A tab-scoped gone (pagehide)
 * deletes the whole tab; a frame-scoped gone (SPA URL change, quiet iframe)
 * drops just that frame so a still-playing iframe survives a top-frame URL
 * change. Never bumps updatedAt for a gone frame. Returns "delete" when the
 * caller should drop the tab entry, otherwise the mutated entry.
 */
export function applyGoneToEntry(entry, frameId, scope = "frame", now = Date.now()) {
  if (!entry) return "delete";
  if (scope === "tab") return "delete";
  if (frameId === 0) entry.top = null;
  else if (entry.frames) delete entry.frames[frameId];
  pruneFrames(entry, now);
  const frames = [];
  if (entry.top) frames.push(entry.top);
  for (const frame of Object.values(entry.frames || {})) frames.push(frame);
  if (!frames.length) return "delete";
  return entry;
}

/** Bounded ack-retry delays: 1 s, 2 s, 4 s, then the watchdog recovers. */
export const ACK_RETRY_DELAYS = Object.freeze([1000, 2000, 4000]);

/** Delay for the nth consecutive ack rejection (0-based), or null to stop. */
export function nextAckRetryDelay(attempt) {
  return Number.isInteger(attempt) && attempt >= 0 && attempt < ACK_RETRY_DELAYS.length
    ? ACK_RETRY_DELAYS[attempt]
    : null;
}

/** Null publishes are suppressed this long after boot until state arrives. */
export const BOOT_SUPPRESS_MS = 60000;

/** A ping with no pong inside this window marks the bridge disconnected. */
export const PONG_TIMEOUT_MS = 10000;

/**
 * True when a ping is still awaiting its pong past the bounded window: the
 * host is hung and the bridge must be marked disconnected so the normal
 * reconnect path runs. Pure so tests can prove the timeout without timers.
 */
export function isPongOverdue(lastPingAt, lastPongAt, now = Date.now(), timeoutMs = PONG_TIMEOUT_MS) {
  if (!Number.isFinite(lastPingAt) || lastPingAt <= 0) return false;
  if (Number.isFinite(lastPongAt) && lastPongAt >= lastPingAt) return false;
  return now - lastPingAt >= timeoutMs;
}

/** Delayed clear for a tab navigation the worker cannot see a URL for. */
export const NO_URL_CLEAR_DELAY_MS = 1500;

/**
 * True while a tabs.onUpdated signal carries no usable URL but looks like a
 * navigation (loading status or discarded tab). The worker cannot read the
 * URL — it is gated without the tabs permission — so the caller schedules a
 * delayed clear that any arriving crp-state cancels.
 */
export function isBlindReloadSignal(changeInfo) {
  if (!changeInfo || typeof changeInfo !== "object") return false;
  return changeInfo.status === "loading" || changeInfo.discarded === true;
}

/* =========================================================== runtime ====== */

if (hasChrome) {
  /* ------------------------------------------------------------- state -- */

  const tabStates = new Map();
  let port = null;
  let backoffMs = BACKOFF_MIN_MS;
  let reconnectTimer = null;
  let clientId = null;
  let enabled = true;
  let synopsisEnabled = false; // the existing option is opt-in: default off
  let bridgeState = "idle";
  // Availability is a second axis: presence may be enabled while Discord is
  // simply not running. `reason` is friendly copy; `lastError` stays raw.
  let availability = "unknown";
  let reason = null;
  let reasonKind = null;
  let hungCount = 0;
  let appName = null;
  let lastError = null;
  let lastActivity = null;
  let lastExtract = null;
  let lastSentJson = "";
  let lastSent = null;
  let desiredActivity;
  let ackRetryCount = 0;
  let ackRetryTimer = null;
  // A restart must not blank a live presence before any tab has reported.
  let seenState = false;
  const bootAt = Date.now();
  // Delayed clears for navigations whose URL the worker cannot see.
  const pendingNoUrlClears = new Map();
  // Last payload that could not be sent while the bridge was offline (null
  // included — it carries the same flag so a clear is never swallowed).
  let stashedActivity = null;
  let hasStashed = false;
  // Dedupe for storage writes: recompute runs on every report and every 30 s
  // alarm tick, so identical payloads (including disabled idle ticks) skip.
  let lastPersistedJson = "";
  // Hung-host detection: the last ping/pong wall-clock times. A ping with
  // no pong inside PONG_TIMEOUT_MS marks the bridge disconnected.
  let lastPingAt = 0;
  let lastPongAt = 0;

  const limiter = createCoalescingLimiter({
    send: (activity) => sendActivity(activity)
  });

  function flushStashed() {
    if (!hasStashed) return;
    if (!port || bridgeState !== "connected") return;
    const payload = stashedActivity;
    hasStashed = false;
    stashedActivity = null;
    limiter.push(payload);
  }

  function statusPayload() {
    return {
      bridgeState,
      availability,
      reason,
      reasonKind,
      appName,
      // Raw diagnostic for logs and the options diagnostics text; the UI never
      // renders this string directly.
      lastError,
      lastActivity,
      lastSent,
      clientIdPresent: Boolean(clientId),
      enabled,
      updatedAt: Date.now()
    };
  }

  function persist() {
    const status = statusPayload();
    // updatedAt changes every call, so it is excluded from the dedupe key:
    // idle ticks with the same bridge/activity/enabled state write nothing.
    const { updatedAt: _drop, ...stable } = status;
    const key = JSON.stringify([stable, lastExtract]);
    if (key === lastPersistedJson) return;
    lastPersistedJson = key;
    const writes = [];
    try {
      if (chromeApi.storage && chromeApi.storage.session) {
        writes.push(chromeApi.storage.session.set({ crpStatus: status, crpLastExtract: lastExtract }));
      }
      if (chromeApi.storage && chromeApi.storage.local) {
        writes.push(chromeApi.storage.local.set({ crpStatus: status }));
      }
    } catch {
      /* storage may be unavailable during shutdown */
    }
    for (const write of writes) {
      if (write && typeof write.catch === "function") write.catch(() => {});
    }
  }

  function setBridge(state, error = null, extra = {}) {
    bridgeState = state;
    lastError = error;
    if (extra.availability !== undefined) availability = extra.availability;
    if (extra.reason !== undefined) reason = extra.reason;
    if (extra.reasonKind !== undefined) reasonKind = extra.reasonKind;
    persist();
  }

  /** Record one non-fatal failure without ever latching an error. */
  function applyFailure(detail, options = {}) {
    const verdict = classifyBridgeFailure(detail, options);
    setBridge(verdict.bridgeState, verdict.detail || detail || null, {
      availability: verdict.availability,
      reason: verdict.reason,
      reasonKind: verdict.kind
    });
    if (verdict.kind === "hung") hungCount += 1;
    else hungCount = 0;
    return verdict;
  }

  /* -------------------------------------------------------------- port -- */

  function dropPort() {
    if (!port) return;
    try {
      port.onMessage.removeListener(onNativeMessage);
      port.onDisconnect.removeListener(onPortDisconnect);
    } catch {
      /* already torn down */
    }
    try {
      port.disconnect();
    } catch {
      /* already disconnected */
    }
    port = null;
  }

  function post(message) {
    if (!port) return false;
    try {
      port.postMessage(message);
      return true;
    } catch (error) {
      lastError = String((error && error.message) || error);
      dropPort();
      scheduleReconnect();
      return false;
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer || !clientId) return;
    const delay = backoffMs;
    backoffMs = Math.min(BACKOFF_MAX_MS, Math.round(backoffMs * 1.6));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      ensurePort();
    }, delay);
  }

  function onNativeMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.t === "status") {
      const next = bridgeStatusOf(
        { bridgeState, lastError, availability, reason, reasonKind },
        message,
        hungCount
      );
      if (next.bridgeState === "connected") {
        backoffMs = BACKOFF_MIN_MS;
        hungCount = 0;
        appName = message.appName || appName;
      }
      setBridge(next.bridgeState, next.lastError, {
        availability: next.availability,
        reason: next.reason,
        reasonKind: next.reasonKind
      });
      if (next.bridgeState === "connected") {
        // Discord appeared (or returned): replay the latest payload with no
        // user action, resetting the coalescing window first.
        flushStashed();
        pushActivity(true);
      }
      return;
    }
    if (message.t === "ack") {
      if (message.ok) {
        backoffMs = BACKOFF_MIN_MS;
        hungCount = 0;
        ackRetryCount = 0;
        if (ackRetryTimer) {
          clearTimeout(ackRetryTimer);
          ackRetryTimer = null;
        }
        if (message.appName) appName = message.appName;
        if (bridgeState !== "connected") {
          setBridge("connected", null, {
            availability: "available",
            reason: null,
            reasonKind: null
          });
        } else persist();
        flushStashed();
      } else {
        // Record the rejection without latching the bridge to "error": a
        // slow connect acks "not connected" while the handshake is in flight.
        const next = applyAckResult({ bridgeState, lastError }, message);
        lastError = next.lastError;
        // The rejected payload was recorded as sent, so an identical
        // keepalive would never retry: reset the dedupe and re-push with
        // bounded backoff, then leave the watchdog to recover.
        lastSentJson = "";
        persist();
        if (ackRetryTimer) {
          clearTimeout(ackRetryTimer);
          ackRetryTimer = null;
        }
        const delay = nextAckRetryDelay(ackRetryCount);
        if (delay !== null) {
          ackRetryCount += 1;
          ackRetryTimer = setTimeout(() => {
            ackRetryTimer = null;
            pushActivity(true);
          }, delay);
        }
      }
      return;
    }
    if (message.t === "pong") {
      backoffMs = BACKOFF_MIN_MS;
      hungCount = 0;
      lastPongAt = Date.now();
      return;
    }
  }

  function onPortDisconnect() {
    const message = chromeApi.runtime.lastError && chromeApi.runtime.lastError.message;
    dropPort();
    applyFailure(message || "native host disconnected");
    scheduleReconnect();
  }

  function ensurePort() {
    if (!enabled) return;
    if (!clientId) {
      setBridge("idle");
      return;
    }
    if (port) return;
    let fresh;
    try {
      fresh = chromeApi.runtime.connectNative(HOST_NAME);
    } catch (error) {
      // A sync throw is the host-missing/forbidden path on some Chrome builds:
      // neutral waiting with installer guidance, never a red error.
      applyFailure(String((error && error.message) || error));
      scheduleReconnect();
      return;
    }
    port = fresh;
    port.onMessage.addListener(onNativeMessage);
    port.onDisconnect.addListener(onPortDisconnect);
    setBridge("connecting", null, {
      availability: "unknown",
      reason: null,
      reasonKind: null
    });
    post({ t: "hello", clientId });
  }

  /* ---------------------------------------------------------- activity -- */

  function sendActivity(activity) {
    // A null clear must still go through while disabled so turning presence
    // off actually clears Discord; ordinary payloads stay gated.
    if (!enabled && activity !== null) return;
    if (!port) ensurePort();
    if (!port) {
      // Keep the last payload (null included) and replay it on the next
      // status/ack instead of dropping it while offline.
      stashedActivity = activity;
      hasStashed = true;
      return;
    }
    if (activity !== null && bridgeState !== "connected") {
      stashedActivity = activity;
      hasStashed = true;
      return;
    }
    // A clear is authoritative even while Discord is absent: the host keeps
    // it and will not republish the previous episode when Discord appears.
    const json = JSON.stringify(activity);
    if (json === lastSentJson) return;
    if (post({ t: "activity", activity })) {
      lastSentJson = json;
      lastSent = activity;
    } else {
      stashedActivity = activity;
      hasStashed = true;
    }
  }

  function resolvedTabs(now = Date.now()) {
    const out = {};
    for (const [tabId, entry] of [...tabStates]) {
      const resolved = resolveTab(entry, now);
      if (!resolved) tabStates.delete(tabId);
      else out[tabId] = resolved;
    }
    return out;
  }

  function recompute() {
    const best = pickBestTab(resolvedTabs());
    if (best && best.adBreak) {
      // Freeze the last episode card: keep the title, drop the timer so the
      // ad's short duration never renders as an advancing episode bar.
      if (lastActivity) {
        desiredActivity = { ...lastActivity };
        delete desiredActivity.timestamps;
      } else {
        desiredActivity = buildActivity(
          { ...best, paused: true, duration: null, position: null },
          Date.now(),
          { synopsis: synopsisEnabled }
        );
      }
    } else {
      desiredActivity = best
        ? buildActivity(best, Date.now(), { synopsis: synopsisEnabled })
        : null;
    }
    lastActivity = desiredActivity;
    persist();
    pushActivity(false);
  }

  function pushActivity(force) {
    if (!enabled) {
      // Send the clear once on the enabled->disabled transition, then stay
      // silent. The clear goes out even while the bridge is waiting: the host
      // remembers it and will not republish a stale episode when Discord
      // returns. Turning presence off is never blocked by Discord's absence.
      if (lastSentJson !== "null") {
        if (port) {
          limiter.push(null);
          lastSentJson = "null";
        } else {
          stashedActivity = null;
          hasStashed = true;
        }
      }
      return;
    }
    if (desiredActivity === undefined) return;
    // A restart must not blank a live presence before any tab has reported:
    // suppress the boot-time null until the first crp-state or 60 s after
    // boot, after which a closed site still clears.
    if (desiredActivity === null && !seenState && Date.now() - bootAt < BOOT_SUPPRESS_MS) return;
    if (!port) ensurePort();
    if (bridgeState !== "connected") {
      stashedActivity = desiredActivity;
      hasStashed = true;
      return;
    }
    const json = JSON.stringify(desiredActivity);
    if (!force && json === lastSentJson) return;
    limiter.push(desiredActivity);
  }

  /* ------------------------------------------------------------- tabs --- */

  function entryFor(tab) {
    let entry = tabStates.get(tab.id);
    if (!entry) {
      entry = { tabId: tab.id, top: null, frames: {}, pageUrl: tab.url || null, updatedAt: 0, rankAt: 0 };
      tabStates.set(tab.id, entry);
    }
    if (tab.url) entry.pageUrl = tab.url;
    return entry;
  }

  function frameIdOf(sender) {
    return sender && Number.isFinite(sender.frameId) ? sender.frameId : 0;
  }

  function handleState(message, sender) {
    const tab = sender && sender.tab;
    if (!tab || tab.id === undefined) return;
    // Only our own content scripts may report: the sender id must match and
    // the frame or tab URL must be an https Crunchyroll page.
    if (!sender || sender.id !== chromeApi.runtime.id) return;
    if (!isCrunchyrollPageUrl(sender.url) && !isCrunchyrollPageUrl(tab.url)) return;
    seenState = true;
    cancelNoUrlClear(tab.id);
    const carriesData =
      message.hasVideo === true ||
      METADATA_FIELDS.some((field) => message[field] !== null && message[field] !== undefined);
    if (!carriesData) return;

    const entry = entryFor(tab);
    const frameId = frameIdOf(sender);
    // Card metadata is trusted from the top frame, or from a frame whose
    // URL is a watch page on the same origin. Any other frame (for example
    // a compromised subdomain iframe) contributes video truth only.
    const trustedMetadata =
      frameId === 0 || isTrustedFrameUrl(sender.url, tab.url) || isTrustedFrameUrl(sender.url, entry.pageUrl);
    mergeFrame(entry, {
      frameId,
      series: trustedMetadata ? (message.series ?? null) : null,
      episodeTitle: trustedMetadata ? (message.episodeTitle ?? null) : null,
      seasonNumber: trustedMetadata ? (message.seasonNumber ?? null) : null,
      episodeNumber: trustedMetadata ? (message.episodeNumber ?? null) : null,
      artworkUrl: trustedMetadata ? (message.artworkUrl ?? null) : null,
      seriesUrl: trustedMetadata ? (message.seriesUrl ?? null) : null,
      episodeUrl: trustedMetadata ? (message.episodeUrl ?? null) : null,
      synopsis: trustedMetadata ? (message.synopsis ?? null) : null,
      duration: message.duration ?? null,
      position: message.position ?? null,
      paused: message.paused ?? null,
      playbackRate: message.playbackRate ?? null,
      hasVideo: message.hasVideo === true,
      visible: message.visible !== false,
      signals: Array.isArray(message.signals) ? message.signals : [],
      keepalive: message.keepalive === true
    });

    lastExtract = {
      series: message.series ?? null,
      episodeTitle: message.episodeTitle ?? null,
      seasonNumber: message.seasonNumber ?? null,
      episodeNumber: message.episodeNumber ?? null,
      artworkUrl: message.artworkUrl ?? null,
      seriesUrl: message.seriesUrl ?? null,
      episodeUrl: message.episodeUrl ?? null,
      synopsis: message.synopsis ?? null,
      duration: message.duration ?? null,
      position: message.position ?? null,
      paused: message.paused ?? null,
      playbackRate: message.playbackRate ?? null,
      signals: Array.isArray(message.signals) ? message.signals : [],
      pageUrl: tab.url || null,
      frameId: frameIdOf(sender)
    };
    recompute();
  }

  function scheduleNoUrlClear(tabId) {
    if (pendingNoUrlClears.has(tabId)) return;
    if (!tabStates.has(tabId)) return;
    pendingNoUrlClears.set(
      tabId,
      setTimeout(() => {
        pendingNoUrlClears.delete(tabId);
        if (tabStates.delete(tabId)) recompute();
      }, NO_URL_CLEAR_DELAY_MS)
    );
  }

  function cancelNoUrlClear(tabId) {
    const timer = pendingNoUrlClears.get(tabId);
    if (timer === undefined) return;
    clearTimeout(timer);
    pendingNoUrlClears.delete(tabId);
  }

  function handleGone(message, sender) {
    const tab = sender && sender.tab;
    if (!tab || tab.id === undefined) return;
    cancelNoUrlClear(tab.id);
    const entry = tabStates.get(tab.id);
    if (!entry) return;
    const frameId = frameIdOf(sender);
    const scope = message && typeof message.scope === "string" ? message.scope : undefined;
    // Tab scope (pagehide) deletes the whole entry; frame scope (SPA URL
    // change) drops just that frame so a still-playing iframe survives.
    if (applyGoneToEntry(entry, frameId, scope) === "delete") tabStates.delete(tab.id);
    recompute();
  }

  /* ------------------------------------------------------------ boot ---- */

  function armWatchdog() {
    if (!chromeApi.alarms) return;
    const create = () => {
      try {
        chromeApi.alarms.create(ALARM_NAME, {
          periodInMinutes: ALARM_PERIOD_MINUTES,
          delayInMinutes: ALARM_PERIOD_MINUTES
        });
      } catch {
        /* permission revoked mid-session */
      }
    };
    try {
      const getter = chromeApi.alarms.get;
      if (typeof getter !== "function") {
        create();
        return;
      }
      const probed = getter.call(chromeApi.alarms, ALARM_NAME);
      if (probed && typeof probed.then === "function") {
        probed.then((existing) => {
          if (!existing) create();
        }, create);
        return;
      }
      // Callback-style get: only create when no alarm exists yet, so a
      // reboot never resets the watchdog countdown.
      getter.call(chromeApi.alarms, ALARM_NAME, (existing) => {
        if (!existing) create();
      });
    } catch {
      /* permission revoked mid-session */
    }
  }

  async function loadConfig() {
    try {
      const stored = await chromeApi.storage.local.get(["clientId", "enabled", "synopsis"]);
      clientId = resolveClientId(stored.clientId);
      enabled = stored.enabled !== false;
      // Opt-in: only an explicit `true` shows the synopsis.
      synopsisEnabled = stored.synopsis === true;
    } catch {
      clientId = resolveClientId(null);
      enabled = true;
      synopsisEnabled = false;
    }
  }

  function reconnect() {
    dropPort();
    lastSentJson = "";
    hasStashed = false;
    stashedActivity = null;
    limiter.resetWindow();
    backoffMs = BACKOFF_MIN_MS;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    ensurePort();
    pushActivity(true);
  }

  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== "object") return false;
    switch (message.kind) {
      case "crp-state":
        handleState(message, sender);
        return false;
      case "crp-gone":
        handleGone(message, sender);
        return false;
      case "crp-get-status":
        sendResponse(statusPayload());
        return false;
      case "crp-refresh":
        loadConfig().then(() => {
          reconnect();
          recompute();
          sendResponse(statusPayload());
        });
        return true;
      case "crp-test-presence": {
        const best = pickBestTab(resolvedTabs());
        const sample = best || {
          series: "Crunchyroll",
          episodeTitle: "Test presence",
          seasonNumber: 1,
          episodeNumber: 1,
          position: 754,
          duration: 1440,
          paused: false,
          hasVideo: true,
          pageUrl: "https://www.crunchyroll.com/watch/G6VU774M5/test-presence"
        };
        ensurePort();
        const activity = buildActivity(sample);
        if (bridgeState === "connected" && port) {
          limiter.push(activity);
          lastSentJson = JSON.stringify(activity);
        }
        sendResponse({
          queued: bridgeState === "connected",
          bridgeState,
          availability,
          reason,
          reasonKind,
          activity
        });
        return false;
      }
      default:
        return false;
    }
  });

  if (chromeApi.alarms && chromeApi.alarms.onAlarm) {
    chromeApi.alarms.onAlarm.addListener((alarm) => {
      if (!alarm || alarm.name !== ALARM_NAME) return;
      if (!port) ensurePort();
      else if (bridgeState === "connected") {
        // A hung host keeps the port open but never pongs: a ping with no
        // pong inside the bounded window marks the bridge disconnected and
        // runs the normal reconnect instead of staying "connected" forever.
        if (isPongOverdue(lastPingAt, lastPongAt, Date.now())) {
          dropPort();
          // A hung host is transient; only an exhausted run is worth the
          // user's attention. Every clean pong/ack resets the counter.
          applyFailure("native host pong timeout", { retries: hungCount + 1 });
          scheduleReconnect();
        } else if (post({ t: "ping" })) {
          if (lastPingAt === 0 || (lastPongAt >= lastPingAt && lastPongAt !== 0)) {
            // Fresh ping; the next tick proves the pong arrived.
          }
          lastPingAt = Date.now();
        }
      }
      recompute();
    });
  }

  if (chromeApi.tabs && chromeApi.tabs.onRemoved) {
    chromeApi.tabs.onRemoved.addListener((tabId) => {
      cancelNoUrlClear(tabId);
      if (tabStates.delete(tabId)) recompute();
    });
  }

  if (chromeApi.tabs && chromeApi.tabs.onUpdated) {
    chromeApi.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      const url =
        (changeInfo && typeof changeInfo.url === "string" && changeInfo.url) ||
        (tab && typeof tab.url === "string" && tab.url) ||
        null;
      if (typeof url === "string" && url) {
        // A same-tab navigation away from Crunchyroll deletes the entry
        // immediately so presence clears within one watchdog tick.
        if (!isCrunchyrollPageUrl(url) && tabStates.delete(tabId)) recompute();
        return;
      }
      // No usable URL (it is gated without the tabs permission): a loading
      // or discarded signal may be a navigation away, so schedule a delayed
      // clear that any arriving crp-state cancels. A Crunchyroll reload
      // reports state within the window and never blanks.
      if (isBlindReloadSignal(changeInfo)) scheduleNoUrlClear(tabId);
    });
  }

  if (chromeApi.storage && chromeApi.storage.onChanged) {
    chromeApi.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.clientId) {
        clientId = resolveClientId(changes.clientId.newValue);
        reconnect();
      }
      if (changes.enabled) {
        enabled = changes.enabled.newValue !== false;
        if (enabled) reconnect();
        else if (lastSentJson !== "null") {
          limiter.push(null);
          lastSentJson = "null";
        }
      }
      if (changes.synopsis) {
        synopsisEnabled = changes.synopsis.newValue === true;
        recompute();
      }
    });
  }

  if (chromeApi.runtime.onInstalled) chromeApi.runtime.onInstalled.addListener(() => armWatchdog());

  (async () => {
    await loadConfig();
    armWatchdog();
    ensurePort();
    recompute();
  })();
}
