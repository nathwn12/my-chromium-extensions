/**
 * Crunchyroll frame-merge adapter for presence-suite.
 * Ported from crunchy-presence/background.js: Crunchyroll plays inside an
 * iframe, so state is merged per TAB from top-frame metadata and
 * player-frame video truth. Pure helpers only; the worker owns the port.
 */
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

import { HOST_NAME, resolveClientId } from "../../config.js";
import { classifyBridgeFailure } from "../../bridge-status.js";

const ALARM_NAME = "presence-watchdog";
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

const IDENTITY_FIELDS = [
  "series", "episodeTitle", "seasonNumber", "episodeNumber",
  "artworkUrl", "seriesUrl", "episodeUrl"
];

/** Identity a frame actually reports. No shared ID is invented for the player. */
function identityKey(frame) {
  return JSON.stringify(IDENTITY_FIELDS.map((field) => frame[field]));
}

function hasIdentity(frame) {
  return IDENTITY_FIELDS.some((field) => frame[field] !== null && frame[field] !== undefined);
}

/**
 * A same-episode read under half the known length is a different video (the
 * ad/clip ratio `isAdBreak` already uses), not a new length for this episode.
 * Keeping the known length is what stops a collapsed read from rewriting the
 * card's total. A real correction stays near the total, and a new episode
 * resets the latch through its changed identity.
 */
function collapsedDuration(duration, known) {
  return Number.isFinite(known) && known > 0 && duration > 0 && duration * 2 < known;
}

/** Store one frame report on its tab entry (frameId 0 = top frame). */
export function mergeFrame(entry, frame, now = Date.now()) {
  if (!entry) return entry;
  if (!entry.frames) entry.frames = {};
  const knownBefore = entry.knownDuration;
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
    const key = identityKey(stored);
    const changed = entry.lastTopIdentity !== undefined && entry.lastTopIdentity !== key;
    const reportedDuration = Number(stored.duration);
    if (Number.isFinite(reportedDuration) && reportedDuration >= 60) {
      if (changed || !collapsedDuration(reportedDuration, entry.knownDuration)) {
        entry.knownDuration = reportedDuration;
        entry.knownDurationIdentity = key;
      } else {
        // Same episode, a much shorter read: keep the known total on the frame
        // too, so a top frame that owns the video cannot collapse the card.
        stored.duration = entry.knownDuration;
      }
    } else if (changed) {
      // The top moved on without a length; the known length belongs to the
      // episode just left, so a confirming frame may set the new total.
      entry.knownDurationIdentity = undefined;
    } else if (entry.knownDurationIdentity === undefined &&
        Number.isFinite(entry.knownDuration)) {
      // First identity to name a length learned from an identity-less frame.
      entry.knownDurationIdentity = key;
    }
    entry.top = stored;
    entry.lastTopIdentity = key;
    if (changed) {
      if (entry.awaitingTop) entry.awaitingTop = false;
      // A frame carrying its own video is already self-confirmed.
      else if (!stored.hasVideo) entry.awaitingVideo = true;
    }
  } else {
    const prev = entry.frames[stored.frameId];
    const pinned = entry.videoFrameId === 0 ? entry.top : entry.frames[entry.videoFrameId];
    const holdActive = entry.awaitingTop || entry.awaitingVideo;
    entry.frames[stored.frameId] = stored;
    const duration = Number(stored.duration);
    const topHasIdentity = Boolean(entry.top && hasIdentity(entry.top));
    const frameIdentity = hasIdentity(stored) ? identityKey(stored) : null;
    const identityMatch = frameIdentity !== null && topHasIdentity &&
      frameIdentity === entry.lastTopIdentity;
    // The pinned player naming a different episode than the top is conflict.
    // It opens or maintains a hold; it is never release evidence.
    const identityConflict = frameIdentity !== null && topHasIdentity &&
      frameIdentity !== entry.lastTopIdentity && stored.frameId === entry.videoFrameId;
    // A short clip carrying the top's identity is a short episode, not an ad.
    const adLike = !identityMatch && (isAdBreak(stored, knownBefore) ||
      (Number.isFinite(duration) && duration > 0 && duration < 60 &&
        Number.isFinite(knownBefore) && knownBefore > duration));
    const prevChanged = !adLike && prev && (
      identityKey(prev) !== identityKey(stored) ||
      (prev.hasVideo && stored.hasVideo && Number.isFinite(duration) &&
        duration !== Number(prev.duration))
    );
    const durationSignal = !adLike && Number.isFinite(knownBefore) &&
      Number.isFinite(duration) && duration > 0 && duration !== knownBefore;
    // Conflict opens the hold. A new frame with no prior report and no
    // identity cannot open one: that is a late duplicate or an unrelated frame.
    const opensHold = !holdActive && (identityConflict || (!frameIdentity && prevChanged));
    // Only a top change pending for video can be released by video evidence.
    const releasesHold = entry.awaitingVideo &&
      (identityMatch || (!frameIdentity && (prevChanged || durationSignal)));
    // A genuine same-episode replacement advances the pinned timing even
    // when the old frame lingers and receivedAt ties.
    const sameEpisodeAdvance = !holdActive && !prev && stored.hasVideo && pinned &&
      pinned.hasVideo && pinned.frameId !== stored.frameId && !adLike && !frameIdentity &&
      Number.isFinite(knownBefore) && duration === knownBefore &&
      Number.isFinite(stored.position) && Number.isFinite(pinned.position) &&
      stored.position > pinned.position;
    // A collapsed read is a new length only with evidence the episode moved:
    // video confirming a top-first change, or a trusted frame naming the
    // current top under an identity that has not set the length yet. A
    // player-first change stays ambiguous and keeps the known length until the
    // top confirms; that is what the hold is for.
    const collapsed = collapsedDuration(duration, knownBefore);
    const newEpisodeLength = releasesHold ||
      (identityMatch && entry.knownDurationIdentity !== entry.lastTopIdentity);
    if (Number.isFinite(duration) && duration > 0 &&
        (entry.knownDuration === undefined || duration === knownBefore ||
          identityMatch || opensHold || releasesHold) &&
        !(collapsed && !newEpisodeLength)) {
      entry.knownDuration = duration;
      if (identityMatch) entry.knownDurationIdentity = entry.lastTopIdentity;
    } else if (collapsed && identityMatch && duration >= 60) {
      // Same episode, a much shorter read: keep the known total on the frame
      // so the card cannot collapse to it.
      stored.duration = knownBefore;
    }
    if (opensHold) {
      entry.videoFrameId = stored.frameId;
      entry.awaitingTop = true;
    } else if (releasesHold) {
      entry.videoFrameId = stored.frameId;
      entry.awaitingVideo = false;
    } else if (identityMatch || sameEpisodeAdvance) {
      entry.videoFrameId = stored.frameId;
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
  const pinned = entry.videoFrameId === 0
    ? entry.top
    : entry.frames[entry.videoFrameId];
  const videoFrame =
    (pinned && pinned.hasVideo ? pinned : null) ||
    byRecency.find((frame) => frame.hasVideo) ||
    null;

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
 * Apply a presence-gone report to one tab entry. A tab-scoped gone (pagehide)
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
 * delayed clear that any arriving presence-state cancels.
 */
export function isBlindReloadSignal(changeInfo) {
  if (!changeInfo || typeof changeInfo !== "object") return false;
  return changeInfo.status === "loading" || changeInfo.discarded === true;
}


