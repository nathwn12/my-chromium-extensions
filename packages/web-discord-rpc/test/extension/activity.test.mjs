import test from "node:test";
import assert from "node:assert/strict";

import {
  STATUS_DISPLAY_STATE,
  buildActivity,
  clampText,
  pickLinkUrl,
} from "../../activity.js";

const NOW = 1_700_000_000_123;
const NOW_SECONDS = Math.floor(NOW / 1000);

function musicState(overrides = {}) {
  return {
    title: "A Song",
    channel: "An Artist",
    album: "An Album",
    artworkUrl: "https://lh3.googleusercontent.com/cover",
    pageUrl: "https://music.youtube.com/watch?v=song123",
    trackUrl: "https://music.youtube.com/watch?v=song123",
    artistUrl: "https://music.youtube.com/channel/UCartist",
    albumUrl: "https://music.youtube.com/browse/MPREb_album",
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
    details_url: "https://music.youtube.com/watch?v=song123",
    state: "An Artist",
    state_url: "https://music.youtube.com/channel/UCartist",
    status_display_type: 1,
    assets: {
      large_image: "https://lh3.googleusercontent.com/cover",
      large_text: "An Album",
      large_url: "https://music.youtube.com/browse/MPREb_album",
    },
    buttons: [
      { label: "Listen on YouTube Music", url: "https://music.youtube.com/watch?v=song123" },
      { label: "View album", url: "https://music.youtube.com/browse/MPREb_album" },
    ],
    timestamps: {
      start: NOW_SECONDS - 5,
      end: NOW_SECONDS - 5 + 200,
    },
  });
});

test("the payload keys keep the documented order", () => {
  const activity = buildActivity("youtube-music", musicState(), NOW);
  assert.deepEqual(Object.keys(activity), [
    "name",
    "type",
    "details",
    "details_url",
    "state",
    "state_url",
    "status_display_type",
    "assets",
    "buttons",
    "timestamps",
  ]);
  assert.deepEqual(Object.keys(activity.assets), ["large_image", "large_text", "large_url"]);
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
  const withArtist = buildActivity("youtube-music", musicState({ album: null, albumUrl: null }), NOW);
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
  const albumOnly = buildActivity("youtube-music", musicState({ channel: null, artistUrl: null }), NOW);
  assert.equal(albumOnly.name, "YouTube Music");
  assert.equal(albumOnly.state, "An Album");
  assert.equal(albumOnly.status_display_type, 1);
});

test("an album-fallback state line opens the album, never a borrowed artist link", () => {
  const albumOnly = buildActivity("youtube-music", musicState({ channel: null, artistUrl: null }), NOW);
  assert.equal(albumOnly.state, "An Album");
  assert.equal(albumOnly.state_url, "https://music.youtube.com/browse/MPREb_album");

  // An artist URL must not be borrowed when the line is the album.
  const withStrayArtist = buildActivity(
    "youtube-music",
    musicState({ channel: null, artistUrl: "https://music.youtube.com/channel/UCother" }),
    NOW
  );
  assert.equal(withStrayArtist.state, "An Album");
  assert.equal(withStrayArtist.state_url, "https://music.youtube.com/browse/MPREb_album");

  // No album link: the album line carries no link at all.
  const albumTextOnly = buildActivity(
    "youtube-music",
    musicState({ channel: null, albumUrl: null }),
    NOW
  );
  assert.equal(albumTextOnly.state, "An Album");
  assert.equal("state_url" in albumTextOnly, false);
});

test("a label state line carries no state_url", () => {
  const activity = buildActivity(
    "youtube-music",
    musicState({ title: "An Artist", channel: "An Artist", album: null, albumUrl: null }),
    NOW
  );
  assert.equal(activity.state, "YouTube Music");
  assert.equal("state_url" in activity, false);
  assert.equal(activity.assets.large_url, "https://music.youtube.com/channel/UCartist");
});

test("a track with no album links the artist from the state line, the art and button 2", () => {
  const activity = buildActivity(
    "youtube-music",
    musicState({ album: null, albumUrl: null }),
    NOW
  );
  assert.equal(activity.state, "An Artist");
  assert.equal(activity.state_url, "https://music.youtube.com/channel/UCartist");
  assert.equal(activity.assets.large_url, "https://music.youtube.com/channel/UCartist");
  assert.deepEqual(activity.buttons, [
    { label: "Listen on YouTube Music", url: "https://music.youtube.com/watch?v=song123" },
    { label: "View artist", url: "https://music.youtube.com/channel/UCartist" },
  ]);
});

test("no links: the three url fields are absent and one button remains", () => {
  const watch = "https://music.youtube.com/watch?v=abc12345678";
  const activity = buildActivity(
    "youtube-music",
    musicState({ trackUrl: null, artistUrl: null, albumUrl: null, pageUrl: watch }),
    NOW
  );
  assert.equal("details_url" in activity, false);
  assert.equal("state_url" in activity, false);
  assert.equal("large_url" in activity.assets, false);
  assert.deepEqual(Object.keys(activity.assets), ["large_image", "large_text"]);
  assert.deepEqual(activity.buttons, [
    { label: "Listen on YouTube Music", url: watch },
  ]);
});

test("the listen button never falls back to a page URL that is not a watch page", () => {
  for (const pageUrl of ["https://music.youtube.com/", "https://music.youtube.com/explore"]) {
    const activity = buildActivity(
      "youtube-music",
      musicState({ trackUrl: null, artistUrl: null, albumUrl: null, pageUrl }),
      NOW
    );
    assert.equal("buttons" in activity, false, `expected no buttons for ${pageUrl}`);
  }
});

test("the listen button falls back to a real watch page URL carrying an 11-character v", () => {
  const watch = "https://music.youtube.com/watch?v=abc12345678";
  const activity = buildActivity(
    "youtube-music",
    musicState({ trackUrl: null, artistUrl: null, albumUrl: null, pageUrl: watch }),
    NOW
  );
  assert.deepEqual(activity.buttons, [
    { label: "Listen on YouTube Music", url: watch },
  ]);
});

test("the canonical track URL wins over any page URL", () => {
  for (const pageUrl of [
    "https://music.youtube.com/explore",
    "https://music.youtube.com/watch?v=abc12345678",
    null,
  ]) {
    const activity = buildActivity(
      "youtube-music",
      musicState({
        trackUrl: "https://music.youtube.com/watch?v=song123",
        artistUrl: null,
        albumUrl: null,
        pageUrl,
      }),
      NOW
    );
    assert.deepEqual(activity.buttons, [
      { label: "Listen on YouTube Music", url: "https://music.youtube.com/watch?v=song123" },
    ]);
  }
});

test("a watch page URL whose v is not 11 characters is not a song", () => {
  for (const v of ["abc1234567", "abc123456789", ""]) {
    const activity = buildActivity(
      "youtube-music",
      musicState({ trackUrl: null, artistUrl: null, albumUrl: null, pageUrl: `https://music.youtube.com/watch?v=${v}` }),
      NOW
    );
    assert.equal("buttons" in activity, false, `expected no buttons for v=${v}`);
  }
});

test("a track URL over the 256-character link cap is omitted", () => {
  const long = `https://music.youtube.com/watch?v=${"a".repeat(300)}`;
  const watch = "https://music.youtube.com/watch?v=abc12345678";
  const activity = buildActivity(
    "youtube-music",
    musicState({ trackUrl: long, pageUrl: watch }),
    NOW
  );
  assert.equal("details_url" in activity, false);
  // Button 1 falls back to the page URL, which is still a usable track link.
  assert.equal(activity.buttons[0].url, watch);
});

test("a link that leaves the Music host is omitted, never emitted bare", () => {
  const offHost = buildActivity(
    "youtube-music",
    musicState({ artistUrl: "https://www.youtube.com/channel/UCx" }),
    NOW
  );
  assert.equal("state_url" in offHost, false);
  assert.equal(offHost.assets.large_url, "https://music.youtube.com/browse/MPREb_album");
  assert.deepEqual(offHost.buttons, [
    { label: "Listen on YouTube Music", url: "https://music.youtube.com/watch?v=song123" },
    { label: "View album", url: "https://music.youtube.com/browse/MPREb_album" },
  ]);

  const insecure = buildActivity(
    "youtube-music",
    musicState({ trackUrl: "http://music.youtube.com/watch?v=song123" }),
    NOW
  );
  assert.equal("details_url" in insecure, false);

  const junk = buildActivity(
    "youtube-music",
    musicState({ trackUrl: "not a url", albumUrl: "/browse/MPREb_album" }),
    NOW
  );
  assert.equal("details_url" in junk, false);
  assert.equal(junk.assets.large_url, "https://music.youtube.com/channel/UCartist");
});

test("pickLinkUrl validates host, scheme and the 256-character cap", () => {
  const base = "https://music.youtube.com/watch?v=";
  assert.equal(pickLinkUrl(`${base}song123`), `${base}song123`);
  assert.equal(pickLinkUrl(base), base);

  const atCap = `${base}${"a".repeat(256 - base.length)}`;
  assert.equal(atCap.length, 256);
  assert.equal(pickLinkUrl(atCap), atCap);

  const overCap = `${base}${"a".repeat(257 - base.length)}`;
  assert.equal(overCap.length, 257);
  assert.equal(pickLinkUrl(overCap), null);

  assert.equal(pickLinkUrl("http://music.youtube.com/watch?v=1"), null);
  assert.equal(pickLinkUrl("https://www.youtube.com/watch?v=1"), null);
  assert.equal(pickLinkUrl("https://evil.example/watch?v=1"), null);
  assert.equal(pickLinkUrl("/watch?v=1"), null);
  assert.equal(pickLinkUrl(""), null);
  assert.equal(pickLinkUrl(null), null);
  assert.equal(pickLinkUrl(undefined), null);
});

test("no title or no state means no activity; legacy YouTube reports are refused", () => {
  assert.equal(buildActivity("youtube-music", musicState({ title: null }), NOW), null);
  assert.equal(buildActivity("youtube-music", musicState({ title: "   " }), NOW), null);
  assert.equal(buildActivity("youtube-music", musicState({ title: "x" }), NOW), null);
  assert.equal(buildActivity("youtube", musicState(), NOW), null);
  assert.equal(buildActivity("crunchyroll", musicState(), NOW), null);
  assert.equal(buildActivity("youtube-music", null, NOW), null);
});

test("details and state cap at 128 characters", () => {
  const activity = buildActivity("youtube-music", musicState({ title: "a".repeat(200) }), NOW);
  assert.equal(activity.details.length, 128);

  const longArtist = buildActivity(
    "youtube-music",
    musicState({ channel: "b".repeat(200) }),
    NOW
  );
  assert.equal(longArtist.state.length, 128);
});

test("assets are omitted without an https artwork URL", () => {
  const activity = buildActivity("youtube-music", musicState({ artworkUrl: "http://lh3.googleusercontent.com/x.jpg" }), NOW);
  assert.equal("assets" in activity, false);
});

test("buttons are omitted unless the page URL is https on the Music host", () => {
  const watch = "https://music.youtube.com/watch?v=abc12345678";
  for (const pageUrl of [
    null,
    "http://music.youtube.com/watch?v=abc12345678",
    "https://www.youtube.com/watch?v=abc12345678",
    "https://evil.example/watch?v=abc12345678",
    "not a url",
    watch,
  ]) {
    const last = pageUrl === watch;
    const activity = buildActivity(
      "youtube-music",
      musicState({ pageUrl, trackUrl: null, artistUrl: null, albumUrl: null }),
      NOW
    );
    assert.equal("buttons" in activity, last, `expected ${last ? "buttons" : "no buttons"} for ${pageUrl}`);
    if (last) assert.equal(activity.status_display_type, 1);
  }

  const long = buildActivity(
    "youtube-music",
    musicState({
      pageUrl: `https://music.youtube.com/watch?v=${"a".repeat(500)}`,
      trackUrl: null,
      artistUrl: null,
      albumUrl: null,
    }),
    NOW
  );
  assert.equal("buttons" in long, false);
});

test("an album link still gets a button when the page URL is not usable", () => {
  const activity = buildActivity(
    "youtube-music",
    musicState({ trackUrl: null, artistUrl: null, pageUrl: "https://evil.example/watch?v=1" }),
    NOW
  );
  assert.deepEqual(activity.buttons, [
    { label: "View album", url: "https://music.youtube.com/browse/MPREb_album" },
  ]);
});

test("at most two buttons: album wins over artist for button 2", () => {
  const activity = buildActivity("youtube-music", musicState(), NOW);
  assert.equal(activity.buttons.length, 2);
  assert.equal(activity.buttons[1].label, "View album");

  const artistOnly = buildActivity("youtube-music", musicState({ albumUrl: null }), NOW);
  assert.equal(artistOnly.buttons.length, 2);
  assert.equal(artistOnly.buttons[1].label, "View artist");
});

test("timestamps need playing, a duration and a real position", () => {
  assert.equal("timestamps" in buildActivity("youtube-music", musicState({ paused: true }), NOW), false);
  assert.equal("timestamps" in buildActivity("youtube-music", musicState({ paused: undefined }), NOW), false);
  assert.equal("timestamps" in buildActivity("youtube-music", musicState({ duration: 0 }), NOW), false);
  assert.equal("timestamps" in buildActivity("youtube-music", musicState({ duration: null }), NOW), false);
  assert.equal("timestamps" in buildActivity("youtube-music", musicState({ position: null }), NOW), false);
});

test("timestamps are integer seconds, never milliseconds", () => {
  const activity = buildActivity("youtube-music", musicState(), NOW);
  assert.equal(activity.timestamps.start, 1_700_000_000 - 5);
  assert.equal(activity.timestamps.end, 1_700_000_000 - 5 + 200);
  assert.ok(Number.isInteger(activity.timestamps.start));
  assert.ok(Number.isInteger(activity.timestamps.end));
  assert.deepEqual(Object.keys(activity.timestamps), ["start", "end"]);
});

test("timestamps clamp the position into the duration", () => {
  const past = buildActivity("youtube-music", musicState({ position: 700 }), NOW);
  assert.equal(past.timestamps.start, 1_700_000_000 - 200);
  assert.equal(past.timestamps.end, 1_700_000_000);
  assert.equal(past.status_display_type, 1);

  const negative = buildActivity("youtube-music", musicState({ position: -5 }), NOW);
  assert.equal(negative.timestamps.start, 1_700_000_000);
  assert.equal(negative.timestamps.end, 1_700_000_000 + 200);
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
  assert.equal(activity.timestamps.start, 1_700_000_000 - 42);
  assert.equal(activity.timestamps.end, 1_700_000_000 - 42 + 184);
  assert.ok(activity.timestamps.end > activity.timestamps.start);
});

const SAMPLE_AT = 1_700_000_000_000;

test("the anchor is the sample instant: a late rebuild yields the same start", () => {
  const sampled = musicState({ position: 40, at: SAMPLE_AT });
  const prompt = buildActivity(sampled, SAMPLE_AT);
  const late = buildActivity(sampled, SAMPLE_AT + 45_000);

  assert.equal(prompt.timestamps.start, Math.floor(SAMPLE_AT / 1000) - 40);
  assert.equal(late.timestamps.start, Math.floor(SAMPLE_AT / 1000) - 40);
  assert.deepEqual(late, prompt, "the payload for one sample is rebuild-stable");
});

test("a state without `at` keeps the passed now as the anchor", () => {
  const activity = buildActivity(musicState({ position: 5 }), SAMPLE_AT + 45_000);
  assert.equal(activity.timestamps.start, Math.floor((SAMPLE_AT + 45_000) / 1000) - 5);
});

test("a sample stamp up to 5 s ahead is trusted, further ahead is ignored for now", () => {
  const ahead = buildActivity(musicState({ position: 5, at: SAMPLE_AT + 5_000 }), SAMPLE_AT);
  assert.equal(ahead.timestamps.start, Math.floor((SAMPLE_AT + 5_000) / 1000) - 5);

  const skewed = buildActivity(musicState({ position: 5, at: SAMPLE_AT + 60_000 }), SAMPLE_AT);
  assert.equal(skewed.timestamps.start, Math.floor(SAMPLE_AT / 1000) - 5);
  assert.equal(
    JSON.stringify(skewed),
    JSON.stringify(buildActivity(musicState({ position: 5 }), SAMPLE_AT)),
    "a future stamp is not a different payload from no stamp at all"
  );
});

test("clampText collapses whitespace, rejects short text and caps length", () => {
  assert.equal(clampText("  a   b  "), "a b");
  assert.equal(clampText("a"), null);
  assert.equal(clampText(""), null);
  assert.equal(clampText(null), null);
  assert.equal(clampText("word ".repeat(50)).length, 128);
});
