/**
 * web-discord-rpc — MV3 service worker (module).
 *
 * One native port, two independent sources. Each source keeps its own tab
 * state, its own desired activity and its own 4-per-20 s send budget, so
 * YouTube (WATCHING) and YouTube Music (LISTENING) publish side by side
 * without evicting each other.
 *
 * The pure helpers are exported so the test suite can import this file
 * without a `chrome` global; `createWorker` takes the API object, so the tests
 * drive the real listener wiring with a fake chrome. Identity comes from
 * config.js; the payload rules live in activity.js; the status vocabulary in
 * bridge-status.js.
 */

import {
  DEFAULT_TRANSPORT,
  ENABLED_KEY,
  HOST_NAME,
  SITE_ENABLED_KEYS,
  SOURCE_YOUTUBE,
  SOURCE_YOUTUBE_MUSIC,
  TRANSPORT_KEY,
  resolveClientId,
  resolveEnabled,
  resolveSiteFlags,
  resolveTransport,
  sourceForUrl,
} from "./config.js";
import { buildActivity, clampText } from "./activity.js";
import {
  AVAILABILITY,
  BRIDGE,
  REASON,
  STATUS_KEY,
  bridgeStatusOf,
  classifyBridgeFailure,
} from "./bridge-status.js";

/** YouTube Music is processed first; both sources stay independent. */
export const SOURCES = Object.freeze([SOURCE_YOUTUBE_MUSIC, SOURCE_YOUTUBE]);

export const MAX_UPDATES = 4;
export const UPDATE_WINDOW_MS = 20000;
/** A tab that has not reported for this long is treated as closed. */
export const TAB_TTL_MS = 30 * 60 * 1000;
/** A ping with no pong inside this window marks the bridge disconnected. */
export const PONG_TIMEOUT_MS = 10000;
export const ALARM_NAME = "wdr-watchdog";
export const ALARM_PERIOD_MINUTES = 0.5;
export const BACKOFF_MIN_MS = 500;
export const BACKOFF_MAX_MS = 8000;
/** `chrome.storage.session` key holding the per-source tab map across worker suspension. */
export const SESSION_TABS_KEY = "wdrTabs";

/* ================================================================ pure ==== */

/**
 * Rolling-window limiter: at most `max` sends per `windowMs`, newest wins.
 * A pending payload replaces the one before it, so a burst of reports costs
 * one deferred send instead of one per report. `schedule`/`cancel`/`now` are
 * injectable so tests never need real timers.
 */
export function createCoalescingLimiter({
  send,
  max = MAX_UPDATES,
  windowMs = UPDATE_WINDOW_MS,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
}) {
  let sentAt = [];
  let pending = null;
  let hasPending = false;
  let timer = null;

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
  }

  return {
    push(payload) {
      pending = payload;
      hasPending = true;
      if (!timer) flush();
    },
    /** Drop the budget history and the deferred payload: a reconnect replays desired state. */
    reset() {
      sentAt = [];
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
 * The freshest tab for one source: playing beats paused, ties break on the
 * newest report. A tab whose title is not showable never wins.
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
 * Sources the previous worker session published, from the persisted status.
 * Only these are worth an explicit clear on startup: a source that was never
 * published has no stale presence to remove.
 */
function stalePresenceOf(storedStatus) {
  const activities =
    storedStatus && typeof storedStatus === "object" ? storedStatus.activities : null;
  if (!activities || typeof activities !== "object" || Array.isArray(activities)) return [];
  return SOURCES.filter((source) => {
    const entry = activities[source];
    return Boolean(entry) && typeof entry === "object" && !Array.isArray(entry);
  });
}

/* ============================================================== worker ==== */

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
  const tabsBySource = new Map(SOURCES.map((source) => [source, new Map()]));
  const siteEnabled = new Map(SOURCES.map((source) => [source, true]));
  const desired = new Map();
  const lastSent = new Map();
  const limiters = new Map();

  let sequence = 0;
  let port = null;
  let clientId = resolveClientId(null);
  let transportPreference = DEFAULT_TRANSPORT;
  let chosenTransport = null;
  let enabled = true;
  let staleSources = [];
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
  // The tab map is restored once per worker instance; `restored` lets an alarm
  // that lands before the restore has resolved wait for it instead of clearing
  // presence from an empty map.
  let restorePromise = null;
  let restored = false;
  let tabsReadable = true;

  /* -------------------------------------------------------------- status -- */

  function status() {
    const activities = {};
    const sites = {};
    for (const source of SOURCES) {
      activities[source] = desired.get(source) ?? null;
      sites[source] = siteEnabled.get(source);
    }
    return {
      bridgeState,
      availability,
      reason,
      reasonKind,
      // Raw diagnostic for logs and the options diagnostics; the UI never
      // renders this string directly.
      detail,
      // What the user chose (`auto|ipc|arrpc`) and what the host used
      // (`discord-ipc|arrpc|mixed`, null until it reports).
      transportPreference,
      transport: chosenTransport,
      activities,
      // Per-site enable flags, so every surface reads one answer.
      sites,
      // The host's own per-source view, carried opaquely for the popup.
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
      /* storage may be unavailable during shutdown */
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

  /* ------------------------------------------------------ tab persistence -- */

  function snapshotTabs() {
    const out = {};
    for (const source of SOURCES) {
      const tabs = {};
      for (const [tabId, entry] of tabsBySource.get(source)) {
        tabs[tabId] = { state: entry.state, at: entry.at, rankAt: entry.rankAt };
      }
      out[source] = tabs;
    }
    return out;
  }

  /**
   * Mirror the tab map into `storage.session` so an MV3 suspension does not
   * lose desired state. Only a real change writes: the serialised snapshot is
   * the dedupe key.
   */
  function persistTabs() {
    // Never write before the startup read has settled: an early report would
    // otherwise replace the stored map with the one tab it has seen so far.
    if (!restored || !tabsReadable || !api.storage?.session) return;
    const snapshot = snapshotTabs();
    const json = JSON.stringify(snapshot);
    if (json === lastTabsJson) return;
    lastTabsJson = json;
    try {
      const write = api.storage.session.set({ [SESSION_TABS_KEY]: snapshot });
      if (write && typeof write.catch === "function") write.catch(() => {});
    } catch {
      /* session storage may be unavailable during shutdown */
    }
  }

  /**
   * Take what is usable from a stored snapshot and let a fresher live report
   * win on the same tab. Every field is validated because session storage is
   * writable by any code in the extension: a corrupt value is ignored, never
   * thrown.
   */
  function hydrateTabs(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    let restoredAny = false;
    for (const source of SOURCES) {
      const bucket = raw[source];
      if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) continue;
      const map = tabsBySource.get(source);
      for (const [key, entry] of Object.entries(bucket)) {
        const tabId = Number(key);
        if (!Number.isInteger(tabId) || tabId < 0) continue;
        if (!entry || typeof entry !== "object") continue;
        if (!entry.state || typeof entry.state !== "object") continue;
        const at = Number(entry.at);
        if (!Number.isFinite(at) || at <= 0) continue;
        const rankAtRaw = Number(entry.rankAt);
        const rankAt = Number.isFinite(rankAtRaw) ? rankAtRaw : at;
        const existing = map.get(tabId);
        if (existing && existing.at >= at) continue;
        map.set(tabId, { state: entry.state, at, rankAt });
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
        const stored = await api.storage.session.get(SESSION_TABS_KEY);
        return hydrateTabs(stored ? stored[SESSION_TABS_KEY] : null);
      } catch {
        // A read that failed must not let the next write clobber a good
        // snapshot: keep persistence off for this instance.
        tabsReadable = false;
        return false;
      } finally {
        restored = true;
      }
    })();
    return restorePromise;
  }

  /* ---------------------------------------------------------------- port -- */

  function dropPort() {
    if (!port) return;
    const dying = port;
    port = null;
    // A dead port has no chosen transport; the next status frame names one.
    chosenTransport = null;
    try {
      dying.onMessage.removeListener(onNativeMessage);
    } catch {
      /* already torn down */
    }
    try {
      dying.onDisconnect.removeListener(onPortDisconnect);
    } catch {
      /* already torn down */
    }
    try {
      dying.disconnect();
    } catch {
      /* already disconnected */
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
    if (reconnectTimer !== null || !clientId || !enabled) return;
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
        // Discord appeared (or returned): replay the latest payload for every
        // source with no user action, resetting each coalescing window first.
        for (const limiter of limiters.values()) limiter.reset();
        for (const source of SOURCES) push(source, true);
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
        for (const source of SOURCES) push(source, false);
      } else {
        // Record the rejection without latching the bridge to "error": a slow
        // connect acks "arrpc-unavailable" while the arRPC handshake is in
        // flight, which must not look like a rejection.
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

  function onPortDisconnect() {
    const message = api.runtime?.lastError?.message;
    dropPort();
    applyFailure(message || "native host disconnected");
    scheduleReconnect();
  }

  function ensurePort() {
    if (port) return;
    if (!enabled) {
      // Presence is off: no native port at all, and no reconnect can sneak in.
      setBridge(BRIDGE.IDLE, null, {
        availability: AVAILABILITY.UNKNOWN,
        reason: null,
        reasonKind: null,
      });
      return;
    }
    if (!clientId) {
      setBridge(BRIDGE.IDLE);
      return;
    }
    let fresh;
    try {
      fresh = api.runtime.connectNative(HOST_NAME);
    } catch (error) {
      // A sync throw is the host-missing path on some Chrome builds:
      // neutral waiting with installer guidance, never a red error.
      applyFailure(String((error && error.message) || error));
      scheduleReconnect();
      return;
    }
    port = fresh;
    port.onMessage.addListener(onNativeMessage);
    port.onDisconnect.addListener(onPortDisconnect);
    setBridge(BRIDGE.CONNECTING, null, {
      availability: AVAILABILITY.UNKNOWN,
      reason: null,
      reasonKind: null,
    });
    post({ t: "hello", clientId, version: 1, transport: transportPreference });
  }

  /* ---------------------------------------------------------- presence off -- */

  /**
   * Publish an explicit clear for every source, straight down the port and past
   * the send budget: switching presence off must not wait for a limiter window,
   * and closing the socket is not a clear the host is required to send.
   */
  function clearPresence() {
    if (!port) return;
    for (const source of SOURCES) {
      post({ t: "activity", source, id: `${source}:${++sequence}`, activity: null });
    }
  }

  /** Honour the enable toggle: off tears the port down and stays down. */
  function setEnabled(next) {
    enabled = next;
    if (enabled) {
      reconnect();
      return;
    }
    clearPresence();
    for (const limiter of limiters.values()) limiter.reset();
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

  /**
   * Honour one site's flag: a site switched off stops publishing at once and
   * its published presence is cleared down the port, past the send budget,
   * because a media report may already be queued in that site's window.
   */
  function setSiteEnabled(source, next) {
    if (siteEnabled.get(source) === next) return;
    siteEnabled.set(source, next);
    if (next) {
      recompute(source);
      return;
    }
    desired.set(source, null);
    persist();
    deliver(source, null);
  }

  /* ------------------------------------------------------------ activity -- */

  function deliver(source, activity) {
    const id = `${source}:${++sequence}`;
    if (post({ t: "activity", source, id, activity })) {
      lastSent.set(source, JSON.stringify(activity));
    }
  }

  function limiterFor(source) {
    let limiter = limiters.get(source);
    if (!limiter) {
      limiter = createCoalescingLimiter({
        send: (activity) => deliver(source, activity),
        now,
        schedule,
        cancel,
      });
      limiters.set(source, limiter);
    }
    return limiter;
  }

  /**
   * Publish the desired activity for one source through its own budget. A dead
   * port just leaves the desired value in place: the next `status connected`
   * replays it.
   */
  function push(source, force = false) {
    if (!desired.has(source)) return;
    const activity = desired.get(source);
    const json = JSON.stringify(activity);
    if (!force && lastSent.get(source) === json) return;
    if (!port && reconnectTimer === null) ensurePort();
    if (!port || bridgeState !== BRIDGE.CONNECTED) return;
    limiterFor(source).push(activity);
  }

  function pruneStale(map, at) {
    for (const [tabId, entry] of map) {
      if (at - entry.at > TAB_TTL_MS) map.delete(tabId);
    }
  }

  function recompute(source) {
    const map = tabsBySource.get(source);
    pruneStale(map, now());
    persistTabs();
    // A disabled site is ignored: whatever its tabs report, the desired
    // activity is null, so the clear is what gets published.
    const best = siteEnabled.get(source) ? pickBestTab([...map.values()]) : null;
    desired.set(source, best ? buildActivity(source, best.state, now()) : null);
    persist();
    push(source, false);
  }

  /** Publish an explicit clear for a source the last session left published. */
  function clearSource(source) {
    desired.set(source, null);
    persist();
    push(source, true);
  }

  /* ---------------------------------------------------------------- tabs -- */

  function handleState(message, sender) {
    if (!api) return;
    const tab = sender && sender.tab;
    if (!tab || tab.id === undefined) return;
    // Only our own content scripts may report, and only from the top frame:
    // a nested YouTube embed must not overwrite the page it sits in.
    if (sender.id !== api.runtime.id) return;
    if (sender.frameId !== undefined && sender.frameId !== 0) return;
    const source = message.source;
    if (!tabsBySource.has(source)) return;
    // A disabled site is ignored outright: its clear already went out when the
    // flag was switched, and a report must not invent presence again.
    if (!siteEnabled.get(source)) return;
    const state = message.state;
    if (!state || typeof state !== "object") return;
    const url = typeof state.pageUrl === "string" && state.pageUrl ? state.pageUrl : tab.url;
    if (sourceForUrl(url) !== source) return;

    const at = now();
    tabsBySource.get(source).set(tab.id, { state, at, rankAt: at });
    recompute(source);
  }

  function handleGone(message, sender) {
    if (!api) return;
    const tab = sender && sender.tab;
    if (!tab || tab.id === undefined) return;
    if (sender.id !== api.runtime.id) return;
    const source = message.source;
    if (!tabsBySource.has(source)) return;
    if (!siteEnabled.get(source)) {
      // Still drop the tab so a later re-enable cannot resurrect it.
      tabsBySource.get(source).delete(tab.id);
      return;
    }
    if (tabsBySource.get(source).delete(tab.id)) recompute(source);
  }

  function handleTabRemoved(tabId) {
    let changed = false;
    for (const source of SOURCES) {
      if (tabsBySource.get(source).delete(tabId)) changed = true;
    }
    if (changed) for (const source of SOURCES) recompute(source);
  }

  function handleAlarm(alarm) {
    if (!alarm || alarm.name !== ALARM_NAME) return;
    if (!restored) {
      // A watchdog tick can land before the startup restore resolves; wait so
      // an empty map never publishes a clear over restored state.
      void restore().then(() => handleAlarm(alarm));
      return;
    }
    if (!port) {
      ensurePort();
    } else if (bridgeState === BRIDGE.CONNECTED) {
      // A hung host keeps the port open but never pongs: a ping with no pong
      // inside the bounded window marks the bridge disconnected and runs the
      // normal reconnect instead of staying "connected" forever.
      if (isPongOverdue(lastPingAt, lastPongAt, now())) {
        dropPort();
        applyFailure("native host pong timeout", { retries: hungCount + 1 });
        scheduleReconnect();
      } else if (post({ t: "ping" })) {
        lastPingAt = now();
      }
    }
    for (const source of SOURCES) recompute(source);
  }

  function handleStorageChange(changes, area) {
    if (area !== "local" || !changes) return;
    if (changes.clientId) {
      clientId = resolveClientId(changes.clientId.newValue);
      reconnect();
    }
    if (changes[TRANSPORT_KEY]) {
      const next = resolveTransport(changes[TRANSPORT_KEY].newValue);
      if (next !== transportPreference) {
        transportPreference = next;
        reconnect();
      }
    }
    if (changes[ENABLED_KEY]) {
      const next = resolveEnabled(changes[ENABLED_KEY].newValue);
      if (next !== enabled) setEnabled(next);
    }
    for (const [source, key] of Object.entries(SITE_ENABLED_KEYS)) {
      if (!changes[key]) continue;
      const next = resolveEnabled(changes[key].newValue);
      setSiteEnabled(source, next);
    }
  }

  function handleMessage(message, sender, sendResponse) {
    if (!message || typeof message !== "object") return false;
    switch (message.t) {
      case "wdr-state":
        handleState(message, sender);
        return false;
      case "wdr-gone":
        handleGone(message, sender);
        return false;
      case "wdr-get-status":
        if (typeof sendResponse === "function") sendResponse(status());
        return false;
      default:
        return false;
    }
  }

  /* ---------------------------------------------------------------- boot -- */

  function reconnect() {
    if (!enabled) return;
    dropPort();
    lastSent.clear();
    for (const limiter of limiters.values()) limiter.reset();
    backoffMs = BACKOFF_MIN_MS;
    if (reconnectTimer !== null) {
      cancel(reconnectTimer);
      reconnectTimer = null;
    }
    ensurePort();
    for (const source of SOURCES) push(source, true);
  }

  async function loadConfig() {
    let stored = null;
    try {
      stored = await api.storage.local.get([
        "clientId",
        TRANSPORT_KEY,
        ENABLED_KEY,
        STATUS_KEY,
        ...Object.values(SITE_ENABLED_KEYS),
      ]);
    } catch {
      stored = null;
    }
    clientId = resolveClientId(stored && stored.clientId);
    transportPreference = resolveTransport(stored && stored[TRANSPORT_KEY]);
    enabled = resolveEnabled(stored && stored[ENABLED_KEY]);
    const siteFlags = resolveSiteFlags(stored);
    for (const source of SOURCES) siteEnabled.set(source, siteFlags[source]);
    staleSources = stalePresenceOf(stored && stored[STATUS_KEY]);
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
        /* permission revoked mid-session */
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
      // Callback-style get: only create when no alarm exists yet, so a
      // restart never resets the watchdog countdown.
      getter.call(api.alarms, ALARM_NAME, (existing) => {
        if (!existing) create();
      });
    } catch {
      /* permission revoked mid-session */
    }
  }

  async function start() {
    await loadConfig();
    const restoredAny = await restore();
    armWatchdog();
    if (enabled) ensurePort();
    // A restored tab republishes its activity; a source the last session
    // published but nothing restored is explicitly cleared, so presence from a
    // session that ended without a clean disconnect cannot linger on Discord.
    for (const source of SOURCES) {
      if (restoredAny || tabsBySource.get(source).size) recompute(source);
      else if (staleSources.includes(source)) clearSource(source);
    }
    staleSources = [];
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
