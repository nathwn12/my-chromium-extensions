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


/** Collapse whitespace, drop empties and single chars, hard-cap at 128 characters. */
export function clampText(value, max = MAX_TEXT) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
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

/** Identity a frame actually reports. No shared ID is invented for the player. */
function identityKey(frame) {
  return JSON.stringify([
    frame.series, frame.episodeTitle, frame.seasonNumber, frame.episodeNumber,
    frame.artworkUrl, frame.seriesUrl, frame.episodeUrl
  ]);
}

/** Store one frame report on its tab entry (frameId 0 = top frame). */
export function mergeFrame(entry, frame, now = Date.now()) {
  if (!entry) return entry;
  if (!entry.frames) entry.frames = {};
  const reportedDuration = Number(frame.duration);
  if (Number.isFinite(reportedDuration) && reportedDuration >= 60) {
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
  // A hold releases only on changed evidence from the other source. A
  // duplicate or keepalive from the old episode confirms nothing.
  if (stored.frameId === 0) {
    entry.top = stored;
    const key = identityKey(stored);
    const changed = entry.lastTopIdentity !== undefined && entry.lastTopIdentity !== key;
    entry.lastTopIdentity = key;
    if (changed) {
      if (entry.awaitingTop) entry.awaitingTop = false;
      // A frame carrying its own video is already self-confirmed.
      else if (!stored.hasVideo) entry.awaitingVideo = true;
    }
  } else {
    const prev = entry.frames[stored.frameId];
    entry.frames[stored.frameId] = stored;
    const duration = Number(stored.duration);
    const identityChanged = prev && identityKey(prev) !== identityKey(stored);
    const episodeVideo =
      prev && prev.hasVideo && stored.hasVideo &&
      Number.isFinite(duration) && Number(prev.duration) !== duration &&
      !isAdBreak(stored, entry.knownDuration);
    // An ad or a same-episode seek carries no new episode evidence.
    if (identityChanged || episodeVideo) {
      if (entry.awaitingVideo) entry.awaitingVideo = false;
      else entry.awaitingTop = true;
    }
  }
  entry.updatedAt = Math.max(entry.updatedAt || 0, stored.receivedAt);
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
  // One source changed episode and the other has not confirmed it. Publishing
  // now would join one episode's identity to another episode's timing.
  if (entry.awaitingTop || entry.awaitingVideo) return null;

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
    if (top && top[field] !== null && top[field] !== undefined) return top[field];
    return null;
  };

  const resolved = {
    tabId: entry.tabId ?? null,
    pageUrl: entry.pageUrl ?? null,
    hasVideo: Boolean(videoFrame),
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
  let lastHadTimestamps = null;

  function markSent(payload) {
    if (payload === null || payload === undefined) lastHadTimestamps = false;
    else lastHadTimestamps = Boolean(payload.timestamps);
  }

  function sendBypass(payload) {
    try {
      send(payload);
    } catch {
    }
    markSent(payload);
  }

  /** Drop any deferred payload and its timer before an immediate send. */
  function cancelPending() {
    pending = null;
    hasPending = false;
    if (timer) {
      try {
        clearTimeout(timer);
      } catch {
      }
      timer = null;
    }
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
    }
    markSent(payload);
  }

  return {
    push(payload) {
      if (payload === null) {
        // A timestamped payload can only be pending after a live card. A clear
        // that follows one is a pause: drop it before sending the null.
        if (lastHadTimestamps === true) cancelPending();
        sendBypass(payload);
        return;
      }
      const had = Boolean(payload && payload.timestamps);
      if (lastHadTimestamps !== null && had !== lastHadTimestamps) {
        cancelPending();
        sendBypass(payload);
        return;
      }
      pending = payload;
      hasPending = true;
      if (!timer) flush();
    },
    clear() {
      cancelPending();
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


if (hasChrome) {

  const tabStates = new Map();
  let port = null;
  let backoffMs = BACKOFF_MIN_MS;
  let reconnectTimer = null;
  let clientId = null;
  let enabled = true;
  let synopsisEnabled = false; // the existing option is opt-in: default off
  let bridgeState = "idle";
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
  let seenState = false;
  const bootAt = Date.now();
  const pendingNoUrlClears = new Map();
  let stashedActivity = null;
  let hasStashed = false;
  let lastPersistedJson = "";
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


  function dropPort() {
    if (!port) return;
    try {
      port.onMessage.removeListener(onNativeMessage);
      port.onDisconnect.removeListener(onPortDisconnect);
    } catch {
    }
    try {
      port.disconnect();
    } catch {
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
        const next = applyAckResult({ bridgeState, lastError }, message);
        lastError = next.lastError;
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


  function sendActivity(activity) {
    if (!enabled && activity !== null) return;
    if (!port) ensurePort();
    if (!port) {
      stashedActivity = activity;
      hasStashed = true;
      return;
    }
    if (activity !== null && bridgeState !== "connected") {
      stashedActivity = activity;
      hasStashed = true;
      return;
    }
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
      if (!resolved) {
        // A handoff hold must keep its frames so the other source can confirm.
        if (!entry.top && !Object.keys(entry.frames || {}).length) tabStates.delete(tabId);
        continue;
      }
      out[tabId] = resolved;
    }
    return out;
  }

  function recompute() {
    const best = pickBestTab(resolvedTabs());
    if (best && best.adBreak) {
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
      // Only live playback publishes. A paused or unknown tab clears our own
      // presence through the same null-activity path as idle and tab close.
      desiredActivity = best && best.paused === false
        ? buildActivity(best, Date.now(), { synopsis: synopsisEnabled })
        : null;
    }
    lastActivity = desiredActivity;
    persist();
    pushActivity(false);
  }

  function pushActivity(force) {
    if (!enabled) {
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
    if (applyGoneToEntry(entry, frameId, scope) === "delete") tabStates.delete(tab.id);
    recompute();
  }


  function armWatchdog() {
    if (!chromeApi.alarms) return;
    const create = () => {
      try {
        chromeApi.alarms.create(ALARM_NAME, {
          periodInMinutes: ALARM_PERIOD_MINUTES,
          delayInMinutes: ALARM_PERIOD_MINUTES
        });
      } catch {
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
      getter.call(chromeApi.alarms, ALARM_NAME, (existing) => {
        if (!existing) create();
      });
    } catch {
    }
  }

  async function loadConfig() {
    try {
      const stored = await chromeApi.storage.local.get(["clientId", "enabled", "synopsis"]);
      clientId = resolveClientId(stored.clientId);
      enabled = stored.enabled !== false;
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
        const activity = buildActivity(sample, Date.now(), { synopsis: synopsisEnabled });
        if (bridgeState === "connected" && port) {
          limiter.push(activity);
          if (!limiter.hasPending) lastSentJson = JSON.stringify(activity);
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
        if (isPongOverdue(lastPingAt, lastPongAt, Date.now())) {
          dropPort();
          applyFailure("native host pong timeout", { retries: hungCount + 1 });
          scheduleReconnect();
        } else if (post({ t: "ping" })) {
          if (lastPingAt === 0 || (lastPongAt >= lastPingAt && lastPongAt !== 0)) {
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
        if (!isCrunchyrollPageUrl(url) && tabStates.delete(tabId)) recompute();
        return;
      }
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
