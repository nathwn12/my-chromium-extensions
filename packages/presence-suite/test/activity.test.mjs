import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildActivity as buildYoutube,
  clampText as clampYoutube,
  pickButtonUrl as pickYoutubeButton,
} from "../activity.js";
import {
  buildActivity as buildCrunchy,
  clampText as clampCrunchy,
  pickButtonUrl as pickCrunchyButton,
} from "../sources/crunchy/activity.js";

const NOW = 1700000000000;
const SEC = Math.floor(NOW / 1000);

// Mutation: remove the text.slice(0, max) cap from youtube clampText.
test("youtube activity: title and state hard-cap at 128 chars; short titles are unshowable", () => {
  const activity = buildYoutube({ title: "T".repeat(300), channel: "C".repeat(300) }, NOW);
  assert.equal(activity.details.length, 128);
  assert.equal(activity.state.length, 128);
  assert.equal(clampYoutube("A".repeat(200)).length, 128);
  assert.equal(clampYoutube("A"), null);
  assert.equal(buildYoutube({ title: "A" }, NOW), null);
});

// Mutation: replace Math.floor(duration) with a rate-scaled duration for seconds.
test("youtube activity: start/end maths at position 0 and mid-episode keep the real duration", () => {
  const base = { title: "Song", channel: "Artist", paused: false, duration: 240, at: NOW };
  const atZero = buildYoutube({ ...base, position: 0 }, NOW);
  assert.deepEqual(atZero.timestamps, { start: SEC, end: SEC + 240 });
  const mid = buildYoutube({ ...base, position: 60 }, NOW);
  assert.deepEqual(mid.timestamps, { start: SEC - 60, end: SEC + 180 });
  assert.equal(mid.timestamps.end - mid.timestamps.start, 240);
});

// Mutation: change the repeat-boundary test from >= to >.
test("youtube activity: at/past the end the start rolls over, end stays future, total stays real", () => {
  const base = { title: "Song", channel: "Artist", paused: false, duration: 240, at: NOW };
  for (const position of [240, 300, 10000]) {
    const activity = buildYoutube({ ...base, position }, NOW);
    assert.deepEqual(activity.timestamps, { start: SEC, end: SEC + 240 }, "position " + position);
    assert.ok(activity.timestamps.end > SEC);
    assert.equal(activity.timestamps.end - activity.timestamps.start, 240);
  }
});

// Mutation: drop "if (!details) return null" from youtube buildActivity.
test("youtube activity: null when there is nothing showable", () => {
  assert.equal(buildYoutube(null, NOW), null);
  assert.equal(buildYoutube({ title: "   " }, NOW), null);
  assert.equal(buildYoutube("crunchy", { title: "Song" }, NOW), null);
});

// Mutation: change "else if (artistUrl)" to "if (artistUrl)", emitting three buttons.
test("youtube activity: at most two buttons, https and music host only", () => {
  assert.equal(pickYoutubeButton("http://music.youtube.com/watch?v=abc12345678"), null);
  assert.equal(pickYoutubeButton("https://music.youtube.com.evil.com/watch?v=abc12345678"), null);
  const activity = buildYoutube({
    title: "Song",
    channel: "Artist",
    trackUrl: "https://music.youtube.com/watch?v=abc12345678",
    albumUrl: "https://music.youtube.com/browse/MPREabc",
    artistUrl: "https://music.youtube.com/channel/UCabc123",
    pageUrl: "https://music.youtube.com/browse/MPREabc",
  }, NOW);
  assert.equal(activity.buttons.length, 2);
  assert.deepEqual(activity.buttons.map((button) => button.label), [
    "Listen on YouTube Music",
    "View album",
  ]);
  for (const button of activity.buttons) {
    assert.match(button.url, /^https:\/\/music\.youtube\.com\//);
  }
  const httpOnly = buildYoutube({
    title: "Song",
    trackUrl: "http://music.youtube.com/watch?v=abc12345678",
    pageUrl: "http://music.youtube.com/watch?v=abc12345678",
    albumUrl: "http://music.youtube.com/browse/MPREabc",
  }, NOW);
  assert.equal(httpOnly.buttons, undefined);
});

// Mutation: remove the 128-char slice in the crunchy clampText.
test("crunchy activity: title and state clamp to 128, empty titles are unshowable", () => {
  assert.equal(clampCrunchy("A".repeat(200)).length, 128);
  assert.equal(clampCrunchy("A"), null);
  const activity = buildCrunchy({ series: "S".repeat(200), episodeTitle: "E".repeat(200) }, NOW);
  assert.equal(activity.details.length, 128);
  assert.ok(activity.state.length <= 128);
  assert.equal(buildCrunchy({ series: null, episodeTitle: " " }, NOW), null);
});

// Mutation: emit the raw synopsis instead of smartTruncate's capped state line.
test("crunchy activity: synopsis option keeps state within 128 chars", () => {
  const long = "First sentence. " + "more words ".repeat(20);
  const activity = buildCrunchy(
    { series: "Series", seasonNumber: 1, episodeNumber: 5, synopsis: long },
    NOW,
    { synopsis: true }
  );
  assert.equal(activity.type, 3);
  assert.equal(activity.details, "Series · S1 E5");
  assert.ok(activity.state.length <= 128);
  assert.ok(activity.state.endsWith("…"));
});

// Mutation: use durationSec as the fallback when position is missing instead of 0.
test("crunchy activity: start/end maths at 0 and mid-episode keep the real duration", () => {
  const base = { series: "Series", paused: false, duration: 240 };
  const zero = buildCrunchy({ ...base, position: 0 }, NOW);
  assert.deepEqual(zero.timestamps, { start: NOW, end: NOW + 240000 });
  const mid = buildCrunchy({ ...base, position: 60 }, NOW);
  assert.deepEqual(mid.timestamps, { start: NOW - 60000, end: NOW + 180000 });
  assert.equal(mid.timestamps.end - mid.timestamps.start, 240000);
});

// Mutation: drop Math.min(reportedSec, durationSec - 1) and use reportedSec directly.
test("crunchy activity: at/past the end the end stays future and the total stays the real duration", () => {
  for (const position of [240, 300, 10000]) {
    const activity = buildCrunchy(
      { series: "Series", paused: false, duration: 240, position },
      NOW
    );
    assert.equal(activity.timestamps.end - activity.timestamps.start, 240000, "position " + position);
    assert.ok(activity.timestamps.end > NOW, "position " + position);
  }
});

// Mutation: drop "if (!details) return null" from crunchy buildActivity.
test("crunchy activity: null when no series or episode title is showable", () => {
  assert.equal(buildCrunchy(null, NOW), null);
  assert.equal(buildCrunchy({}, NOW), null);
  assert.equal(buildCrunchy({ series: " ", episodeTitle: null }, NOW), null);
});

// Mutation: raise the buttons.slice(0, 2) cap to 3 and add a pageUrl button.
test("crunchy activity: at most two buttons and https crunchyroll URLs only", () => {
  assert.equal(pickCrunchyButton("http://www.crunchyroll.com/watch/G6VU774M5/x"), null);
  assert.equal(pickCrunchyButton("https://evil.example/watch/G6VU774M5"), null);
  const both = buildCrunchy({
    series: "Series",
    seriesUrl: "https://www.crunchyroll.com/series/G6VU774M5",
    episodeUrl: "https://www.crunchyroll.com/watch/G6VU774M5/x",
    pageUrl: "https://www.crunchyroll.com/watch/G6VU774M5/y",
  }, NOW);
  assert.equal(both.buttons.length, 2);
  assert.deepEqual(both.buttons.map((button) => button.label), ["Watch Episode", "View Series"]);
  for (const button of both.buttons) {
    assert.match(button.url, /^https:\/\/[^/]*crunchyroll\.com\//);
  }
  const one = buildCrunchy({
    series: "Series",
    episodeUrl: "https://www.crunchyroll.com/watch/G6VU774M5/x",
  }, NOW);
  assert.deepEqual(one.buttons.map((button) => button.label), ["Watch on Crunchyroll"]);
});
