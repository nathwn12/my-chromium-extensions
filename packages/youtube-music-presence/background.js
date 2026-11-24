/**
 * youtube-music-presence — MV3 service worker (module).
 *
 * Music-only, desktop-IPC-only. One tab map, one desired activity and one
 * send budget for YouTube Music (LISTENING) published to the installed Discord
 * desktop app over its local socket: a track change goes out at once, an
 * ordinary update at most once per `MIN_GAP_MS`, and nothing above
 * `MAX_UPDATES` per `UPDATE_WINDOW_MS`. A playback rate that is not 1x keeps
 * the same ceiling but spaces its updates `RATE_INTERVAL_MS` apart, and biases
 * each anchor by half that interval's drift: Discord counts elapsed time in
 * wall time and has no field for the rate.
 *
 * The pure helpers are exported so the test suite can import this file
 * without a `chrome` global; `createWorker` takes the API object, so the tests
 * drive the real listener wiring with a fake chrome. Identity comes from
 * config.js; the payload rules live in activity.js; the status vocabulary in
 * bridge-status.js.
 */

import {
  DEFAULT_CLIENT_ID,
  DEFAULT_TRANSPORT,
  ENABLED_KEY,
  HOST_NAME,
  SOURCE_YOUTUBE_MUSIC,
  resolveEnabled,
  sourceForUrl,
} from "./config.js";
import { buildActivity, clampText, RATE_EPSILON, SAMPLE_SKEW_MS } from "./activity.js";
import {
  AVAILABILITY,
  BRIDGE,
  REASON,
  STATUS_KEY,
  bridgeStatusOf,
  classifyBridgeFailure,
} from "./bridge-status.js";

/** Music is the only source. */
export const SOURCE = SOURCE_YOUTUBE_MUSIC;
export const SOURCES = Object.freeze([SOURCE_YOUTUBE_MUSIC]);

export const MAX_UPDATES = 8;
export const UPDATE_WINDOW_MS = 20000;
/** At most one ordinary update per this gap; a new track bypasses it. */
export const MIN_GAP_MS = 1500;
/**
 * A playback rate that is not 1x is re-anchored once per this interval, under
 * the same 8-per-20 s ceiling that already lands today. The content script
 * still reports every tick — that is cheap and keeps the sample fresh — and the
 * worker decides the cadence. Discord counts elapsed time in wall time and has
 * no field for the rate, so each update also biases its anchor by half this
 * interval's drift (`rateBiasMs`).
 */
export const RATE_INTERVAL_MS = 2500;
/** A tab that has not reported for this long is treated as closed. */
export const TAB_TTL_MS = 30 * 60 * 1000;
/** A ping with no pong inside this window marks the bridge disconnected. */
export const PONG_TIMEOUT_MS = 10000;
export const ALARM_NAME = "ytmp-watchdog";
export const ALARM_PERIOD_MINUTES = 0.5;
export const BACKOFF_MIN_MS = 500;
export const BACKOFF_MAX_MS = 8000;
/** `chrome.storage.session` key holding the tab map across worker suspension. */
export const SESSION_TABS_KEY = "ytmpTabs";

/**
 * Bridge states in which a desired activity may be handed to the host.
 *
 * The native port is ordered and the hello is posted before any activity on it,
 * so the host can accept an activity the moment the worker has said who it is.
 * Waiting for `connected` first deadlocks: the host only connects a source when
 * an activity arrives, so a fresh boot would never become connected at all.
 * `idle` (presence off) and `error` (rejected id, exhausted hang) stay silent.
 */
const SENDABLE_BRIDGE_STATES = new Set([
  BRIDGE.CONNECTED,
  BRIDGE.CONNECTING,
  BRIDGE.WAITING,
]);


/**
 * Paced limiter: at most one ordinary send per `minGapMs`, at most `max` per
 * `windowMs`, newest wins. A pending payload replaces the one before it, so a
 * burst of reports costs one deferred send instead of one per report.
 *
 * `urgent` spends a send ahead of the gap — a new track should not wait 1.5 s —
 * but never past the window ceiling. `force` (reconnect, clear) bypasses both.
 * `rateScaled` spaces ordinary sends `rateMinGapMs` apart for a non-1x playback;
 * the ceiling and window are shared, so only the floor changes.
 * `schedule`/`cancel`/`now` are injectable so tests never need real timers.
 */
export function createCoalescingLimiter({
  send,
  max = MAX_UPDATES,
  windowMs = UPDATE_WINDOW_MS,
  minGapMs = MIN_GAP_MS,
  rateMinGapMs = RATE_INTERVAL_MS,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
}) {
  let sentAt = [];
  let lastSentAt = -Infinity;
  let pending = null;
  let hasPending = false;
  let timer = null;
  let floorMs = minGapMs;

  /** The instant a deferred payload may go: past the gap, and past the window if it is full. */
  function nextSendAt(at) {
    const afterGap = lastSentAt + floorMs;
    if (sentAt.length >= max) return Math.max(afterGap, sentAt[0] + windowMs);
    return afterGap;
  }

  /**
   * Adopt the floor the playback rate calls for. A payload already waiting on
   * the old floor is rescheduled, so a rate change takes effect at once.
   */
  function useFloor(rateScaled) {
    const next = rateScaled ? rateMinGapMs : minGapMs;
    if (next === floorMs) return;
    floorMs = next;
    if (timer !== null && hasPending) {
      cancel(timer);
      const at = now();
      timer = schedule(flush, Math.max(1, nextSendAt(at) - at));
    }
  }

  function emit(payload, at) {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    pending = null;
    hasPending = false;
    sentAt.push(at);
    lastSentAt = at;
    try {
      send(payload);
    } catch {
    }
  }

  function flush() {
    timer = null;
    if (!hasPending) return;
    const at = now();
    sentAt = sentAt.filter((t) => at - t < windowMs);
    if (sentAt.length >= max || at - lastSentAt < floorMs) {
      timer = schedule(flush, Math.max(1, nextSendAt(at) - at));
      return;
    }
    emit(pending, at);
  }

  return {
    push(payload, { urgent = false, force = false, rateScaled = false } = {}) {
      useFloor(rateScaled);
      const at = now();
      pending = payload;
      hasPending = true;
      sentAt = sentAt.filter((t) => at - t < windowMs);
      const gapOpen = at - lastSentAt >= floorMs;
      const room = sentAt.length < max;
      if (force || (room && (gapOpen || urgent))) {
        emit(payload, at);
        return;
      }
      if (timer === null) timer = schedule(flush, Math.max(1, nextSendAt(at) - at));
    },
    /**
     * Drop the deferred payload and its timer, leaving the send history
     * untouched: when the desired state returns to what is already published,
     * anything still queued is stale by definition, and the pacing window must
     * not move because of a payload that was never sent.
     */
    cancelPending() {
      pending = null;
      hasPending = false;
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
    },
    /** Drop the budget history and the deferred payload: a reconnect replays desired state. */
    reset() {
      sentAt = [];
      lastSentAt = -Infinity;
      pending = null;
      hasPending = false;
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
    },
    get pending() {
      return pending;
    },
    get hasPending() {
      return hasPending;
    },
  };
}

/**
 * The lines that name one track — `details`, `state` and the cover tooltip —
 * as one comparable string. A change here is a new song, artist line or album:
 * the only updates worth spending a send on ahead of the pacing gap. Position,
 * pause and timestamps are deliberately absent, so a seek or a pause stays an
 * ordinary update.
 */
function activityIdentity(activity) {
  const line = (value) => (typeof value === "string" && value ? value : null);
  if (!activity || typeof activity !== "object") return JSON.stringify([null, null, null]);
  const assets = activity.assets && typeof activity.assets === "object" ? activity.assets : {};
  return JSON.stringify([line(activity.details), line(activity.state), line(assets.large_text)]);
}

/**
 * The freshest tab: playing beats paused, ties break on the newest report.
 * A tab whose title is not showable never wins.
 */
export function pickBestTab(entries) {
  const list = (Array.isArray(entries) ? entries : [...(entries?.values?.() ?? [])]).filter(
    (entry) => entry && entry.state && clampText(entry.state.title)
  );
  if (!list.length) return null;
  const rank = (entry) => (entry.state.paused === false ? 2 : 1);
  const stamp = (entry) => entry.rankAt ?? entry.at ?? 0;
  list.sort((a, b) => {
    const byRank = rank(b) - rank(a);
    if (byRank !== 0) return byRank;
    return stamp(b) - stamp(a);
  });
  return list[0] ?? null;
}

/**
 * Whether a tab's playback rate is one Discord cannot represent: a finite rate
 * more than `RATE_EPSILON` from 1. A missing or junk rate is 1x for this
 * purpose — it must never change the cadence or the anchor by itself.
 */
export function isRateScaled(state) {
  const rate = state && typeof state === "object" ? state.playbackRate : undefined;
  if (typeof rate !== "number" || !Number.isFinite(rate)) return false;
  return Math.abs(rate - 1) > RATE_EPSILON;
}

/**
 * The anchor offset for a non-1x sample: half the re-anchor interval's drift,
 * subtracted — `-(rate - 1) * (RATE_INTERVAL_MS / 2)`, so -625 ms at 1.5x and
 * +312.5 ms at 0.75x, exactly 0 at 1x. Discord counts elapsed as `now - start`,
 * so an earlier `start` gives back the drift the interval accumulates: the
 * error straddles the truth instead of always lagging. Clamped to half the
 * interval, and never to more than the sample has already played in either
 * direction: at 0:00 the bar reads 0:00, not one biased second ahead or behind.
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
 * The instant a tab's state was sampled: the content script's own `state.at`
 * when it is a finite number, else the moment the worker received it. This is
 * the anchor handed to `buildActivity`, so a rebuild never moves `start`.
 *
 * A stamp more than `SAMPLE_SKEW_MS` ahead of `fallback` is junk, not a
 * sample: returning it would hand `buildActivity` a future `now`, and Discord
 * would render a bar that starts in the future. That case takes `fallback`.
 *
 * `fallback` MUST be a stored instant (the entry's receipt time), never a
 * clock read at call time. With `now()` as the fallback, a rejected stamp
 * would return a value that changes on every rebuild: the anchor would drift
 * forward tick by tick and then jump the moment the stamp became acceptable,
 * which is the very stutter this function exists to prevent. A stored instant
 * makes every rebuild of one sample return the same number.
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

/**
 * Whether the previous worker session published Music presence. Only then is
 * an explicit clear worth sending on startup.
 */
function stalePresenceOf(storedStatus) {
  const activities =
    storedStatus && typeof storedStatus === "object" ? storedStatus.activities : null;
  if (!activities || typeof activities !== "object" || Array.isArray(activities)) return false;
  const entry = activities[SOURCE_YOUTUBE_MUSIC];
  return Boolean(entry) && typeof entry === "object" && !Array.isArray(entry);
}


/**
 * Build the worker around one chrome-like API object. Returns the handlers the
 * caller wires to real listeners, plus the status payload the surfaces read.
 */
export function createWorker({
  chrome: api,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
} = {}) {
  const tabs = new Map();
  let desired = null;
  let hasDesired = false;
  let desiredRateScaled = false;
  /** A fresh worker has not published anything: "null" is already its clear. */
  let lastSent = "null";
  let publishedIdentity = null;
  let limiter = null;

  let sequence = 0;
  let port = null;
  let portDisconnectHandler = null;
  const clientId = DEFAULT_CLIENT_ID;
  const transportPreference = DEFAULT_TRANSPORT;
  let chosenTransport = null;
  let enabled = true;
  let staleMusic = false;
  let bridgeState = BRIDGE.IDLE;
  let availability = AVAILABILITY.UNKNOWN;
  let reason = null;
  let reasonKind = null;
  let detail = null;
  let hostSources = {};
  let hungCount = 0;
  let backoffMs = BACKOFF_MIN_MS;
  let reconnectTimer = null;
  let lastPingAt = 0;
  let lastPongAt = 0;
  let lastPersisted = "";
  let lastTabsJson = "";
  let restorePromise = null;
  let restored = false;
  let tabsReadable = true;


  function status() {
    return {
      bridgeState,
      availability,
      reason,
      reasonKind,
      detail,
      transportPreference,
      transport: chosenTransport,
      activities: { [SOURCE_YOUTUBE_MUSIC]: desired },
      hostSources,
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
    } catch {
    }
    for (const write of writes) {
      if (write && typeof write.catch === "function") write.catch(() => {});
    }
  }

  function setBridge(state, nextDetail = null, extra = {}) {
    bridgeState = state;
    detail = nextDetail;
    if (extra.availability !== undefined) availability = extra.availability;
    if (extra.reason !== undefined) reason = extra.reason;
    if (extra.reasonKind !== undefined) reasonKind = extra.reasonKind;
    persist();
  }

  /** Record one non-fatal failure without ever latching an error. */
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
    for (const [tabId, entry] of tabs) {
      out[tabId] = { state: entry.state, at: entry.at, rankAt: entry.rankAt };
    }
    return { [SOURCE_YOUTUBE_MUSIC]: out };
  }

  /**
   * Mirror the tab map into `storage.session` so an MV3 suspension does not
   * lose desired state. Only a real change writes: the serialised snapshot is
   * the dedupe key.
   */
  function persistTabs() {
    if (!restored || !tabsReadable || !api.storage?.session) return;
    const snapshot = snapshotTabs();
    const json = JSON.stringify(snapshot);
    if (json === lastTabsJson) return;
    lastTabsJson = json;
    try {
      const write = api.storage.session.set({ [SESSION_TABS_KEY]: snapshot });
      if (write && typeof write.catch === "function") write.catch(() => {});
    } catch {
    }
  }

  /**
   * Take what is usable from a stored snapshot and let a fresher live report
   * win on the same tab. Every field is validated because session storage is
   * writable by any code in the extension: a corrupt value is ignored, never
   * thrown. Buckets for any other source are ignored.
   *
   * A snapshot is history, not liveness: the tab may be closed or paused since
   * it was written. Restored entries are marked unconfirmed and are never
   * published until the content script reports the tab again.
   */
  function hydrateTabs(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const bucket = raw[SOURCE_YOUTUBE_MUSIC];
    if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) return false;
    let restoredAny = false;
    for (const [key, entry] of Object.entries(bucket)) {
      const tabId = Number(key);
      if (!Number.isInteger(tabId) || tabId < 0) continue;
      if (!entry || typeof entry !== "object") continue;
      if (!entry.state || typeof entry.state !== "object") continue;
      const at = Number(entry.at);
      if (!Number.isFinite(at) || at <= 0) continue;
      const rankAtRaw = Number(entry.rankAt);
      const rankAt = Number.isFinite(rankAtRaw) ? rankAtRaw : at;
      const existing = tabs.get(tabId);
      if (existing && existing.at >= at) continue;
      tabs.set(tabId, { state: entry.state, at, rankAt, restored: true });
      restoredAny = true;
    }
    return restoredAny;
  }

  function restore() {
    if (restorePromise) return restorePromise;
    restorePromise = (async () => {
      try {
        if (!api.storage?.session) return false;
        const stored = await api.storage.session.get(SESSION_TABS_KEY);
        return hydrateTabs(stored ? stored[SESSION_TABS_KEY] : null);
      } catch {
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
    const disconnectHandler = portDisconnectHandler;
    portDisconnectHandler = null;
    chosenTransport = null;
    try {
      dying.onMessage.removeListener(onNativeMessage);
    } catch {
    }
    try {
      dying.onDisconnect.removeListener(disconnectHandler);
    } catch {
    }
    try {
      dying.disconnect();
    } catch {
    }
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
    if (reconnectTimer !== null || !enabled) return;
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
        setBridge(BRIDGE.CONNECTED, null, {
          availability: AVAILABILITY.AVAILABLE,
          reason: null,
          reasonKind: null,
        });
        if (limiter) limiter.reset();
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
          setBridge(BRIDGE.CONNECTED, null, {
            availability: AVAILABILITY.AVAILABLE,
            reason: null,
            reasonKind: null,
          });
        }
        push(false);
      } else {
        const text =
          typeof message.error === "string" && message.error ? message.error : "activity not delivered";
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
    if (!enabled) {
      setBridge(BRIDGE.IDLE, null, {
        availability: AVAILABILITY.UNKNOWN,
        reason: null,
        reasonKind: null,
      });
      return;
    }
    let fresh;
    try {
      fresh = api.runtime.connectNative(HOST_NAME);
    } catch (error) {
      applyFailure(String((error && error.message) || error));
      scheduleReconnect();
      return;
    }
    port = fresh;
    port.onMessage.addListener(onNativeMessage);
    portDisconnectHandler = () => onPortDisconnect(fresh);
    port.onDisconnect.addListener(portDisconnectHandler);
    setBridge(BRIDGE.CONNECTING, null, {
      availability: AVAILABILITY.UNKNOWN,
      reason: null,
      reasonKind: null,
    });
    post({ t: "hello", clientId, version: 1, transport: transportPreference });
  }


  /**
   * Publish an explicit clear straight down the port and past the send
   * budget: switching presence off must not wait for a limiter window, and
   * closing the socket is not a clear the host is required to send.
   */
  function clearPresence() {
    if (!port) return;
    post({ t: "activity", source: SOURCE_YOUTUBE_MUSIC, id: `${SOURCE_YOUTUBE_MUSIC}:${++sequence}`, activity: null });
  }

  /** Honour the enable toggle: off tears the port down and stays down. */
  function setEnabled(next) {
    enabled = next;
    if (enabled) {
      reconnect();
      return;
    }
    clearPresence();
    if (limiter) limiter.reset();
    if (reconnectTimer !== null) {
      cancel(reconnectTimer);
      reconnectTimer = null;
    }
    dropPort();
    setBridge(BRIDGE.IDLE, null, {
      availability: AVAILABILITY.UNKNOWN,
      reason: null,
      reasonKind: null,
    });
  }


  function deliver(activity) {
    const id = `${SOURCE_YOUTUBE_MUSIC}:${++sequence}`;
    if (post({ t: "activity", source: SOURCE_YOUTUBE_MUSIC, id, activity })) {
      lastSent = JSON.stringify(activity);
      publishedIdentity = activityIdentity(activity);
    }
  }

  function limiterFor() {
    if (!limiter) {
      limiter = createCoalescingLimiter({
        send: (activity) => deliver(activity),
        now,
        schedule,
        cancel,
      });
    }
    return limiter;
  }

  /**
   * Publish the desired activity through its budget. A dead port just leaves
   * the desired value in place: the next port, `connected` status or host
   * reconnect replays it. A bridge that is still connecting or waiting for
   * Discord is a live port and takes the payload: the host needs the activity
   * to connect at all, and it keeps the last one for its own retry.
   *
   * `urgent` is decided by identity in `recompute`, never by the caller: a new
   * track spends a send ahead of the pacing gap, a seek does not.
   */
  function push(force = false, urgent = false) {
    if (!hasDesired) return;
    const json = JSON.stringify(desired);
    if (!force && lastSent === json) {
      if (limiter) limiter.cancelPending();
      return;
    }
    if (!port && reconnectTimer === null) ensurePort();
    if (!port || !SENDABLE_BRIDGE_STATES.has(bridgeState)) return;
    limiterFor().push(desired, { urgent, force, rateScaled: desiredRateScaled });
  }

  function pruneStale(map, at) {
    for (const [tabId, entry] of map) {
      if (at - entry.at > TAB_TTL_MS) map.delete(tabId);
    }
  }

  /**
   * Live presence needs a live report that says playback is running. A restored
   * entry is unconfirmed, and a paused report is not playing: neither may put a
   * card on screen. Both still stay in the map so a later live report can take
   * over the same tab and the watchdog can prune them.
   */
  function playingEntries() {
    return [...tabs.values()].filter(
      (entry) => !entry.restored && entry.state && entry.state.paused === false
    );
  }

  function recompute() {
    pruneStale(tabs, now());
    persistTabs();
    const best = pickBestTab(playingEntries());
    const sample = best ? sampleAt(best, best.at) : 0;
    const bias = best ? rateBiasMs(best.state) : 0;
    const anchor = sample + bias;
    const rateScaled = Boolean(best) && isRateScaled(best.state);
    desired = best
      ? buildActivity(bias ? { ...best.state, at: anchor } : best.state, anchor)
      : null;
    hasDesired = true;
    desiredRateScaled = rateScaled;
    persist();
    push(false, activityIdentity(desired) !== publishedIdentity);
  }

  /** Publish an explicit clear for Music the last session left published. */
  function clearSource() {
    desired = null;
    hasDesired = true;
    persist();
    push(true);
  }


  function handleState(message, sender) {
    if (!api) return;
    const tab = sender && sender.tab;
    if (!tab || tab.id === undefined) return;
    if (sender.id !== api.runtime.id) return;
    if (sender.frameId !== undefined && sender.frameId !== 0) return;
    if (message.source !== SOURCE_YOUTUBE_MUSIC) return;
    const state = message.state;
    if (!state || typeof state !== "object") return;
    const url = typeof state.pageUrl === "string" && state.pageUrl ? state.pageUrl : tab.url;
    if (sourceForUrl(url) !== SOURCE_YOUTUBE_MUSIC) return;

    const at = now();
    tabs.set(tab.id, { state, at, rankAt: at });
    recompute();
  }

  function handleGone(message, sender) {
    if (!api) return;
    const tab = sender && sender.tab;
    if (!tab || tab.id === undefined) return;
    if (sender.id !== api.runtime.id) return;
    if (message.source !== undefined && message.source !== SOURCE_YOUTUBE_MUSIC) {
      tabs.delete(tab.id);
      return;
    }
    if (tabs.delete(tab.id)) recompute();
  }

  function handleTabRemoved(tabId) {
    if (tabs.delete(tabId)) recompute();
  }

  function handleAlarm(alarm) {
    if (!alarm || alarm.name !== ALARM_NAME) return;
    if (!restored) {
      void restore().then(() => handleAlarm(alarm));
      return;
    }
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

  function handleStorageChange(changes, area) {
    if (area !== "local" || !changes) return;
    if (changes[ENABLED_KEY]) {
      const next = resolveEnabled(changes[ENABLED_KEY].newValue);
      if (next !== enabled) setEnabled(next);
    }
  }

  function handleMessage(message, sender, sendResponse) {
    if (!message || typeof message !== "object") return false;
    switch (message.t) {
      case "ytmp-state":
        handleState(message, sender);
        return false;
      case "ytmp-gone":
        handleGone(message, sender);
        return false;
      case "ytmp-get-status":
        if (typeof sendResponse === "function") sendResponse(status());
        return false;
      default:
        return false;
    }
  }


  function reconnect() {
    if (!enabled) return;
    dropPort();
    lastSent = undefined;
    if (limiter) limiter.reset();
    backoffMs = BACKOFF_MIN_MS;
    if (reconnectTimer !== null) {
      cancel(reconnectTimer);
      reconnectTimer = null;
    }
    ensurePort();
    push(true);
  }

  async function loadConfig() {
    let stored = null;
    try {
      stored = await api.storage.local.get([ENABLED_KEY, STATUS_KEY]);
    } catch {
      stored = null;
    }
    enabled = resolveEnabled(stored && stored[ENABLED_KEY]);
    staleMusic = stalePresenceOf(stored && stored[STATUS_KEY]);
  }

  function armWatchdog() {
    if (!api.alarms) return;
    const create = () => {
      try {
        api.alarms.create(ALARM_NAME, {
          periodInMinutes: ALARM_PERIOD_MINUTES,
          delayInMinutes: ALARM_PERIOD_MINUTES,
        });
      } catch {
      }
    };
    try {
      const getter = api.alarms.get;
      if (typeof getter !== "function") {
        create();
        return;
      }
      const probed = getter.call(api.alarms, ALARM_NAME);
      if (probed && typeof probed.then === "function") {
        probed.then((existing) => {
          if (!existing) create();
        }, create);
        return;
      }
      getter.call(api.alarms, ALARM_NAME, (existing) => {
        if (!existing) create();
      });
    } catch {
    }
  }

  async function start() {
    await loadConfig();
    await restore();
    armWatchdog();
    if (enabled) ensurePort();
    if (playingEntries().length) recompute();
    else if (staleMusic) clearSource();
    staleMusic = false;
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
  if (api.tabs?.onRemoved) {
    api.tabs.onRemoved.addListener((tabId) => worker.handleTabRemoved(tabId));
  }
  if (api.alarms?.onAlarm) {
    api.alarms.onAlarm.addListener((alarm) => worker.handleAlarm(alarm));
  }
  if (api.storage?.onChanged) {
    api.storage.onChanged.addListener((changes, area) => worker.handleStorageChange(changes, area));
  }
  return worker;
}

const chromeApi = typeof globalThis.chrome !== "undefined" ? globalThis.chrome : null;

export const hasChrome = Boolean(
  chromeApi && chromeApi.runtime && typeof chromeApi.runtime.connectNative === "function"
);

if (hasChrome) {
  const worker = createWorker({ chrome: chromeApi });
  wire(worker, chromeApi);
  worker.start();
}
