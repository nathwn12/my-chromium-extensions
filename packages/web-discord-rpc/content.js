/**
 * web-discord-rpc — content script (classic script).
 *
 * Reads the page through `extract-youtube.js` (loaded first by the manifest)
 * and reports `{t:"wdr-state", source, state}` / `{t:"wdr-gone", source,
 * scope:"tab"}` to the service worker.
 *
 * Only the top frame may report: a subframe's state would overwrite the tab's
 * real activity. Media events, SPA navigation, visibility and pagehide drive
 * reports; a 1 s URL/title/pause poll covers the gaps. `timeupdate` is never
 * observed.
 */
(function () {
  "use strict";

  // The manifest matches every frame; subframes must stay silent.
  try {
    if (typeof top !== "undefined" && top && top !== globalThis) return;
  } catch (_) {
    return;
  }

  var EXTRACT = globalThis.YoutubeExtract;
  if (!EXTRACT || typeof EXTRACT.read !== "function") return;

  var MEDIA_EVENTS = [
    "loadedmetadata",
    "durationchange",
    "play",
    "pause",
    "seeking",
    "seeked",
    "ended",
    "ratechange",
    "emptied"
  ];
  var POLL_MS = 1000;
  // YouTube's player swaps its DOM after the URL changes; read once it settles.
  var SPA_SETTLE_MS = 250;

  var lastHref = href();
  var lastSource = null;
  var lastTitle = null;
  var lastPaused = null;
  var reported = false;
  var settleTimer = null;

  function href() {
    try {
      return location && typeof location.href === "string" ? location.href : "";
    } catch (_) {
      return "";
    }
  }

  function send(message) {
    try {
      chrome.runtime.sendMessage(message, function () {
        void chrome.runtime.lastError;
      });
    } catch (_) {
      /* extension reloaded under us — nothing to do */
    }
  }

  function sourceNow() {
    try {
      return EXTRACT.sourceForLocation(location);
    } catch (_) {
      return null;
    }
  }

  function readState() {
    try {
      return EXTRACT.read(document, navigator, location);
    } catch (_) {
      return null;
    }
  }

  function gone() {
    if (!reported) {
      lastTitle = null;
      lastPaused = null;
      return;
    }
    reported = false;
    lastTitle = null;
    lastPaused = null;
    send({ t: "wdr-gone", source: sourceNow() || lastSource, scope: "tab" });
  }

  function report(state) {
    if (!state || !state.title) {
      gone();
      return;
    }
    var source = sourceNow();
    if (!source) {
      gone();
      return;
    }
    state.at = Date.now();
    lastSource = source;
    lastTitle = state.title;
    lastPaused = state.paused;
    reported = true;
    send({ t: "wdr-state", source: source, state: state });
  }

  function reportNow() {
    report(readState());
  }

  /** A new URL is a new page: a non-watch URL clears the tab immediately. */
  function checkUrl() {
    var current = href();
    if (current === lastHref) return;
    lastHref = current;
    if (settleTimer !== null) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    if (!readState()) {
      gone();
      return;
    }
    settleTimer = setTimeout(function () {
      settleTimer = null;
      reportNow();
    }, SPA_SETTLE_MS);
  }

  function onSpaNavigation() {
    checkUrl();
    // Same-URL re-renders (yt-page-data-updated) need no settle wait.
    if (settleTimer === null) reportNow();
  }

  function onMediaEvent(event) {
    var target = event && event.target;
    if (!target || String(target.tagName || "").toUpperCase() !== "VIDEO") return;
    reportNow();
  }

  function tick() {
    checkUrl();
    var state = readState();
    if (!state || !state.title) {
      gone();
      return;
    }
    if (!reported || state.title !== lastTitle || state.paused !== lastPaused) {
      report(state);
    }
  }

  for (var i = 0; i < MEDIA_EVENTS.length; i += 1) {
    document.addEventListener(MEDIA_EVENTS[i], onMediaEvent, true);
  }

  document.addEventListener("yt-navigate-finish", onSpaNavigation);
  document.addEventListener("yt-page-data-updated", onSpaNavigation);
  document.addEventListener("visibilitychange", reportNow);

  window.addEventListener("popstate", onSpaNavigation);
  window.addEventListener("pagehide", function () {
    if (settleTimer !== null) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    gone();
  });
  // bfcache restore: republish without waiting for a fresh load.
  window.addEventListener("pageshow", function () {
    lastHref = href();
    reportNow();
  });

  setInterval(tick, POLL_MS);

  if (document.readyState === "complete" || document.readyState === "interactive") {
    reportNow();
  } else {
    document.addEventListener("DOMContentLoaded", reportNow, { once: true });
  }
})();
