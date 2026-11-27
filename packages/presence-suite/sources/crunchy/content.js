/**
 * Crunchy Presence — content script (classic script).
 *
 * Reads the page through `extract.js` (loaded first by the manifest) and
 * reports `{t:"presence-state", source:"crunchy", state:{...}}` payloads to
 * the service worker.
 *
 * Crunchyroll plays inside an iframe: the top frame reports metadata, the
 * player frame reports the <video>, so EVERY frame with a video or with
 * non-null metadata reports. No URLs are sent — the worker uses the tab's own
 * URL, which only the top frame can supply truthfully.
 */
(function () {
  "use strict";

  const EXTRACT = globalThis.CrunchyrollExtract;
  if (!EXTRACT || typeof EXTRACT.extract !== "function") return;

  const MEDIA_EVENTS = [
    "loadedmetadata",
    "play",
    "pause",
    "seeking",
    "seeked",
    "ended",
    "ratechange"
  ];
  const URL_POLL_MS = 1000;
  const SPA_SETTLE_MS = 300;
  const KEEPALIVE_MS = 30000;
  // A non-1x playhead drifts from the worker's send-time anchor between
  // keepalives. Refresh on a short cadence only while such a video is playing;
  // 1x and paused keep the cheap 30 s keepalive.
  const RATE_CADENCE_MS = 2500;
  const RATE_EPSILON = 0.01;

  let lastHref = location.href;
  let lastInformative = false;
  let lastVideo = null;
  let lastReportAt = 0;
  let settleTimer = null;
  let pollTimer = null;
  let enabled = false;
  let enabledKnown = false;
  let bootReported = false;
  try {
    chrome.storage?.local?.get?.(["enabled"], (stored) => {
      enabledKnown = true;
      setEnabled(!stored || !stored.enabled || stored.enabled["crunchy"] !== false);
    });
  } catch {
    enabledKnown = true;
    setEnabled(true);
  }
  try {
    chrome.storage?.onChanged?.addListener?.((changes, area) => {
      if (area === "local" && changes && changes.enabled) {
        var map = changes.enabled.newValue;
        setEnabled(!map || map["crunchy"] !== false);
      }
    });
  } catch {
  }

  function startPoll() {
    if (!enabledKnown || !enabled || pollTimer !== null) return;
    pollTimer = setInterval(tick, URL_POLL_MS);
  }

  function stopPoll() {
    if (pollTimer === null) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  /** Off stops the poll; on republishes at once and resumes polling. */
  function setEnabled(next) {
    const value = next !== false;
    if (value === enabled) return;
    enabled = value;
    if (!enabled) {
      stopPoll();
      return;
    }
    bootReported = true;
    report(false);
    startPoll();
  }

  function send(message) {
    try {
      chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
    } catch {
    }
  }

  function extract() {
    try {
      return EXTRACT.extract(document, navigator);
    } catch {
      return null;
    }
  }

  function informative(state) {
    if (!state) return false;
    if (state.hasVideo) return true;
    return Boolean(
      state.series ||
        state.episodeTitle ||
        state.artworkUrl ||
        state.seasonNumber !== null ||
        state.episodeNumber !== null
    );
  }

  /** Report interval for the current video: short only for live non-1x play. */
  function cadenceFor(video) {
    if (!video || video.paused !== false) return KEEPALIVE_MS;
    const rate = Number(video.playbackRate);
    return Number.isFinite(rate) && Math.abs(rate - 1) >= RATE_EPSILON
      ? RATE_CADENCE_MS
      : KEEPALIVE_MS;
  }

  function report(isKeepalive = false) {
    // A URL change opens a settle window. Media events from the old video may
    // still fire in it; they must not publish stale state after the gone.
    if (!enabled || settleTimer !== null) return;
    const state = extract();
    if (!informative(state)) {
      if (lastInformative) {
        lastInformative = false;
        lastVideo = null;
        send({ t: "presence-gone", source: "crunchy" });
      }
      return;
    }
    lastInformative = true;
    lastVideo = document.querySelector("video");
    lastReportAt = Date.now();
    var payload = Object.assign(
      { visible: document.visibilityState !== "hidden" },
      state,
      isKeepalive ? { keepalive: true } : null
    );
    send({ t: "presence-state", source: "crunchy", state: payload });
  }

  function onMediaEvent(event) {
    if (!enabled) return;
    const target = event.target;
    if (!target || target.tagName !== "VIDEO") return;
    report(false);
  }

  MEDIA_EVENTS.forEach((name) => {
    document.addEventListener(name, onMediaEvent, true);
  });

  document.addEventListener("visibilitychange", () => {
    if (!enabled) return;
    report(false);
  });

  window.addEventListener("popstate", () => {
    lastHref = "";
    checkUrl();
  });

  window.addEventListener("hashchange", () => {
    lastHref = "";
    checkUrl();
  });

  window.addEventListener("pagehide", () => {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    send({ t: "presence-gone", source: "crunchy", scope: "tab" });
  });

  window.addEventListener("pageshow", () => {
    lastHref = location.href;
    if (!enabledKnown || !enabled) return;
    report(false);
    startPoll();
  });

  function checkUrl() {
    if (location.href === lastHref) return false;
    lastHref = location.href;
    lastInformative = false;
    send({ t: "presence-gone", source: "crunchy", scope: "frame" });
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      if (!enabled) return;
      report(false);
    }, SPA_SETTLE_MS);
    return true;
  }

  startPoll();

  function tick() {
    if (!enabled) return;
    checkUrl();
    const video = document.querySelector("video");
    if (!video) {
      stopPoll();
      return;
    }
    if (video && video !== lastVideo) report(false);
    if (video && Date.now() - lastReportAt >= cadenceFor(video)) report(true);
  }

  try {
    const target =
      document.querySelector("#player-container") || document.documentElement || document;
    const observer = new MutationObserver(() => {
      if (!enabled) return;
      checkUrl();
      const video = document.querySelector("video");
      if (video) {
        startPoll();
        if (video !== lastVideo) report(false);
      }
    });
    if (target && typeof observer.observe === "function") {
      observer.observe(target, { childList: true, subtree: true });
    }
  } catch {
  }

  function initialReport() {
    if (!enabledKnown || !enabled || bootReported) return;
    bootReported = true;
    report();
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    initialReport();
  } else {
    document.addEventListener("DOMContentLoaded", initialReport, { once: true });
  }
})();
