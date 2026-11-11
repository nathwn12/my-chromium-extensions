import test from "node:test";
import assert from "node:assert/strict";

import {
  STATUS_DISPLAY_STATE,
  buildActivity,
  clampText,
} from "../../activity.js";

const NOW = 1_700_000_000_123;
const NOW_SECONDS = Math.floor(NOW / 1000);

function musicState(overrides = {}) {
  return {
    title: "A Song",
    channel: "An Artist",
    album: "An Album",
    artworkUrl: "https://lh3.googleusercontent.com/cover",
    pageUrl: "https://music.youtube.com/watch?v=song1234567",
    trackUrl: "https://music.youtube.com/watch?v=song1234567",
    artistUrl: "https://music.youtube.com/channel/UCartist",
    albumUrl: "https://music.youtube.com/browse/MPREb_album",
    mediaId: "song1234567",
    duration: 200,
    position: 5,
    paused: false,
    playbackRate: 1,
    visible: true,
    ...overrides,
  };
}

/** Every key in the payload, nested objects and arrays included. */
function allKeys(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      out.push(key);
      allKeys(nested, out);
    }
  }
  return out;
}

const linkKeys = (activity) => allKeys(activity).filter((key) => key.endsWith("_url"));

/** The complete activity key set; anything else on the payload is a defect. */
const ACTIVITY_KEYS = [
  "assets",
  "buttons",
  "details",
  "name",
  "state",
  "status_display_type",
  "timestamps",
  "type",
];

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
    buttons: [
      { label: "Listen on YouTube Music", url: "https://music.youtube.com/watch?v=song1234567" },
      { label: "View album", url: "https://music.youtube.com/browse/MPREb_album" },
    ],
    timestamps: {
      start: NOW_SECONDS - 5,
      end: NOW_SECONDS - 5 + 200,
    },
  });
  assert.deepEqual(Object.keys(activity).sort(), [
    "assets",
    "buttons",
    "details",
    "name",
    "state",
    "status_display_type",
    "timestamps",
    "type",
  ]);
});

test("the payload keys keep the documented order", () => {
  const activity = buildActivity("youtube-music", musicState(), NOW);
  assert.deepEqual(Object.keys(activity), [
    "name",
    "type",
    "details",
    "state",
    "status_display_type",
    "assets",
    "buttons",
    "timestamps",
  ]);
  assert.deepEqual(Object.keys(activity.assets), ["large_image", "large_text"]);
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

test("the album-fallback line is plain text; button 2 still opens the album", () => {
  const albumOnly = buildActivity("youtube-music", musicState({ channel: null, artistUrl: null }), NOW);
  assert.equal(albumOnly.state, "An Album");
  assert.deepEqual(linkKeys(albumOnly), []);
  assert.deepEqual(albumOnly.buttons, [
    { label: "Listen on YouTube Music", url: "https://music.youtube.com/watch?v=song1234567" },
    { label: "View album", url: "https://music.youtube.com/browse/MPREb_album" },
  ]);

  // An album line without an album link still carries no link at all.
  const albumTextOnly = buildActivity(
    "youtube-music",
    musicState({ channel: null, albumUrl: null }),
    NOW
  );
  assert.equal(albumTextOnly.state, "An Album");
  assert.deepEqual(linkKeys(albumTextOnly), []);
});

test("a label state line is plain text and the card carries no link field", () => {
  const activity = buildActivity(
    "youtube-music",
    musicState({ title: "An Artist", channel: "An Artist", album: null, albumUrl: null }),
    NOW
  );
  assert.equal(activity.state, "YouTube Music");
  assert.deepEqual(linkKeys(activity), []);
});

test("a track with no album keeps the artist line and the View artist button", () => {
  const activity = buildActivity(
    "youtube-music",
    musicState({ album: null, albumUrl: null }),
    NOW
  );
  assert.equal(activity.state, "An Artist");
  assert.deepEqual(linkKeys(activity), []);
  assert.deepEqual(activity.buttons, [
    { label: "Listen on YouTube Music", url: "https://music.youtube.com/watch?v=song1234567" },
    { label: "View artist", url: "https://music.youtube.com/channel/UCartist" },
  ]);
});

test("no links: the card carries no url field and one button remains", () => {
  const watch = "https://music.youtube.com/watch?v=abc12345678";
  const activity = buildActivity(
    "youtube-music",
    musicState({ trackUrl: null, artistUrl: null, albumUrl: null, pageUrl: watch }),
    NOW
  );
  assert.deepEqual(linkKeys(activity), []);
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
        trackUrl: "https://music.youtube.com/watch?v=song1234567",
        artistUrl: null,
        albumUrl: null,
        pageUrl,
      }),
      NOW
    );
    assert.deepEqual(activity.buttons, [
      { label: "Listen on YouTube Music", url: "https://music.youtube.com/watch?v=song1234567" },
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

test("a track URL over the 512-character button cap falls back to the watch page URL", () => {
  const long = `https://music.youtube.com/watch?v=${"a".repeat(500)}`;
  const watch = "https://music.youtube.com/watch?v=abc12345678";
  const activity = buildActivity(
    "youtube-music",
    musicState({ trackUrl: long, pageUrl: watch }),
    NOW
  );
  assert.deepEqual(linkKeys(activity), []);
  // Button 1 falls back to the page URL, which is still a usable track link.
  assert.equal(activity.buttons[0].url, watch);
});

test("a URL that leaves the Music host is omitted, never emitted bare", () => {
  const offHost = buildActivity(
    "youtube-music",
    musicState({ artistUrl: "https://www.youtube.com/channel/UCx" }),
    NOW
  );
  assert.deepEqual(linkKeys(offHost), []);
  assert.deepEqual(offHost.buttons, [
    { label: "Listen on YouTube Music", url: "https://music.youtube.com/watch?v=song1234567" },
    { label: "View album", url: "https://music.youtube.com/browse/MPREb_album" },
  ]);

  const insecure = buildActivity(
    "youtube-music",
    musicState({ trackUrl: "http://music.youtube.com/watch?v=song1234567", pageUrl: null }),
    NOW
  );
  assert.deepEqual(linkKeys(insecure), []);
  assert.deepEqual(insecure.buttons, [
    { label: "View album", url: "https://music.youtube.com/browse/MPREb_album" },
  ]);

  const junk = buildActivity(
    "youtube-music",
    musicState({ trackUrl: "not a url", albumUrl: "/browse/MPREb_album", pageUrl: null }),
    NOW
  );
  assert.deepEqual(linkKeys(junk), []);
  assert.deepEqual(junk.buttons, [
    { label: "View artist", url: "https://music.youtube.com/channel/UCartist" },
  ]);
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

test("a track URL must be a watch page with an 11-character v, or it is not a button", () => {
  // Same-host is not enough: Home, Explore, a channel and a short id are all
  // rejected, and the button simply does not appear.
  for (const trackUrl of [
    "https://music.youtube.com/",
    "https://music.youtube.com/explore",
    "https://music.youtube.com/watch?v=abc1234567",
    "https://music.youtube.com/channel/UCartist",
  ]) {
    const activity = buildActivity(
      "youtube-music",
      musicState({ trackUrl, artistUrl: null, albumUrl: null, pageUrl: null }),
      NOW
    );
    assert.equal("buttons" in activity, false, `expected no button for ${trackUrl}`);
  }

  const valid = buildActivity(
    "youtube-music",
    musicState({
      trackUrl: "https://music.youtube.com/watch?v=abc12345678",
      artistUrl: null,
      albumUrl: null,
      pageUrl: null,
    }),
    NOW
  );
  assert.deepEqual(valid.buttons, [
    { label: "Listen on YouTube Music", url: "https://music.youtube.com/watch?v=abc12345678" },
  ]);
});

test("an album URL must be a /browse/MPRE path, or the View album button does not appear", () => {
  for (const albumUrl of [
    "https://music.youtube.com/",
    "https://music.youtube.com/explore",
    "https://music.youtube.com/browse/VLplaylist",
    "https://music.youtube.com/watch?v=abc12345678",
  ]) {
    const activity = buildActivity("youtube-music", musicState({ albumUrl, artistUrl: null }), NOW);
    assert.deepEqual(
      activity.buttons.map((button) => button.label),
      ["Listen on YouTube Music"],
      `expected no album button for ${albumUrl}`
    );
  }

  // A dropped album URL never becomes another URL: the artist target is its
  // own candidate, decided by the artist URL's shape.
  const droppedAlbum = buildActivity(
    "youtube-music",
    musicState({ albumUrl: "https://music.youtube.com/explore" }),
    NOW
  );
  assert.deepEqual(droppedAlbum.buttons[1], {
    label: "View artist",
    url: "https://music.youtube.com/channel/UCartist",
  });

  const valid = buildActivity("youtube-music", musicState({ artistUrl: null }), NOW);
  assert.deepEqual(valid.buttons[1], {
    label: "View album",
    url: "https://music.youtube.com/browse/MPREb_album",
  });
});

test("an artist URL must be a /channel/ path, or the View artist button does not appear", () => {
  for (const artistUrl of [
    "https://music.youtube.com/",
    "https://music.youtube.com/explore",
    "https://music.youtube.com/watch?v=abc12345678",
    "https://music.youtube.com/browse/MPREb_album",
  ]) {
    const activity = buildActivity("youtube-music", musicState({ albumUrl: null, artistUrl }), NOW);
    assert.deepEqual(
      activity.buttons.map((button) => button.label),
      ["Listen on YouTube Music"],
      `expected no artist button for ${artistUrl}`
    );
  }

  const valid = buildActivity("youtube-music", musicState({ albumUrl: null }), NOW);
  assert.deepEqual(valid.buttons[1], {
    label: "View artist",
    url: "https://music.youtube.com/channel/UCartist",
  });
});

test("at most two buttons: album wins over artist for button 2", () => {
  const activity = buildActivity("youtube-music", musicState(), NOW);
  assert.equal(activity.buttons.length, 2);
  assert.equal(activity.buttons[1].label, "View album");

  const artistOnly = buildActivity("youtube-music", musicState({ albumUrl: null }), NOW);
  assert.equal(artistOnly.buttons.length, 2);
  assert.equal(artistOnly.buttons[1].label, "View artist");
});

test("the two buttons are the only clickable things", () => {
  const both = buildActivity("youtube-music", musicState(), NOW);
  assert.deepEqual(both.buttons.map((button) => button.label), [
    "Listen on YouTube Music",
    "View album",
  ]);

  const artistOnly = buildActivity("youtube-music", musicState({ albumUrl: null }), NOW);
  assert.deepEqual(artistOnly.buttons.map((button) => button.label), [
    "Listen on YouTube Music",
    "View artist",
  ]);

  const neither = buildActivity("youtube-music", musicState({ albumUrl: null, artistUrl: null }), NOW);
  assert.deepEqual(neither.buttons, [
    { label: "Listen on YouTube Music", url: "https://music.youtube.com/watch?v=song1234567" },
  ]);

  // Labels alone would pass an old linked-card payload, so the whole key set
  // is pinned: a reintroduced link field is a new key, and every `*_url` key
  // is banned outright.
  for (const [name, activity] of [
    ["both", both],
    ["artist only", artistOnly],
    ["neither", neither],
  ]) {
    assert.deepEqual(Object.keys(activity).sort(), ACTIVITY_KEYS, `${name} carries an unexpected key`);
    assert.deepEqual(linkKeys(activity), [], `${name} must carry no *_url key`);
    assert.deepEqual(
      activity.buttons.map((button) => Object.keys(button).sort()),
      activity.buttons.map(() => ["label", "url"]),
      `${name} buttons carry only label and url`
    );
  }
});

test("no activity built from any fixture carries a link field", () => {
  const fixtures = [
    ["default", musicState()],
    ["artist only", musicState({ album: null, albumUrl: null })],
    ["album only", musicState({ channel: null, artistUrl: null })],
    ["no urls", musicState({ trackUrl: null, artistUrl: null, albumUrl: null })],
    ["no artwork", musicState({ artworkUrl: null })],
    ["no metadata", musicState({ channel: null, album: null })],
    ["views", musicState({ album: null, albumUrl: null, views: "1,234,567 views" })],
    ["paused", musicState({ paused: true })],
    ["long text", musicState({ title: "a".repeat(200), channel: "b".repeat(200), album: "c".repeat(200) })],
    ["off host", musicState({ artistUrl: "https://www.youtube.com/channel/UCx" })],
  ];
  for (const [name, state] of fixtures) {
    const activity = buildActivity("youtube-music", state, NOW);
    assert.ok(activity, `expected an activity for ${name}`);
    assert.deepEqual(linkKeys(activity), [], `${name} must carry no *_url key`);
  }
});

test("large_text is the album only when it says something the card does not", () => {
  const distinct = buildActivity("youtube-music", musicState(), NOW);
  assert.equal(distinct.assets.large_text, "An Album");

  // The album is the title: line 1 already says it.
  const sameAsTitle = buildActivity(
    "youtube-music",
    musicState({ title: "An Album", album: "An Album" }),
    NOW
  );
  assert.equal("large_text" in sameAsTitle.assets, false);

  // The album is the state line.
  const sameAsState = buildActivity(
    "youtube-music",
    musicState({ channel: null, artistUrl: null, album: "An Artist" }),
    NOW
  );
  assert.equal(sameAsState.state, "An Artist");
  assert.equal("large_text" in sameAsState.assets, false);

  // The album is the app name.
  const sameAsName = buildActivity(
    "youtube-music",
    musicState({ channel: null, artistUrl: null, album: "YouTube Music" }),
    NOW
  );
  assert.equal("large_text" in sameAsName.assets, false);
});

test("large_text falls back to the view count when no album is distinct", () => {
  const activity = buildActivity(
    "youtube-music",
    musicState({ album: null, albumUrl: null, views: "1,234,567 views" }),
    NOW
  );
  assert.equal(activity.state, "An Artist");
  assert.equal(activity.assets.large_text, "1,234,567 views");
});

test("large_text is omitted when there is no distinct album and no views", () => {
  for (const views of [undefined, null, "", "   ", 42]) {
    const activity = buildActivity(
      "youtube-music",
      musicState({ album: null, albumUrl: null, views }),
      NOW
    );
    assert.equal(
      "large_text" in activity.assets,
      false,
      `expected no large_text for views=${JSON.stringify(views)}`
    );
  }
});

test("the title is never the cover tooltip", () => {
  const activity = buildActivity(
    "youtube-music",
    musicState({ title: "A Song", album: "A Song" }),
    NOW
  );
  assert.equal("large_text" in activity.assets, false);

  const withViews = buildActivity(
    "youtube-music",
    musicState({ title: "A Song", album: "A Song", views: "42 views" }),
    NOW
  );
  assert.equal(withViews.assets.large_text, "42 views");
  assert.notEqual(withViews.assets.large_text, withViews.details);
});

test("the view count is tooltip-only when it repeats a visible line", () => {
  // The title owns line 1; a tooltip that repeats it is noise.
  const sameAsTitle = buildActivity(
    "youtube-music",
    musicState({ title: "42 views", album: null, albumUrl: null, views: "42 views" }),
    NOW
  );
  assert.equal(sameAsTitle.details, "42 views");
  assert.equal("large_text" in sameAsTitle.assets, false);

  const sameAsState = buildActivity(
    "youtube-music",
    musicState({ channel: "42 views", album: null, albumUrl: null, views: "42 views" }),
    NOW
  );
  assert.equal(sameAsState.state, "42 views");
  assert.equal("large_text" in sameAsState.assets, false);

  const sameCaseInsensitive = buildActivity(
    "youtube-music",
    musicState({ channel: "42 Views", album: null, albumUrl: null, views: "42 views" }),
    NOW
  );
  assert.equal("large_text" in sameCaseInsensitive.assets, false);

  const sameAsName = buildActivity(
    "youtube-music",
    musicState({ channel: null, album: null, albumUrl: null, views: "YouTube Music" }),
    NOW
  );
  assert.equal(sameAsName.state, "YouTube Music");
  assert.equal("large_text" in sameAsName.assets, false);

  const distinct = buildActivity(
    "youtube-music",
    musicState({ album: null, albumUrl: null, views: "42 views" }),
    NOW
  );
  assert.equal(distinct.assets.large_text, "42 views");
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
