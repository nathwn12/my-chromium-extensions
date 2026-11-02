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

  function report() {
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
        state
      )
    );
  }

  function onMediaEvent(event) {
    const target = event.target;
    if (!target || target.tagName !== "VIDEO") return;
    report();
  }

  MEDIA_EVENTS.forEach((name) => {
    document.addEventListener(name, onMediaEvent, true);
  });

  document.addEventListener("visibilitychange", report);

  window.addEventListener("popstate", () => {
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
    report();
  });

  function checkUrl() {
    if (location.href === lastHref) return false;
    lastHref = location.href;
    lastInformative = false;
    send({ kind: "crp-gone", scope: "frame" });
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      report();
    }, SPA_SETTLE_MS);
    return true;
  }

  pollTimer = setInterval(() => {
    if (!enabled) return;
    checkUrl();
    const video = document.querySelector("video");
    if (video && video !== lastVideo) report();
    // Low-rate keepalive while a video exists so a paused tab never ages
    // out at FRAME_TTL_MS on the worker side.
    if (video && Date.now() - lastReportAt >= KEEPALIVE_MS) report();
  }, URL_POLL_MS);

  if (document.readyState === "complete" || document.readyState === "interactive") {
    report();
  } else {
    document.addEventListener("DOMContentLoaded", report, { once: true });
  }
})();
