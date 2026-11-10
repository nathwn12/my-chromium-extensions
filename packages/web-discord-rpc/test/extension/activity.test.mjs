import test from "node:test";
import assert from "node:assert/strict";

import { buildActivity, clampText } from "../../activity.js";

const NOW = 1_700_000_000_123;
const SECOND = 1000;

function youtubeState(overrides = {}) {
  return {
    title: "Big Buck Bunny 60fps 4K — Official Blender Foundation Short Film",
    channel: "Blender",
    album: null,
    artworkUrl: "https://i.ytimg.com/vi/aqz-KE-bpKQ/maxresdefault.jpg",
    pageUrl: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
    mediaId: "aqz-KE-bpKQ",
    duration: 634.601,
    position: 12.7,
    paused: false,
    playbackRate: 1,
    visible: true,
    ...overrides,
  };
}

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

test("a YouTube watch page becomes a WATCHING card", () => {
  const activity = buildActivity("youtube", youtubeState(), NOW);
  assert.deepEqual(activity, {
    name: "YouTube",
    type: 3,
    details: "Big Buck Bunny 60fps 4K — Official Blender Foundation Short Film",
    state: "Blender",
    assets: {
      large_image: "https://i.ytimg.com/vi/aqz-KE-bpKQ/maxresdefault.jpg",
      large_text: "Big Buck Bunny 60fps 4K — Official Blender Foundation Short Film",
    },
    buttons: [{ label: "Watch on YouTube", url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ" }],
    timestamps: {
      start: 1_700_000_000_000 - 12 * SECOND,
      end: 1_700_000_000_000 - 12 * SECOND + 634 * SECOND,
    },
  });
});

test("a YouTube Music track becomes a LISTENING card", () => {
  const activity = buildActivity("youtube-music", musicState(), NOW);
  assert.deepEqual(activity, {
    name: "An Artist",
    type: 2,
    details: "A Song",
    state: "An Album",
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

test("the album is optional and the artist names the card", () => {
  const withArtist = buildActivity("youtube-music", musicState({ album: null }), NOW);
  assert.equal(withArtist.name, "An Artist");
  assert.equal(withArtist.state, "YouTube Music");
  assert.equal(withArtist.assets.large_text, "A Song");

  const bare = buildActivity("youtube-music", musicState({ channel: null, album: null, artworkUrl: null }), NOW);
  assert.equal(bare.name, "YouTube Music");
  assert.equal(bare.state, "YouTube Music");
  assert.equal("assets" in bare, false);
});

test("without an artist the Music card keeps the source label and the old state", () => {
  const activity = buildActivity("youtube-music", musicState({ channel: null }), NOW);
  assert.equal(activity.name, "YouTube Music");
  assert.equal(activity.state, "YouTube Music — An Album");
});

test("the channel falls back to the source label for YouTube", () => {
  const activity = buildActivity("youtube", youtubeState({ channel: null }), NOW);
  assert.equal(activity.state, "YouTube");
});

test("no title, unknown source or no state means no activity", () => {
  assert.equal(buildActivity("youtube", youtubeState({ title: null }), NOW), null);
  assert.equal(buildActivity("youtube", youtubeState({ title: "   " }), NOW), null);
  assert.equal(buildActivity("youtube", youtubeState({ title: "x" }), NOW), null);
  assert.equal(buildActivity("crunchyroll", youtubeState(), NOW), null);
  assert.equal(buildActivity("youtube", null, NOW), null);
});

test("details cap at 128 characters", () => {
  const activity = buildActivity("youtube", youtubeState({ title: "a".repeat(200) }), NOW);
  assert.equal(activity.details.length, 128);
});

test("assets are omitted without an https artwork URL", () => {
  const activity = buildActivity("youtube", youtubeState({ artworkUrl: "http://i.ytimg.com/x.jpg" }), NOW);
  assert.equal("assets" in activity, false);
});

test("buttons are omitted unless the page URL is https on the source host", () => {
  for (const pageUrl of [
    null,
    "http://www.youtube.com/watch?v=1",
    "https://music.youtube.com/watch?v=1",
    "https://evil.example/watch?v=1",
    "not a url",
    `https://www.youtube.com/watch?v=${"a".repeat(500)}`,
  ]) {
    const activity = buildActivity("youtube", youtubeState({ pageUrl }), NOW);
    assert.equal("buttons" in activity, false, `expected no buttons for ${pageUrl}`);
  }

  const music = buildActivity("youtube-music", musicState({ pageUrl: "https://www.youtube.com/watch?v=1" }), NOW);
  assert.equal("buttons" in music, false);
});

test("timestamps need playing, a duration and a real position", () => {
  assert.equal("timestamps" in buildActivity("youtube", youtubeState({ paused: true }), NOW), false);
  assert.equal("timestamps" in buildActivity("youtube", youtubeState({ paused: undefined }), NOW), false);
  assert.equal("timestamps" in buildActivity("youtube", youtubeState({ duration: 0 }), NOW), false);
  assert.equal("timestamps" in buildActivity("youtube", youtubeState({ duration: null }), NOW), false);
});

test("timestamps clamp the position into the duration", () => {
  const past = buildActivity("youtube", youtubeState({ position: 700 }), NOW);
  assert.equal(past.timestamps.start, 1_700_000_000_000 - 634 * SECOND);
  assert.equal(past.timestamps.end, 1_700_000_000_000);

  const negative = buildActivity("youtube", youtubeState({ position: -5 }), NOW);
  assert.equal(negative.timestamps.start, 1_700_000_000_000);
  assert.equal(negative.timestamps.end, 1_700_000_000_000 + 634 * SECOND);
});

test("clampText collapses whitespace, rejects short text and caps length", () => {
  assert.equal(clampText("  a   b  "), "a b");
  assert.equal(clampText("a"), null);
  assert.equal(clampText(""), null);
  assert.equal(clampText(null), null);
  assert.equal(clampText("word ".repeat(50)).length, 128);
});
