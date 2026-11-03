/**
 * Crunchy Presence — content script (classic script).
 *
 * Reads the page through `extract.js` (loaded first by the manifest) and
 * reports flat `{kind:"crp-state", ...}` payloads to the service worker.
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
  // A paused video fires no media events, so re-report on a low cadence
  // while a video element exists; otherwise the worker prunes the tab at
  // FRAME_TTL_MS and presence flickers out.
  const KEEPALIVE_MS = 30000;

  let lastHref = location.href;
  let lastInformative = false;
  let lastVideo = null;
  let lastReportAt = 0;
  let settleTimer = null;
  let pollTimer = null;
  // While disabled the 1 s poll does no DOM work; the worker clears presence.
  let enabled = true;
  try {
    chrome.storage?.local?.get?.(["enabled"], (stored) => {
      enabled = !stored || stored.enabled !== false;
    });
  } catch {
    /* storage unavailable — stay enabled */
  }
  try {
    chrome.storage?.onChanged?.addListener?.((changes, area) => {
      if (area === "local" && changes && changes.enabled) {
        enabled = changes.enabled.newValue !== false;
      }
    });
  } catch {
    /* storage unavailable — stay enabled */
  }

  function send(message) {
    try {
      chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
    } catch {
      /* extension reloaded under us — nothing to do */
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

  function report(isKeepalive = false) {
    if (!enabled) return;
    const state = extract();
    if (!informative(state)) {
      if (lastInformative) {
        lastInformative = false;
        lastVideo = null;
        send({ kind: "crp-gone" });
      }
      return;
    }
    lastInformative = true;
    lastVideo = document.querySelector("video");
    lastReportAt = Date.now();
    send(
      Object.assign(
        {
          kind: "crp-state",
          visible: document.visibilityState !== "hidden"
        },
        state,
        isKeepalive ? { keepalive: true } : null
      )
    );
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

  // hashchange fires for same-document navigations that popstate misses.
  window.addEventListener("hashchange", () => {
    lastHref = "";
    checkUrl();
  });

  window.addEventListener("pagehide", () => {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    send({ kind: "crp-gone", scope: "tab" });
  });

  // bfcache restore fires pageshow (persisted) without a fresh load: report
  // again so a back/forward restore republishes within one tick.
  window.addEventListener("pageshow", () => {
    lastHref = location.href;
    if (!enabled) return;
    report(false);
  });

  function checkUrl() {
    if (location.href === lastHref) return false;
    lastHref = location.href;
    lastInformative = false;
    send({ kind: "crp-gone", scope: "frame" });
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      if (!enabled) return;
      report(false);
    }, SPA_SETTLE_MS);
    return true;
  }

  pollTimer = setInterval(tick, URL_POLL_MS);

  // The 1 Hz poll runs only while a video actually exists: observer-driven
  // detection (player container mutations plus popstate/hashchange) covers
  // URL changes, so an idle page without a video holds no wakeups.
  function tick() {
    if (!enabled) return;
    checkUrl();
    const video = document.querySelector("video");
    if (!video) {
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      return;
    }
    if (video && video !== lastVideo) report(false);
    // Low-rate keepalive while a video exists so a paused tab never ages
    // out at FRAME_TTL_MS on the worker side. Marked keepalive so it never
    // re-ranks the multi-tab winner.
    if (video && Date.now() - lastReportAt >= KEEPALIVE_MS) report(true);
  }

  try {
    const target =
      document.querySelector("#player-container") || document.documentElement || document;
    const observer = new MutationObserver(() => {
      if (!enabled) return;
      checkUrl();
      const video = document.querySelector("video");
      if (video) {
        if (pollTimer === null) pollTimer = setInterval(tick, URL_POLL_MS);
        if (video !== lastVideo) report(false);
      }
    });
    if (target && typeof observer.observe === "function") {
      observer.observe(target, { childList: true, subtree: true });
    }
  } catch {
    /* MutationObserver unavailable — the poll still covers URL changes */
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    report();
  } else {
    document.addEventListener("DOMContentLoaded", report, { once: true });
  }
})();
