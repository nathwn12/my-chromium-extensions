/**
 * Crunchyroll Discord Presence — MV3 service worker (module).
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

const ALARM_NAME = "crp-watchdog";
const ALARM_PERIOD_MINUTES = 0.5; // 30s watchdog
const MAX_UPDATES = 4;
const UPDATE_WINDOW_MS = 20000;
const MAX_TEXT = 128;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 8000;

export const FRAME_TTL_MS = 120000;
export const METADATA_FIELDS = ["series", "episodeTitle", "seasonNumber", "episodeNumber", "artworkUrl"];
const VIDEO_FIELDS = ["duration", "position", "paused", "playbackRate"];

const chromeApi = typeof globalThis.chrome !== "undefined" ? globalThis.chrome : null;
export const hasChrome = Boolean(
  chromeApi && chromeApi.runtime && typeof chromeApi.runtime.connectNative === "function"
);

/* ================================================================ pure ==== */

/** Collapse whitespace, drop empties, hard-cap at 128 characters. */
export function clampText(value, max = MAX_TEXT) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
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
    return url.toString();
  } catch {
    return null;
  }
}

/** Discord SET_ACTIVITY payload for one merged tab state, or null. */
export function buildActivity(state, now = Date.now()) {
  if (!state) return null;

  const details = clampText(state.series) || clampText(state.episodeTitle);
  if (!details) return null;

  const activity = {
    type: 3, // WATCHING
    details,
    state: formatStateLine(state)
  };

  const artwork = httpsUrl(state.artworkUrl);
  const largeText = clampText(state.episodeTitle) || clampText(state.series);
  if (artwork) {
    activity.assets = { large_image: artwork };
    if (largeText) activity.assets.large_text = largeText;
  }

  const buttonUrl = pickButtonUrl(state.pageUrl);
  if (buttonUrl) {
    activity.buttons = [{ label: "Watch on Crunchyroll", url: buttonUrl }];
  }

  const position = Number(state.position);
  const duration = Number(state.duration);
  if (state.paused === false && Number.isFinite(duration) && duration > 0) {
    const at = Number.isFinite(position) && position >= 0 ? position : 0;
    activity.timestamps = {
      start: Math.round(now - at * 1000),
      end: Math.round(now + Math.max(0, duration - at) * 1000)
    };
  }

  return activity;
}

/** A tab counts only while it has a video and is either playing or on screen. */
export function isEligible(tab) {
  if (!tab || tab.hasVideo === false) return false;
  return tab.paused === false || tab.visible !== false;
}

/** Playing beats paused; ties break on the most recently updated tab. */
export function pickBestTab(tabs) {
  const list = Object.values(tabs || {}).filter(isEligible);
  if (!list.length) return null;
  const rank = (tab) => (tab.paused === false ? 2 : 1);
  list.sort((a, b) => {
    const byRank = rank(b) - rank(a);
    if (byRank !== 0) return byRank;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
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
  const stored = {
    frameId: Number.isFinite(frame.frameId) ? frame.frameId : 0,
    series: frame.series ?? null,
    episodeTitle: frame.episodeTitle ?? null,
    seasonNumber: frame.seasonNumber ?? null,
    episodeNumber: frame.episodeNumber ?? null,
    artworkUrl: frame.artworkUrl ?? null,
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
    if (top && top[field] !== null) return top[field];
    for (const frame of byRecency) if (frame[field] !== null) return frame[field];
    return null;
  };

  const resolved = {
    tabId: entry.tabId ?? null,
    pageUrl: entry.pageUrl ?? null,
    hasVideo: Boolean(videoFrame),
    visible: top ? top.visible !== false : byRecency[0].visible !== false,
    signals: [...new Set(frames.flatMap((frame) => frame.signals))],
    updatedAt: entry.updatedAt || 0
  };
  for (const field of METADATA_FIELDS) resolved[field] = pick(field);
  for (const field of VIDEO_FIELDS) resolved[field] = videoFrame ? videoFrame[field] : null;
  return resolved;
}

/**
 * Rolling-window limiter: at most `max` sends per `windowMs`, newest wins.
 * `schedule` is injectable so tests never need real timers.
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
  let timer = null;

  function flush() {
    timer = null;
    if (!pending) return;
    const at = now();
    sentAt = sentAt.filter((t) => at - t < windowMs);
    if (sentAt.length >= max) {
      timer = schedule(flush, Math.max(1, windowMs - (at - sentAt[0]) + 1));
      return;
    }
    const payload = pending;
    pending = null;
    sentAt.push(at);
    try {
      send(payload);
    } catch {
      /* a dead port is handled by the port's own disconnect path */
    }
  }

  return {
    push(payload) {
      pending = payload;
      if (!timer) flush();
    },
    clear() {
      pending = null;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    get pending() {
      return pending;
    }
  };
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
  let bridgeState = "idle";
  let appName = null;
  let lastError = null;
  let lastActivity = null;
  let lastExtract = null;
  let lastSentJson = "";
  let desiredActivity;

  const limiter = createCoalescingLimiter({
    send: (activity) => sendActivity(activity)
  });

  function statusPayload() {
    return {
      bridgeState,
      appName,
      lastError,
      lastActivity,
      clientIdPresent: Boolean(clientId),
      enabled,
      updatedAt: Date.now()
    };
  }

  function persist() {
    const status = statusPayload();
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

  function setBridge(state, error = null) {
    bridgeState = state;
    lastError = error;
    persist();
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
      if (message.state === "connected") {
        backoffMs = BACKOFF_MIN_MS;
        appName = message.appName || appName;
        setBridge("connected");
        pushActivity(true);
      } else if (message.state === "error") {
        setBridge("error", message.detail || "Discord rejected the connection");
      } else {
        setBridge(String(message.state || "unknown"));
      }
      return;
    }
    if (message.t === "ack") {
      if (message.ok) {
        backoffMs = BACKOFF_MIN_MS;
        if (message.appName) appName = message.appName;
        if (bridgeState !== "connected") setBridge("connected");
        else persist();
      } else {
        setBridge("error", message.error || "Discord rejected the activity");
      }
      return;
    }
    if (message.t === "pong") {
      backoffMs = BACKOFF_MIN_MS;
      return;
    }
  }

  function onPortDisconnect() {
    const message = chromeApi.runtime.lastError && chromeApi.runtime.lastError.message;
    dropPort();
    setBridge("disconnected", message || "native host disconnected");
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
      setBridge("error", String((error && error.message) || error));
      scheduleReconnect();
      return;
    }
    port = fresh;
    port.onMessage.addListener(onNativeMessage);
    port.onDisconnect.addListener(onPortDisconnect);
    setBridge("connecting");
    post({ t: "hello", clientId });
  }

  /* ---------------------------------------------------------- activity -- */

  function sendActivity(activity) {
    if (!enabled) return;
    if (!port) ensurePort();
    if (!port || bridgeState !== "connected") return;
    const json = JSON.stringify(activity);
    if (json === lastSentJson) return;
    if (post({ t: "activity", activity })) lastSentJson = json;
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
    desiredActivity = best ? buildActivity(best) : null;
    lastActivity = desiredActivity;
    if (!desiredActivity) lastSentJson = "";
    persist();
    pushActivity(false);
  }

  function pushActivity(force) {
    if (!enabled) {
      if (port && bridgeState === "connected") {
        limiter.push(null);
        lastSentJson = "null";
      }
      return;
    }
    if (desiredActivity === undefined) return;
    if (!port) ensurePort();
    if (bridgeState !== "connected") return;
    const json = JSON.stringify(desiredActivity);
    if (!force && json === lastSentJson) return;
    limiter.push(desiredActivity);
  }

  /* ------------------------------------------------------------- tabs --- */

  function entryFor(tab) {
    let entry = tabStates.get(tab.id);
    if (!entry) {
      entry = { tabId: tab.id, top: null, frames: {}, pageUrl: tab.url || null, updatedAt: 0 };
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
    const carriesData =
      message.hasVideo === true ||
      METADATA_FIELDS.some((field) => message[field] !== null && message[field] !== undefined);
    if (!carriesData) return;

    const entry = entryFor(tab);
    mergeFrame(entry, {
      frameId: frameIdOf(sender),
      series: message.series ?? null,
      episodeTitle: message.episodeTitle ?? null,
      seasonNumber: message.seasonNumber ?? null,
      episodeNumber: message.episodeNumber ?? null,
      artworkUrl: message.artworkUrl ?? null,
      duration: message.duration ?? null,
      position: message.position ?? null,
      paused: message.paused ?? null,
      playbackRate: message.playbackRate ?? null,
      hasVideo: message.hasVideo === true,
      visible: message.visible !== false,
      signals: Array.isArray(message.signals) ? message.signals : []
    });

    lastExtract = {
      series: message.series ?? null,
      episodeTitle: message.episodeTitle ?? null,
      seasonNumber: message.seasonNumber ?? null,
      episodeNumber: message.episodeNumber ?? null,
      artworkUrl: message.artworkUrl ?? null,
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

  function handleGone(sender) {
    const tab = sender && sender.tab;
    if (!tab || tab.id === undefined) return;
    const entry = tabStates.get(tab.id);
    if (!entry) return;
    const frameId = frameIdOf(sender);
    if (frameId === 0) entry.top = null;
    else delete entry.frames[frameId];
    entry.updatedAt = Date.now();
    if (!resolveTab(entry)) tabStates.delete(tab.id);
    recompute();
  }

  /* ------------------------------------------------------------ boot ---- */

  function armWatchdog() {
    if (!chromeApi.alarms) return;
    try {
      chromeApi.alarms.create(ALARM_NAME, {
        periodInMinutes: ALARM_PERIOD_MINUTES,
        delayInMinutes: ALARM_PERIOD_MINUTES
      });
    } catch {
      /* permission revoked mid-session */
    }
  }

  async function loadConfig() {
    try {
      const stored = await chromeApi.storage.local.get(["clientId", "enabled"]);
      clientId = resolveClientId(stored.clientId);
      enabled = stored.enabled !== false;
    } catch {
      clientId = resolveClientId(null);
      enabled = true;
    }
  }

  function reconnect() {
    dropPort();
    lastSentJson = "";
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
        handleGone(sender);
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
        sendResponse({ queued: bridgeState === "connected", bridgeState, activity });
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
      else if (bridgeState === "connected") post({ t: "ping" });
      recompute();
    });
  }

  if (chromeApi.tabs && chromeApi.tabs.onRemoved) {
    chromeApi.tabs.onRemoved.addListener((tabId) => {
      if (tabStates.delete(tabId)) recompute();
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
        else {
          limiter.push(null);
          lastSentJson = "null";
        }
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
