import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyGoneToEntry,
  isTrustedFrameUrl,
  mergeFrame,
  resolveTab,
} from "../sources/crunchy/frame-merge.js";

const TAB = "https://www.crunchyroll.com/watch/G6VU774M5/episode";

function newEntry() {
  return {
    tabId: 7,
    top: null,
    frames: {},
    pageUrl: TAB,
    updatedAt: 0,
    rankAt: 0,
  };
}

function topFrame(overrides = {}) {
  return {
    frameId: 0,
    series: "Series Name",
    episodeTitle: "Episode Name",
    seasonNumber: 1,
    episodeNumber: 5,
    artworkUrl: null,
    seriesUrl: null,
    episodeUrl: null,
    synopsis: null,
    duration: null,
    position: null,
    paused: null,
    playbackRate: null,
    hasVideo: false,
    visible: true,
    signals: [],
    receivedAt: 1000,
    ...overrides,
  };
}

function videoFrame(overrides = {}) {
  return {
    frameId: 3,
    series: null,
    episodeTitle: null,
    seasonNumber: null,
    episodeNumber: null,
    artworkUrl: null,
    seriesUrl: null,
    episodeUrl: null,
    synopsis: null,
    duration: 1440,
    position: 42,
    paused: false,
    playbackRate: 1,
    hasVideo: true,
    visible: true,
    signals: [],
    receivedAt: 1100,
    ...overrides,
  };
}

// Mutation: make isTrustedFrameUrl always return false (reject every iframe).
test("isTrustedFrameUrl accepts the site's own watch-frame origin and path", () => {
  assert.equal(isTrustedFrameUrl("https://www.crunchyroll.com/watch/G6VU774M5/player", TAB), true);
  assert.equal(isTrustedFrameUrl("https://www.crunchyroll.com/watch/G6VU774M5", TAB), true);
});

// Mutation: drop the frame.origin !== tab.origin check.
test("isTrustedFrameUrl rejects a different origin even on a crunchy subdomain", () => {
  assert.equal(isTrustedFrameUrl("https://static.crunchyroll.com/watch/G6VU774M5/embed", TAB), false);
  assert.equal(isTrustedFrameUrl("https://evil.example/watch/G6VU774M5", TAB), false);
});

// Mutation: change the host regex to /crunchyroll\.com/ without the (^|\.) boundary.
test("isTrustedFrameUrl rejects a look-alike host", () => {
  const lookalike = "https://www.crunchyroll.com.evil.com/watch/G6VU774M5";
  assert.equal(isTrustedFrameUrl(lookalike, lookalike), false);
});

// Mutation: drop the https protocol check.
test("isTrustedFrameUrl rejects a non-https frame", () => {
  assert.equal(isTrustedFrameUrl("http://www.crunchyroll.com/watch/G6VU774M5", TAB), false);
  const httpTab = "http://www.crunchyroll.com/watch/G6VU774M5";
  assert.equal(isTrustedFrameUrl(httpTab, httpTab), false);
});

// Mutation: make resolveTab's pick(field) read from the newest frame instead of top.
test("mergeFrame keeps top metadata separate from the iframe's video truth", () => {
  const entry = newEntry();
  mergeFrame(entry, topFrame(), 1000);
  mergeFrame(entry, videoFrame(), 1100);
  const resolved = resolveTab(entry, 1100);

  assert.equal(resolved.series, "Series Name");
  assert.equal(resolved.episodeTitle, "Episode Name");
  assert.equal(resolved.seasonNumber, 1);
  assert.equal(resolved.position, 42);
  assert.equal(resolved.duration, 1440);
  assert.equal(resolved.paused, false);
  assert.equal(resolved.hasVideo, true);
  assert.equal(entry.top.position, null, "top must not inherit video fields");
  assert.equal(entry.frames[3].series, null, "iframe must not inherit top metadata");
});

// Mutation: make mergeFrame clear entry.top when a frame reports hasVideo:false.
test("a frame reporting hasVideo:false does not erase the series title", () => {
  const entry = newEntry();
  mergeFrame(entry, topFrame(), 1000);
  mergeFrame(entry, videoFrame({ hasVideo: false, duration: null, position: null }), 1100);
  const resolved = resolveTab(entry, 1100);
  assert.equal(resolved.series, "Series Name");
  assert.equal(resolved.episodeTitle, "Episode Name");
  assert.equal(resolved.hasVideo, false);
});

// Mutation: make any gone scope return "delete" (drop the whole tab entry).
test("applyGoneToEntry with frame scope removes only the reported frame", () => {
  const entry = newEntry();
  mergeFrame(entry, topFrame(), 1000);
  mergeFrame(entry, videoFrame(), 1100);
  mergeFrame(entry, videoFrame({ frameId: 5, receivedAt: 1200 }), 1200);

  assert.equal(applyGoneToEntry(entry, 3, "frame", 1200), entry);
  assert.deepEqual(Object.keys(entry.frames), ["5"]);
  assert.equal(entry.top.series, "Series Name");
  assert.equal(entry.updatedAt, 1200, "gone must not bump updatedAt");
  assert.equal(applyGoneToEntry(entry, 5, "frame", 1200), entry);
  assert.equal(applyGoneToEntry(entry, 0, "frame", 1200), "delete");
});

// Mutation: treat scope "tab" like "frame" (return the entry instead of "delete").
test("applyGoneToEntry with tab scope clears the whole entry", () => {
  const entry = newEntry();
  mergeFrame(entry, topFrame(), 1000);
  mergeFrame(entry, videoFrame(), 1100);
  assert.equal(applyGoneToEntry(entry, 0, "tab", 1200), "delete");
});
