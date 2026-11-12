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
  // `storage.local` key the popup switch and the worker both use.
  var ENABLED_KEY = "enabled";
  // A live position this far from the anchored one is a seek, a rate change or
  // an event we never saw — not rounding.
  var DRIFT_SECONDS = 2.5;
  // Discord counts elapsed time in wall time and has no field for the playback
  // rate, so any non-1x playback falls behind by `rate - 1` every second.
  // Reporting on every tick re-anchors the card before the gap is visible.
  var RATE_EPSILON = 0.01;
  // YouTube's player swaps its DOM after the URL changes; read once it settles.
  var SPA_SETTLE_MS = 250;

  var lastHref = href();
  var lastSource = null;
  var lastTitle = null;
  var lastPaused = null;
  var lastSample = null;
  var reported = false;
  var settleTimer = null;
  var pollTimer = null;
  // The master presence switch (on unless explicitly stored `false`). Off means
  // the page is not read at all: the poll stops and every report is dropped,
  // because the worker holds no port and has nothing to publish.
  var enabled = true;

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
    if (!enabled) return;
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
    if (!enabled) return;
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
    if (!enabled) return;
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

  /**
   * A running playback at a rate Discord cannot represent: the card counts
   * elapsed seconds in wall time, so at 1.5x it falls behind half a second per
   * second and no RPC field can correct it. Every tick re-anchors it, which is
   * the only way the timer stays with the track. A paused tab, a position that
   * has not moved and a junk rate are all silence: they are not a rate gap, and
   * reporting them would spend the worker's send budget for nothing.
   */
  function reanchorDue(state) {
    var last = lastSample;
    if (!last || last.paused || state.paused) return false;
    if (!isFinite(state.position) || !isFinite(last.position)) return false;
    if (state.position === last.position) return false;
    var rate = state.playbackRate;
    if (typeof rate !== "number" || !isFinite(rate)) return false;
    return Math.abs(rate - 1) > RATE_EPSILON;
  }

  function startPoll() {
    if (!enabled || pollTimer !== null) return;
    pollTimer = setInterval(tick, POLL_MS);
  }

  function stopPoll() {
    if (pollTimer === null) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  /**
   * The switch is the master gate: off stops the poll and drops every report,
   * on re-arms the poll and publishes the current state at once so the card
   * fills in without waiting for a tick or a media event.
   */
  function setEnabled(next) {
    var value = next !== false;
    if (value === enabled) return;
    enabled = value;
    if (!enabled) {
      stopPoll();
      return;
    }
    startPoll();
    reportNow();
  }

  /** Read the stored switch once and follow it from then on. */
  function watchEnabled() {
    try {
      if (!chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.get([ENABLED_KEY], function (stored) {
        if (stored && stored.enabled === false) setEnabled(false);
      });
      if (chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
        chrome.storage.onChanged.addListener(function (changes, area) {
          if (area !== "local" || !changes || !changes.enabled) return;
          setEnabled(changes.enabled.newValue !== false);
        });
      }
    } catch (_) {
      /* storage unavailable — presence stays on */
    }
  }

  function tick() {
    if (!enabled) return;
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
    if (drifted(state) || reanchorDue(state)) report(state);
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

  watchEnabled();
  startPoll();

  if (document.readyState === "complete" || document.readyState === "interactive") {
    reportNow();
  } else {
    document.addEventListener("DOMContentLoaded", reportNow, { once: true });
  }
})();
