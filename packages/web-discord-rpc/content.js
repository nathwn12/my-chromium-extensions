/**
 * web-discord-rpc — content script (classic script).
 *
 * Reads the page through `extract-youtube.js` (loaded first by the manifest)
 * and reports `{t:"wdr-state", source, state}` / `{t:"wdr-gone", source,
 * scope:"tab"}` to the service worker.
 *
 * Only the top frame may report: a subframe's state would overwrite the tab's
 * real activity. Media events, SPA navigation, visibility and pagehide drive
 * reports; a 1 s URL/title/pause poll covers the gaps, and predicts the running
 * position so a seek whose events were swallowed still re-aligns the card.
 * `timeupdate` is never observed.
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
  // A live position this far from the anchored one is a seek, a rate change or
  // an event we never saw — not rounding.
  var DRIFT_SECONDS = 2.5;
  // YouTube's player swaps its DOM after the URL changes; read once it settles.
  var SPA_SETTLE_MS = 250;

  var lastHref = href();
  var lastSource = null;
  var lastTitle = null;
  var lastPaused = null;
  var lastSample = null;
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
      lastSample = null;
      return;
    }
    reported = false;
    lastTitle = null;
    lastPaused = null;
    lastSample = null;
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
    lastSample = {
      title: state.title,
      paused: state.paused,
      position: state.position,
      at: state.at
    };
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
    var tag = String(target && target.tagName || "").toUpperCase();
    if (tag !== "VIDEO" && tag !== "AUDIO") return;
    reportNow();
  }

  /**
   * The poll's own check on the player: if playback is running, the anchored
   * position predicts where the live one should be. A position far from that
   * prediction is a seek, a rate change or a swallowed event, so report it and
   * re-anchor. Rounding keeps a steady playback well inside the threshold.
   *
   * The prediction runs at the reported `playbackRate`, so a non-1x playback is
   * not drift by design; anything that is not a finite positive rate counts as
   * 1x. A position that has not moved at all is a stalled buffer, not a seek:
   * reporting it would re-anchor every tick and spend the worker's send budget
   * on silence. A seek still moves the position, so it still reports.
   */
  function drifted(state) {
    var last = lastSample;
    if (!last || last.paused || state.paused) return false;
    var live = state.position;
    if (!isFinite(live) || !isFinite(last.position)) return false;
    if (live === last.position) return false;
    var rate = state.playbackRate;
    if (!isFinite(rate) || rate <= 0) rate = 1;
    var expected = last.position + ((Date.now() - last.at) / 1000) * rate;
    return Math.abs(live - expected) > DRIFT_SECONDS;
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
      return;
    }
    if (drifted(state)) report(state);
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
