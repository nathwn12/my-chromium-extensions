import test from "node:test";
import assert from "node:assert/strict";

import { STATUS_DISPLAY_STATE, buildActivity, clampText } from "../../activity.js";

const NOW = 1_700_000_000_123;
const SECOND = 1000;

function musicState(overrides = {}) {
  return {
    title: "A Song",
    channel: "An Artist",
    album: "An Album",
    artworkUrl: "https://lh3.googleusercontent.com/cover",
    pageUrl: "https://music.youtube.com/watch?v=song123",
    mediaId: "song123",
    duration: 200,
    position: 5,
    paused: false,
    playbackRate: 1,
    visible: true,
    ...overrides,
  };
}

test("a YouTube Music track becomes a LISTENING card under the YouTube Music header", () => {
  const activity = buildActivity("youtube-music", musicState(), NOW);
  assert.deepEqual(activity, {
    name: "YouTube Music",
    type: 2,
    details: "A Song",
    state: "An Artist",
    status_display_type: 1,
    assets: {
      large_image: "https://lh3.googleusercontent.com/cover",
      large_text: "An Album",
    },
    buttons: [{ label: "Listen on YouTube Music", url: "https://music.youtube.com/watch?v=song123" }],
    timestamps: {
      start: 1_700_000_000_000 - 5 * SECOND,
      end: 1_700_000_000_000 - 5 * SECOND + 200 * SECOND,
    },
  });
});

test("the member-list line shows the artist: state is the artist and status_display_type is 1", () => {
  const activity = buildActivity(musicState(), NOW);
  assert.equal(activity.details, "A Song");
  assert.equal(activity.state, "An Artist");
  assert.equal(activity.status_display_type, STATUS_DISPLAY_STATE);
  assert.equal(activity.status_display_type, 1);
  assert.equal(activity.name, "YouTube Music");
});

test("the screenshot shape holds: header is static, second line is the artist, no duplicate album line", () => {
  const activity = buildActivity(
    "youtube-music",
    musicState({
      title: "Call Your Name",
      channel: "Hiroyuki Sawano, mpi, & CASG",
      album: "TV Anime “Attack on Titan” Original Soundtrack",
    }),
    NOW
  );
  assert.equal(activity.name, "YouTube Music");
  assert.equal(activity.details, "Call Your Name");
  assert.equal(activity.state, "Hiroyuki Sawano, mpi, & CASG");
  assert.equal(activity.status_display_type, 1);
  assert.equal(activity.assets.large_text, "TV Anime “Attack on Titan” Original Soundtrack");
  assert.notEqual(activity.state, activity.assets.large_text);
});

test("the artist stays the visible line and the album is tooltip-only", () => {
  const withArtist = buildActivity("youtube-music", musicState({ album: null }), NOW);
  assert.equal(withArtist.name, "YouTube Music");
  assert.equal(withArtist.state, "An Artist");
  assert.equal(withArtist.status_display_type, 1);
  assert.equal("large_text" in withArtist.assets, false);

  const bare = buildActivity("youtube-music", musicState({ channel: null, album: null, artworkUrl: null }), NOW);
  assert.equal(bare.name, "YouTube Music");
  assert.equal(bare.state, "YouTube Music");
  assert.equal("assets" in bare, false);
});

test("without an artist the Music card falls back to the album, then the source label", () => {
  const albumOnly = buildActivity("youtube-music", musicState({ channel: null }), NOW);
  assert.equal(albumOnly.name, "YouTube Music");
  assert.equal(albumOnly.state, "An Album");
  assert.equal(albumOnly.status_display_type, 1);
});

test("no title or no state means no activity; legacy YouTube reports are refused", () => {
  assert.equal(buildActivity("youtube-music", musicState({ title: null }), NOW), null);
  assert.equal(buildActivity("youtube-music", musicState({ title: "   " }), NOW), null);
  assert.equal(buildActivity("youtube-music", musicState({ title: "x" }), NOW), null);
  assert.equal(buildActivity("youtube", musicState(), NOW), null);
  assert.equal(buildActivity("crunchyroll", musicState(), NOW), null);
  assert.equal(buildActivity("youtube-music", null, NOW), null);
});

test("details cap at 128 characters", () => {
  const activity = buildActivity("youtube-music", musicState({ title: "a".repeat(200) }), NOW);
  assert.equal(activity.details.length, 128);
});

test("assets are omitted without an https artwork URL", () => {
  const activity = buildActivity("youtube-music", musicState({ artworkUrl: "http://lh3.googleusercontent.com/x.jpg" }), NOW);
  assert.equal("assets" in activity, false);
});

test("buttons are omitted unless the page URL is https on the Music host", () => {
  for (const pageUrl of [
    null,
    "http://music.youtube.com/watch?v=1",
    "https://www.youtube.com/watch?v=1",
    "https://evil.example/watch?v=1",
    "not a url",
    "https://music.youtube.com/watch?v=1",
  ]) {
    const last = pageUrl === "https://music.youtube.com/watch?v=1";
    const activity = buildActivity("youtube-music", musicState({ pageUrl }), NOW);
    assert.equal("buttons" in activity, last, `expected ${last ? "buttons" : "no buttons"} for ${pageUrl}`);
    if (last) assert.equal(activity.status_display_type, 1);
  }

  const long = buildActivity(
    "youtube-music",
    musicState({ pageUrl: `https://music.youtube.com/watch?v=${"a".repeat(500)}` }),
    NOW
  );
  assert.equal("buttons" in long, false);
});

test("timestamps need playing, a duration and a real position", () => {
  assert.equal("timestamps" in buildActivity("youtube-music", musicState({ paused: true }), NOW), false);
  assert.equal("timestamps" in buildActivity("youtube-music", musicState({ paused: undefined }), NOW), false);
  assert.equal("timestamps" in buildActivity("youtube-music", musicState({ duration: 0 }), NOW), false);
  assert.equal("timestamps" in buildActivity("youtube-music", musicState({ duration: null }), NOW), false);
  assert.equal("timestamps" in buildActivity("youtube-music", musicState({ position: null }), NOW), false);
});

test("timestamps clamp the position into the duration", () => {
  const past = buildActivity("youtube-music", musicState({ position: 700 }), NOW);
  assert.equal(past.timestamps.start, 1_700_000_000_000 - 200 * SECOND);
  assert.equal(past.timestamps.end, 1_700_000_000_000);
  assert.equal(past.status_display_type, 1);

  const negative = buildActivity("youtube-music", musicState({ position: -5 }), NOW);
  assert.equal(negative.timestamps.start, 1_700_000_000_000);
  assert.equal(negative.timestamps.end, 1_700_000_000_000 + 200 * SECOND);
});

test("elapsed/end come from the real media clock: audio-backed playback still stamps time", () => {
  // Regression: the extractor reads <audio> as well as <video>, so a song
  // backed by an audio element keeps its position/duration and this builder
  // stamps start/end from those real numbers — never invented.
  const activity = buildActivity(
    musicState({ duration: 184.2, position: 42.9, paused: false }),
    NOW
  );
  assert.ok("timestamps" in activity, "playing audio with a duration must stamp time");
  assert.equal(activity.timestamps.start, 1_700_000_000_000 - 42 * SECOND);
  assert.equal(activity.timestamps.end, 1_700_000_000_000 - 42 * SECOND + 184 * SECOND);
  assert.ok(activity.timestamps.end > activity.timestamps.start);
});

test("clampText collapses whitespace, rejects short text and caps length", () => {
  assert.equal(clampText("  a   b  "), "a b");
  assert.equal(clampText("a"), null);
  assert.equal(clampText(""), null);
  assert.equal(clampText(null), null);
  assert.equal(clampText("word ".repeat(50)).length, 128);
});
