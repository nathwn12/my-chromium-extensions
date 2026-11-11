import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  makePage,
  musicPage,
  audio,
  node,
  jsonLd,
  meta,
  video
} from "./helpers/fake-page.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "..", "extract-youtube.js"), "utf8");

/** extract-youtube.js is a classic content script; evaluate it and grab its exports. */
function loadExtractor() {
  const context = createContext({});
  runInContext(source, context, { filename: "extract-youtube.js" });
  return context.YoutubeExtract;
}

const api = loadExtractor();

/** The extractor runs in a vm realm; round-trip proves the payload is serializable. */
function read(doc, nav, loc) {
  return JSON.parse(JSON.stringify(api.read(doc, nav, loc)));
}

const MUSIC_WATCH = "https://music.youtube.com/watch?v=aqz-KE-bpKQ";

function musicWatch({ href = MUSIC_WATCH, ...rest } = {}) {
  return musicPage({
    href,
    title: "Never Gonna Give You Up",
    byline: [node("a", { text: "Rick Astley" })],
    ...rest
  });
}

test("sourceForLocation maps only the https YouTube Music host", () => {
  const cases = [
    ["https://music.youtube.com/watch?v=aqz-KE-bpKQ", "youtube-music"],
    ["https://music.youtube.com/", "youtube-music"],
    ["https://www.youtube.com/watch?v=aqz-KE-bpKQ", null],
    ["https://youtube.com/watch?v=aqz-KE-bpKQ", null],
    ["https://m.youtube.com/watch?v=aqz-KE-bpKQ", null],
    ["http://music.youtube.com/watch?v=aqz-KE-bpKQ", null],
    ["https://youtu.be/aqz-KE-bpKQ", null],
    ["https://music.youtube.com.evil.test/watch?v=aqz-KE-bpKQ", null],
    ["https://example.com/watch?v=aqz-KE-bpKQ", null],
    ["not a url", null],
    ["", null]
  ];
  for (const [href, expected] of cases) {
    assert.equal(api.sourceForLocation({ href }), expected, href);
  }
  assert.equal(api.sourceForLocation(null), null);
  assert.equal(api.sourceForLocation(undefined), null);
  assert.equal(api.sourceForLocation({}), null);
});

test("read returns null off YouTube and off a watch page", () => {
  assert.equal(read(makePage({ href: "https://example.com/watch?v=aqz-KE-bpKQ" }).doc, null, {
    href: "https://example.com/watch?v=aqz-KE-bpKQ"
  }), null);
  assert.equal(
    read(makePage({ href: "https://www.youtube.com/" }).doc, null, {
      href: "https://www.youtube.com/"
    }),
    null
  );
  assert.equal(
    read(makePage({ href: "https://music.youtube.com/explore" }).doc, null, {
      href: "https://music.youtube.com/explore"
    }),
    null
  );
  assert.equal(read(null, null, null), null);
});

test("a Music watch page yields the whole state", () => {
  const page = musicWatch({
    artwork: "https://lh3.googleusercontent.com/cover=w544-h544",
    children: [
      video({ currentTime: 42.5, duration: 213.4, paused: false, playbackRate: 1.25 })
    ]
  });
  const state = read(page.doc, page.navigator, page.location);

  assert.deepEqual(Object.keys(state).sort(), [
    "album",
    "artworkUrl",
    "channel",
    "duration",
    "mediaId",
    "pageUrl",
    "paused",
    "playbackRate",
    "position",
    "title",
    "visible"
  ]);
  assert.equal(state.title, "Never Gonna Give You Up");
  assert.equal(state.channel, "Rick Astley");
  assert.equal(state.album, null);
  assert.equal(state.artworkUrl, "https://lh3.googleusercontent.com/cover=w544-h544");
  assert.equal(state.pageUrl, MUSIC_WATCH);
  assert.equal(state.mediaId, "aqz-KE-bpKQ");
  assert.equal(state.duration, 213.4);
  assert.equal(state.position, 42.5);
  assert.equal(state.paused, false);
  assert.equal(state.playbackRate, 1.25);
  assert.equal(state.visible, true);
});

test("media ids parse from music watch urls and stay null on Home", () => {
  const page = musicWatch({ children: [video({ duration: 10 })] });
  const state = read(page.doc, page.navigator, page.location);
  assert.equal(state.mediaId, "aqz-KE-bpKQ");
  assert.equal(state.pageUrl, MUSIC_WATCH);

  const timed = musicWatch({
    href: `${MUSIC_WATCH}&t=42s`,
    children: [video({ duration: 10 })]
  });
  assert.equal(read(timed.doc, timed.navigator, timed.location).pageUrl, `${MUSIC_WATCH}&t=42s`);

  const home = musicPage({
    href: "https://music.youtube.com/",
    title: "PIXELATED KISSES",
    byline: [node("a", { text: "Joji" })],
    children: [video({ duration: 111 })]
  });
  assert.equal(read(home.doc, home.navigator, home.location).mediaId, null);
});

test("a music page without media is paused with null playback numbers", () => {
  const page = musicWatch();
  const state = read(page.doc, page.navigator, page.location);
  assert.equal(state.title, "Never Gonna Give You Up");
  assert.equal(state.paused, true);
  assert.equal(state.duration, null);
  assert.equal(state.position, null);
  assert.equal(state.playbackRate, null);
});

test("position is clamped to duration and NaN is null", () => {
  const clamped = musicWatch({
    children: [video({ currentTime: 150, duration: 100, paused: false })]
  });
  assert.equal(read(clamped.doc, clamped.navigator, clamped.location).position, 100);

  const broken = musicWatch({
    children: [video({ currentTime: Number.NaN, duration: Number.NaN, paused: false })]
  });
  const state = read(broken.doc, broken.navigator, broken.location);
  assert.equal(state.position, null);
  assert.equal(state.duration, null);
  assert.equal(state.playbackRate, 1);
});

test("audio playback extraction preserves its real position and duration for timestamps", () => {
  const page = musicWatch({
    children: [audio({ currentTime: 42.9, duration: 184.2, paused: false, playbackRate: 1 })]
  });
  const state = read(page.doc, page.navigator, page.location);
  assert.equal(state.position, 42.9);
  assert.equal(state.duration, 184.2);
  assert.equal(state.paused, false);
});

test("visible mirrors document.visibilityState exactly", () => {
  const hidden = musicWatch();
  hidden.setVisibility("hidden");
  assert.equal(read(hidden.doc, hidden.navigator, hidden.location).visible, false);

  hidden.doc.visibilityState = undefined;
  assert.equal(read(hidden.doc, hidden.navigator, hidden.location).visible, false);
});

test("Music artwork keeps the player-bar https image and drops the rest", () => {
  const insecured = musicWatch({ artwork: "http://lh3.googleusercontent.com/cover=w544-h544" });
  const insecure = read(insecured.doc, insecured.navigator, insecured.location);
  assert.equal(insecure.artworkUrl, null);

  const plain = musicWatch({ artwork: "https://lh3.googleusercontent.com/cover=w544-h544" });
  assert.equal(
    read(plain.doc, plain.navigator, plain.location).artworkUrl,
    "https://lh3.googleusercontent.com/cover=w544-h544"
  );
});

test("mediaSession fills title and channel when the DOM is bare", () => {
  const page = makePage({
    href: MUSIC_WATCH,
    mediaSession: {
      title: "Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film",
      artist: "Blender",
      album: null,
      artwork: [{ src: "https://lh3.googleusercontent.com/cover=w544-h544", sizes: "544x544" }]
    },
    children: [video({ duration: 634.601 })]
  });
  const state = read(page.doc, page.navigator, page.location);
  assert.equal(state.title, "Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film");
  assert.equal(state.channel, "Blender");
  assert.equal(state.album, null);
  assert.equal(state.artworkUrl, "https://lh3.googleusercontent.com/cover=w544-h544");
  assert.equal(state.duration, 634.601);
});

test("YouTube Music reads song, artist and album from the player bar", () => {
  const page = musicPage({
    title: "Song Name",
    byline: [node("a", { text: "Artist Name" }), " • Album Name • 2020"],
    artwork: "https://lh3.googleusercontent.com/cover=w544-h544"
  });
  const state = read(page.doc, page.navigator, page.location);

  assert.equal(api.sourceForLocation(page.location), "youtube-music");
  assert.equal(state.title, "Song Name");
  assert.equal(state.channel, "Artist Name");
  assert.equal(state.album, "Album Name");
  assert.equal(state.artworkUrl, "https://lh3.googleusercontent.com/cover=w544-h544");
  assert.equal(state.mediaId, "aqz-KE-bpKQ");
  assert.equal(state.pageUrl, "https://music.youtube.com/watch?v=aqz-KE-bpKQ");
});

test("YouTube Music prefers mediaSession metadata and drops a lone artist byline", () => {
  const page = musicPage({
    title: "DOM Title",
    byline: [node("a", { text: "DOM Artist" })]
  });
  page.navigator.mediaSession = {
    metadata: {
      title: "Session Title",
      artist: "Session Artist",
      album: "Session Album",
      artwork: [
        { src: "https://lh3.googleusercontent.com/small=w60", sizes: "60x60" },
        { src: "https://lh3.googleusercontent.com/large=w544", sizes: "544x544" }
      ]
    }
  };
  const state = read(page.doc, page.navigator, page.location);
  assert.equal(state.title, "Session Title");
  assert.equal(state.channel, "Session Artist");
  assert.equal(state.album, "Session Album");
  assert.equal(state.artworkUrl, "https://lh3.googleusercontent.com/large=w544");

  const lone = musicPage({ title: "Song", byline: [node("a", { text: "Artist" })] });
  assert.equal(read(lone.doc, lone.navigator, lone.location).album, null);
});

test("YouTube Music on Home reports the persistent player without a media id", () => {
  const page = musicPage({
    href: "https://music.youtube.com/",
    title: "PIXELATED KISSES",
    byline: [node("a", { text: "Joji" }), " • PIXELATED KISSES • 2025"],
    artwork: "https://lh3.googleusercontent.com/cover=w544-h544",
    children: [video({ currentTime: 3, duration: 111, paused: false })]
  });
  const state = read(page.doc, page.navigator, page.location);

  assert.ok(state, "a Home page whose player bar is playing must not be null");
  assert.equal(state.title, "PIXELATED KISSES");
  assert.equal(state.channel, "Joji");
  assert.equal(state.album, "PIXELATED KISSES");
  assert.equal(state.mediaId, null);
  assert.equal(state.pageUrl, "https://music.youtube.com/");
  assert.equal(state.paused, false);
  assert.equal(state.duration, 111);
});

test("JSON-LD is the fallback for title, channel, artwork and duration", () => {
  const page = musicWatch({
    title: null,
    byline: null,
    children: [
      video({ duration: 0 }),
      jsonLd({
        "@context": "https://schema.org",
        "@type": "MusicRecording",
        name: "LD Title",
        author: { "@type": "Person", name: "LD Channel" },
        thumbnailUrl: ["http://bad.example/x.jpg", "https://lh3.googleusercontent.com/cover=w300-h300"],
        duration: "PT3M33S"
      })
    ]
  });
  const state = read(page.doc, page.navigator, page.location);
  assert.equal(state.title, "LD Title");
  assert.equal(state.channel, "LD Channel");
  assert.equal(state.artworkUrl, "https://lh3.googleusercontent.com/cover=w300-h300");
  assert.equal(state.duration, 213);
});

test("text is stripped, collapsed, de-noised and capped at 256", () => {
  const noisy = musicWatch({
    title: "\u200B  Never \n Gonna\u202E   Give  You Up  ",
    byline: [node("a", { text: "\uFEFF Rick   Astley " })],
    artwork: null
  });
  const state = read(noisy.doc, noisy.navigator, noisy.location);
  assert.equal(state.title, "Never Gonna Give You Up");
  assert.equal(state.channel, "Rick Astley");

  const long = musicWatch({ title: "x".repeat(300) });
  assert.equal(read(long.doc, long.navigator, long.location).title.length, 256);

  const sufixed = makePage({
    href: MUSIC_WATCH,
    title: "Some Song - YouTube Music",
    children: [video({ duration: 1 })]
  });
  assert.equal(read(sufixed.doc, sufixed.navigator, sufixed.location).title, "Some Song");
});

test("read never throws, whatever the page hands it", () => {
  const hostile = {
    get title() {
      throw new Error("title");
    },
    get location() {
      throw new Error("location");
    },
    get visibilityState() {
      throw new Error("visibility");
    },
    querySelector() {
      throw new Error("querySelector");
    },
    querySelectorAll() {
      throw new Error("querySelectorAll");
    },
    get documentElement() {
      throw new Error("documentElement");
    }
  };
  const hostileNav = {
    get mediaSession() {
      throw new Error("mediaSession");
    }
  };

  let state;
  assert.doesNotThrow(() => {
    state = api.read(hostile, hostileNav, { href: MUSIC_WATCH });
  });
  assert.equal(state, null);
});
