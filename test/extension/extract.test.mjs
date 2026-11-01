import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeDocument, node } from "./helpers/fake-dom.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "..", "extension", "extract.js"), "utf8");

/** extract.js is a classic content script; evaluate it and grab its exports. */
function loadExtractor() {
  const context = createContext({});
  runInContext(source, context, { filename: "extension/extract.js" });
  return context.CrunchyrollExtract;
}

const api = loadExtractor();
const extract = api.extract;
const RULES = api.RULES;

/**
 * The extractor runs inside a vm realm, so its arrays carry that realm's
 * prototypes. Round-trip through JSON: this also proves the payload the content
 * script sends is wire-serializable.
 */
function state(doc, navigator) {
  return JSON.parse(JSON.stringify(extract(doc, navigator)));
}

function video(props = {}) {
  return node("video", {
    props: {
      currentTime: 0,
      duration: 0,
      paused: true,
      playbackRate: 1,
      readyState: 1,
      ...props
    }
  });
}

function jsonLd(obj) {
  return node("script", {
    attrs: { type: "application/ld+json" },
    text: typeof obj === "string" ? obj : JSON.stringify(obj)
  });
}

function meta(property, content) {
  return node("meta", { attrs: { property, content } });
}

test("RULES keeps every selector and regex in one table", () => {
  assert.equal(RULES.maxChars, 128);
  assert.deepEqual([...RULES.dom.video], ["#player-container video", "video"]);
  assert.equal(RULES.dom.episode, "h1.title");
  assert.equal(RULES.dom.series, "a > h4");
  assert.equal(RULES.dom.button, "a.show-title-link");
  assert.equal(RULES.jsonLd.script, 'script[type="application/ld+json"]');
  assert.ok(Array.isArray(RULES.title.patterns));
  assert.ok(RULES.title.patterns.length >= 3);
  assert.equal(String(RULES.dom.watchPath), String(/\/watch\/(G[A-Z0-9]+)/));
});

test("mediaSession only: title/artist/artwork feed the result", () => {
  const { doc, navigator } = makeDocument({
    title: "Crunchyroll",
    href: "https://www.crunchyroll.com/watch/G6VU774M5/the-beginning",
    children: [video({ currentTime: 754, duration: 1440, paused: false })],
    mediaSession: {
      title: "The Beginning",
      artist: "Frieren: Beyond Journey's End",
      album: "Frieren",
      artwork: [
        { src: "https://img.crunchyroll.com/small.jpg", sizes: "256x256" },
        { src: "https://img.crunchyroll.com/large.jpg", sizes: "1024x1024" }
      ]
    }
  });

  const result = state(doc, navigator);
  assert.deepEqual(result, {
    series: "Frieren: Beyond Journey's End",
    episodeTitle: "The Beginning",
    seasonNumber: null,
    episodeNumber: null,
    artworkUrl: "https://img.crunchyroll.com/large.jpg",
    duration: 1440,
    position: 754,
    paused: false,
    playbackRate: 1,
    hasVideo: true,
    signals: ["video", "mediaSession", "watchUrl"]
  });
});

test("JSON-LD only: TVEpisode supplies series, season, episode, artwork", () => {
  const { doc, navigator } = makeDocument({
    title: "Frieren the Slayer",
    href: "https://www.crunchyroll.com/watch/GX1",
    children: [
      jsonLd({
        "@context": "https://schema.org",
        "@type": "TVEpisode",
        name: "Frieren the Slayer",
        partOfSeries: { "@type": "TVSeries", name: "Frieren: Beyond Journey's End" },
        partOfSeason: { "@type": "TVSeason", seasonNumber: 1 },
        episodeNumber: 5,
        thumbnailUrl: "https://img.crunchyroll.com/ep5.jpg"
      })
    ]
  });

  const result = state(doc, navigator);
  assert.deepEqual(result, {
    series: "Frieren: Beyond Journey's End",
    episodeTitle: "Frieren the Slayer",
    seasonNumber: 1,
    episodeNumber: 5,
    artworkUrl: "https://img.crunchyroll.com/ep5.jpg",
    duration: null,
    position: null,
    paused: null,
    playbackRate: null,
    hasVideo: false,
    signals: ["jsonLd", "watchUrl"]
  });
});

test("JSON-LD VideoObject inside @graph is read", () => {
  const { doc, navigator } = makeDocument({
    href: "https://www.crunchyroll.com/series/G6NQ5DWZ6",
    children: [
      jsonLd({
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "WebSite", name: "Crunchyroll" },
          {
            "@type": "VideoObject",
            name: "A New Journey",
            thumbnailUrl: ["https://img.crunchyroll.com/a.jpg"],
            duration: "PT24M"
          }
        ]
      })
    ]
  });

  const result = state(doc, navigator);
  assert.equal(result.episodeTitle, "A New Journey");
  assert.equal(result.artworkUrl, "https://img.crunchyroll.com/a.jpg");
  assert.deepEqual(result.signals, ["jsonLd"]);
});

test("og + title only: noise stripped, SxxExx parsed, series derived", () => {
  const { doc, navigator } = makeDocument({
    title: "Watch Frieren S01E05 - Crunchyroll",
    href: "https://www.crunchyroll.com/series/G6NQ5DWZ6",
    children: [meta("og:title", "Watch Frieren S01E05 - Crunchyroll"), meta("og:image", "https://img.crunchyroll.com/og.jpg")]
  });

  const result = state(doc, navigator);
  assert.deepEqual(result, {
    series: "Frieren",
    episodeTitle: null,
    seasonNumber: 1,
    episodeNumber: 5,
    artworkUrl: "https://img.crunchyroll.com/og.jpg",
    duration: null,
    position: null,
    paused: null,
    playbackRate: null,
    hasVideo: false,
    signals: ["og", "title"]
  });
});

test("ad frame: no video, no metadata, nothing extracted", () => {
  const { doc, navigator } = makeDocument({
    title: "Crunchyroll",
    href: "https://www.crunchyroll.com/series/G6NQ5DWZ6/frieren",
    children: [node("div", { attrs: { id: "ad-slot" }, text: "Advertisement" })]
  });

  const result = state(doc, navigator);
  assert.deepEqual(result, {
    series: null,
    episodeTitle: null,
    seasonNumber: null,
    episodeNumber: null,
    artworkUrl: null,
    duration: null,
    position: null,
    paused: null,
    playbackRate: null,
    hasVideo: false,
    signals: []
  });
});

test("malformed JSON-LD never throws and does not block other layers", () => {
  const { doc, navigator } = makeDocument({
    title: "Frieren S2E7",
    children: [jsonLd('{"@type": "TVEpisode", "name": '), jsonLd("not json at all")]
  });

  const result = state(doc, navigator);
  assert.equal(result.seasonNumber, 2);
  assert.equal(result.episodeNumber, 7);
  assert.equal(result.series, "Frieren");
  assert.deepEqual(result.signals, ["title"]);
});

test("a broken JSON-LD block does not stop a later valid one", () => {
  const { doc, navigator } = makeDocument({
    children: [
      jsonLd("{{{"),
      jsonLd({ "@type": "Episode", name: "Later Block", episodeNumber: 9 })
    ]
  });

  const result = state(doc, navigator);
  assert.equal(result.episodeTitle, "Later Block");
  assert.equal(result.episodeNumber, 9);
  assert.ok(result.signals.includes("jsonLd"));
});

test("document.title parsing variants", () => {
  const cases = [
    { title: "Frieren S1E5", expected: [1, 5, "Frieren"] },
    { title: "Frieren S01 E05", expected: [1, 5, "Frieren"] },
    { title: "One Piece Season 2 Episode 7", expected: [2, 7, "One Piece"] },
    { title: "Frieren E12", expected: [null, 12, "Frieren"] },
    { title: "S3E4", expected: [3, 4, null] }
  ];

  for (const { title, expected } of cases) {
    const { doc, navigator } = makeDocument({ title });
    const result = state(doc, navigator);
    assert.deepEqual(
      [result.seasonNumber, result.episodeNumber, result.series],
      expected,
      `title: ${title}`
    );
    assert.ok(result.signals.includes("title"), `title signal for: ${title}`);
  }
});

test("DOM fallback: nearest heading and [data-testid] text", () => {
  const heading = node("h1", { text: "Frieren: Beyond Journey's End" });
  const wrapper = node("div", { children: [heading] });
  const player = node("div", { children: [wrapper, video()] });

  const patch = node("span", {
    attrs: { "data-testid": "vilos-episode-title" },
    text: "Frieren the Slayer"
  });

  const { doc, navigator } = makeDocument({
    href: "https://www.crunchyroll.com/series/G6NQ5DWZ6",
    children: [player, patch]
  });

  const result = state(doc, navigator);
  assert.equal(result.series, "Frieren: Beyond Journey's End");
  assert.equal(result.episodeTitle, "Frieren the Slayer");
  assert.deepEqual(result.signals, ["video", "dom"]);
});

test("PreMiD selectors: #player-container video, h1.title, a > h4", () => {
  const player = node("div", {
    attrs: { id: "player-container" },
    children: [video({ currentTime: 60, duration: 1440, paused: false })]
  });
  const seriesLink = node("a", {
    attrs: { href: "/series/G6NQ5DWZ6", class: "show-title-link" },
    children: [node("h4", { text: "Frieren: Beyond Journey's End" })]
  });
  const episodeHeading = node("h1", { attrs: { class: "title" }, text: "Frieren the Slayer" });

  const { doc, navigator } = makeDocument({
    href: "https://www.crunchyroll.com/watch/G6VU774M5/x",
    children: [player, seriesLink, episodeHeading]
  });

  const result = state(doc, navigator);
  assert.equal(result.series, "Frieren: Beyond Journey's End");
  assert.equal(result.episodeTitle, "Frieren the Slayer");
  assert.equal(result.duration, 1440);
  assert.equal(result.position, 60);
  assert.deepEqual(result.signals, ["video", "dom", "watchUrl", "button"]);
});

test("strings are capped at 128 characters after noise removal", () => {
  const longSeries = "A".repeat(200);
  const longEpisode = "B".repeat(200);
  const { doc, navigator } = makeDocument({
    mediaSession: { title: longEpisode, artist: longSeries, artwork: [] }
  });

  const result = state(doc, navigator);
  assert.equal(result.series.length, 128);
  assert.equal(result.episodeTitle.length, 128);
  assert.equal(result.series, "A".repeat(128));
  assert.equal(result.episodeTitle, "B".repeat(128));
});

test("noise prefixes and suffixes are stripped from every source", () => {
  const { doc, navigator } = makeDocument({
    mediaSession: { title: "Watch The Beginning - Crunchyroll", artist: "Frieren | Crunchyroll" }
  });

  const result = state(doc, navigator);
  assert.equal(result.episodeTitle, "The Beginning");
  assert.equal(result.series, "Frieren");
});

test("artwork must be an http(s) URL", () => {
  const { doc, navigator } = makeDocument({
    mediaSession: { title: "The Beginning", artist: "Frieren", artwork: [{ src: "data:image/png;base64,AAAA" }] }
  });

  const result = state(doc, navigator);
  assert.equal(result.artworkUrl, null);
});

test("extract() survives an empty document", () => {
  const result = state({}, {});
  assert.deepEqual(result.signals, []);
  assert.equal(result.hasVideo, false);
  assert.equal(result.series, null);
});
