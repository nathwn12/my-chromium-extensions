/**
 * Crunchyroll Discord Presence — content script (classic script).
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
    "ratechange",
    "timeupdate"
  ];
  const TIMUPDATE_INTERVAL_MS = 1000;
  const URL_POLL_MS = 1000;
  const SPA_SETTLE_MS = 300;

  let lastHref = location.href;
  let lastInformative = false;
  let lastTimeUpdate = 0;
  let lastVideo = null;
  let settleTimer = null;

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
    if (event.type === "timeupdate") {
      const now = Date.now();
      if (now - lastTimeUpdate < TIMUPDATE_INTERVAL_MS) return;
      lastTimeUpdate = now;
    }
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
    send({ kind: "crp-gone" });
  });

  function checkUrl() {
    if (location.href === lastHref) return false;
    lastHref = location.href;
    lastInformative = false;
    send({ kind: "crp-gone" });
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      report();
    }, SPA_SETTLE_MS);
    return true;
  }

  setInterval(() => {
    checkUrl();
    const video = document.querySelector("video");
    if (video && video !== lastVideo) report();
  }, URL_POLL_MS);

  if (document.readyState === "complete" || document.readyState === "interactive") {
    report();
  } else {
    document.addEventListener("DOMContentLoaded", report, { once: true });
  }
})();
