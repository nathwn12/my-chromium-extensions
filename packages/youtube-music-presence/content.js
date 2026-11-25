/**
 * youtube-music-presence — content script (classic script).
 *
 * Reads the page through `extract-youtube.js` (loaded first by the manifest)
 * and reports `{t:"ytmp-state", source, state}` / `{t:"ytmp-gone", source,
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
  var ENABLED_KEY = "enabled";
  var DRIFT_SECONDS = 2.5;
  var RATE_EPSILON = 0.01;
  var SPA_SETTLE_MS = 250;
  var FRESH_POSITION_SECONDS = 2;

  var lastHref = href();
  var lastSource = null;
  var lastTitle = null;
  var lastSample = null;
  var lastCredibleDuration = null;
  var pendingTiming = null;
  /** Local-only baseline: the last published timed sample. */
  var lastTimed = null;
  var loopSeekEvent = false;
  var reported = false;
  var settleTimer = null;
  var staleTimer = null;
  var pollTimer = null;
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
    }
  }

  /**
   * Which song and which sample this is. Title, link, id and duration travel
   * together: two songs can share a title, and a reused media element can keep
   * the old duration after the player bar has switched to the next track.
   */
  function trackIdentity(state) {
    return JSON.stringify([
      state.title || null,
      state.channel || null,
      state.trackUrl || null,
      state.mediaId || null
    ]);
  }

  function sampleIdentity(state) {
    return JSON.stringify([
      state.title || null,
      state.trackUrl || null,
      state.mediaId || null,
      typeof state.duration === "number" && isFinite(state.duration) ? state.duration : null
    ]);
  }

  function sourceEvidence() {
    return EXTRACT.mediaSourceOf ? EXTRACT.mediaSourceOf() : null;
  }

  function clockAgreement() {
    return Boolean(EXTRACT.clockAgreesOf && EXTRACT.clockAgreesOf());
  }

  /** Discord stamps floor(duration); compare media and clock in that same unit. */
  function durationUnit(value) {
    return typeof value === "number" && isFinite(value) ? Math.floor(value) : null;
  }

  /**
   * A changed total is fresh only with an owned reset: a playhead at the start
   * of the track, or a coherent read whose source differs from the last
   * published sample's source. `sourceEvidence()` is non-null only when the
   * extractor picked a media element that agrees with the player-bar clock, so
   * it proves ownership; a bare `currentSrc` string does not. All else fails
   * closed.
   */
  function ownsFreshTiming(state, unit, mediaSource) {
    if (unit === null || unit === lastCredibleDuration) return false;
    var position = state.position;
    if (typeof position === "number" && isFinite(position) && position >= 0 && position <= FRESH_POSITION_SECONDS) return true;
    return Boolean(mediaSource) && (!lastSample || !lastSample.source || mediaSource !== lastSample.source);
  }

  /**
   * A backward seek the player announced, on the same track, total and
   * coherent source as the last published timed sample, is the loop itself —
   * not a new track's stale timing. It reopens a hold only with that full
   * match: an outgoing element or a different track fails identity, duration
   * or source, and a forward seek fails the playhead comparison. The playhead
   * baseline is the published sample, so a held read of the loop position
   * cannot hide the seek from the next event.
   */
  function loopReopensHold(state, identity, unit, mediaSource) {
    if (!loopSeekEvent || !pendingTiming || !lastTimed) return false;
    if (state.paused !== false) return false;
    if (identity !== pendingTiming.track || identity !== lastTimed.track) return false;
    if (unit === null || lastTimed.unit === null || unit !== lastTimed.unit) return false;
    if (!mediaSource || !lastTimed.source || mediaSource !== lastTimed.source) return false;
    var position = state.position;
    if (typeof position !== "number" || !isFinite(position) || position < 0 || position > unit) return false;
    return position < lastTimed.position - 1;
  }

  /** True only when the current read is the sample already published. */
  function unchanged(state) {
    if (!lastSample || state.title !== lastSample.title || state.paused !== lastSample.paused) return false;
    if (pendingTiming) {
      if (trackIdentity(state) !== pendingTiming.track) return false;
      var duration = durationUnit(state.duration);
      return duration === null || duration === pendingTiming.duration;
    }
    var hadPosition = lastSample.position !== null && lastSample.position !== undefined;
    var hasPosition = state.position !== null && state.position !== undefined;
    if (hadPosition !== hasPosition) return false;
    return sampleIdentity(state) === lastSample.identity;
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
      lastSample = null;
      lastCredibleDuration = null;
      return;
    }
    reported = false;
    lastTitle = null;
    lastSample = null;
    /** Carry one guard across the blank page: a stale clock can survive it. */
    pendingTiming = { track: null, duration: lastCredibleDuration };
    send({ t: "ytmp-gone", source: sourceNow() || lastSource, scope: "tab" });
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

    /**
     * Identity can change before its timing does. A stale bar clock and a stale
     * media element can agree perfectly on the previous song, so agreement is
     * not freshness. Publish a changed total only with an owned reset: a
     * near-zero playhead or a coherent source new to the last sample.
     * A new source at the old total stays blocked. A mid-song total under the
     * same source cannot be told apart from ingested stale timing, so it fails
     * closed at the incoming total until a different owned total arrives. Wall
     * time alone never releases a hold.
     */
    var rawDuration = state.duration;
    var identity = trackIdentity(state);
    var mediaSource = sourceEvidence();
    var rawUnit = durationUnit(rawDuration);
    var credible = rawUnit !== null ? rawUnit : lastCredibleDuration;
    var owned = ownsFreshTiming(state, rawUnit, mediaSource);
    if (!lastSample && pendingTiming && pendingTiming.track === null) {
      pendingTiming.track = identity;
    }
    if (lastSample && identity !== lastSample.track) {
      pendingTiming = owned ? null : { track: identity, duration: credible };
    } else if (pendingTiming && identity !== pendingTiming.track) {
      pendingTiming = null;
    }
    if (pendingTiming && loopReopensHold(state, identity, rawUnit, mediaSource)) {
      pendingTiming = null;
    }
    if (pendingTiming) {
      var sampleUnit = durationUnit(state.duration);
      /**
       * Releasing a hold needs ownership, not just a changed total. A new
       * identity may reuse the previous media element, so a coherent total
       * that differs from both the held and the credited total is enough there.
       * A hold on the same track is different: a blank page or an incoherent
       * read can leave the last sample source-less, so compare against the
       * last published timed sample, never the withheld one. Under that same
       * source a changed total is outgoing timing and stays held.
       */
      var sameTrackHold = Boolean(lastTimed) && identity === lastTimed.track;
      var baselineSource = sameTrackHold ? lastTimed.source : lastSample && lastSample.source;
      var position = state.position;
      var nearZero =
        typeof position === "number" && isFinite(position) && position >= 0 &&
        position <= FRESH_POSITION_SECONDS;
      var newSource = Boolean(mediaSource) && (!baselineSource || mediaSource !== baselineSource);
      var newIdentityOwns = Boolean(mediaSource) && !sameTrackHold && clockAgreement();
      if (
        sampleUnit === null ||
        sampleUnit === pendingTiming.duration ||
        sampleUnit === lastCredibleDuration ||
        (!nearZero && !newSource && !newIdentityOwns)
      ) {
        state.duration = null;
        state.position = null;
      } else {
        pendingTiming = null;
      }
    }
    /** A withheld read never becomes the credited duration baseline. */
    if (state.duration !== null && credible !== null) lastCredibleDuration = credible;

    state.at = Date.now();
    lastSource = source;
    lastTitle = state.title;
    lastSample = {
      title: state.title,
      paused: state.paused,
      position: state.position,
      duration: state.duration,
      rawDuration: rawDuration,
      source: mediaSource,
      track: identity,
      identity: sampleIdentity(state),
      at: state.at
    };
    if (state.duration !== null && typeof state.position === "number" && isFinite(state.position)) {
      lastTimed = {
        track: identity,
        unit: durationUnit(state.duration),
        source: mediaSource,
        position: state.position
      };
    }
    reported = true;
    send({ t: "ytmp-state", source: source, state: state });
  }

  function reportNow() {
    if (!enabled) return;
    report(readState());
  }

  /**
   * A media event can fire for the next track before the player bar swaps its
   * title. The event's own report still goes out — a pause, seek or rate change
   * must not wait — so one short re-read closes the gap to the poll. A re-read
   * that still shows the same title and playback state is a duplicate and stays
   * silent: publishing it would spend a send on an unchanged card.
   */
  function armStaleReRead() {
    if (staleTimer !== null) clearTimeout(staleTimer);
    staleTimer = setTimeout(function () {
      staleTimer = null;
      if (!enabled) return;
      var state = readState();
      if (!state || !state.title) {
        gone();
        return;
      }
      if (unchanged(state)) return;
      report(state);
    }, SPA_SETTLE_MS);
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
    if (staleTimer !== null) {
      clearTimeout(staleTimer);
      staleTimer = null;
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
    if (settleTimer === null) reportNow();
  }

  function onMediaEvent(event) {
    var target = event && event.target;
    var tag = String(target && target.tagName || "").toUpperCase();
    if (tag !== "VIDEO" && tag !== "AUDIO") return;
    var state = readState();
    if (enabled && state && (!state.title || state.title === lastTitle)) armStaleReRead();
    loopSeekEvent = event && (event.type === "seeking" || event.type === "seeked");
    report(state);
    loopSeekEvent = false;
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
    if (typeof live !== "number" || typeof last.position !== "number") return false;
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
    if (typeof state.position !== "number" || typeof last.position !== "number") return false;
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
    if (!reported || !unchanged(state)) {
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
    if (staleTimer !== null) {
      clearTimeout(staleTimer);
      staleTimer = null;
    }
    gone();
  });
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
