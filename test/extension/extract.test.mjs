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
    seriesUrl: null,
    episodeUrl: "https://www.crunchyroll.com/watch/G6VU774M5/the-beginning",
    synopsis: null,
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
    seriesUrl: null,
    episodeUrl: "https://www.crunchyroll.com/watch/GX1",
    synopsis: null,
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
    seriesUrl: null,
    episodeUrl: null,
    synopsis: null,
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
    seriesUrl: null,
    episodeUrl: null,
    synopsis: null,
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
  assert.equal(result.seriesUrl, "https://www.crunchyroll.com/series/G6NQ5DWZ6");
  assert.equal(result.episodeUrl, "https://www.crunchyroll.com/watch/G6VU774M5/x");
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

/* ------------------------------------------------- phase 2: links + synopsis */

const WATCH = "https://www.crunchyroll.com/watch/G6VU774M5/x";

function namedMeta(name, content) {
  return node("meta", { attrs: { name, content } });
}

test("seriesUrl: JSON-LD partOfSeries.@id, then show-title-link, then a > h4 ancestor", () => {
  const withJsonLd = makeDocument({
    href: WATCH,
    children: [
      jsonLd({
        "@type": "TVEpisode",
        name: "Ep",
        partOfSeries: { name: "Series", "@id": "https://www.crunchyroll.com/series/G1" }
      }),
      node("a", { attrs: { class: "show-title-link", href: "https://www.crunchyroll.com/series/G2" } })
    ]
  });
  assert.equal(state(withJsonLd.doc, withJsonLd.navigator).seriesUrl, "https://www.crunchyroll.com/series/G1");

  const withButton = makeDocument({
    href: WATCH,
    children: [node("a", { attrs: { class: "show-title-link", href: "/series/G2" } })]
  });
  assert.equal(
    state(withButton.doc, withButton.navigator).seriesUrl,
    "https://www.crunchyroll.com/series/G2"
  );

  const withHeading = makeDocument({
    href: WATCH,
    children: [
      node("a", {
        attrs: { href: "https://www.crunchyroll.com/series/G3" },
        children: [node("h4", { text: "Series" })]
      })
    ]
  });
  assert.equal(
    state(withHeading.doc, withHeading.navigator).seriesUrl,
    "https://www.crunchyroll.com/series/G3"
  );

  const insecure = makeDocument({
    href: WATCH,
    children: [node("a", { attrs: { class: "show-title-link", href: "http://www.crunchyroll.com/series/G4" } })]
  });
  assert.equal(state(insecure.doc, insecure.navigator).seriesUrl, null);
});

test("episodeUrl: canonical link, then og:url, then a /watch/ location", () => {
  const canonical = makeDocument({
    href: "https://www.crunchyroll.com/series/G1",
    children: [
      node("link", { attrs: { rel: "canonical", href: "https://www.crunchyroll.com/watch/G1/canonical" } }),
      meta("og:url", "https://www.crunchyroll.com/watch/G1/og")
    ]
  });
  assert.equal(
    state(canonical.doc, canonical.navigator).episodeUrl,
    "https://www.crunchyroll.com/watch/G1/canonical"
  );

  const og = makeDocument({
    href: "https://www.crunchyroll.com/series/G1",
    children: [meta("og:url", "https://www.crunchyroll.com/watch/G1/og")]
  });
  assert.equal(state(og.doc, og.navigator).episodeUrl, "https://www.crunchyroll.com/watch/G1/og");

  const locationOnly = makeDocument({ href: "https://www.crunchyroll.com/watch/G1/loc" });
  assert.equal(
    state(locationOnly.doc, locationOnly.navigator).episodeUrl,
    "https://www.crunchyroll.com/watch/G1/loc"
  );

  const insecure = makeDocument({ href: "http://www.crunchyroll.com/watch/G1/loc" });
  assert.equal(state(insecure.doc, insecure.navigator).episodeUrl, null);
});

const REAL_SYNOPSIS =
  "The land has fallen into ruin, and children represent the last hope for humanity. One of them, Hiro, fails to live up to that purpose and decides to walk away from it all.... until he meets a girl with horns.";
const REAL_META = `Watch Darling in the FRANXX Alone and Lonesome, on Crunchyroll. ${REAL_SYNOPSIS}`;
const REAL_SERIES_URL = "https://www.crunchyroll.com/series/GY8VEQ95Y/darling-in-the-franxx";
const REAL_WATCH_URL = "https://www.crunchyroll.com/watch/GRDKJZ81Y/alone-and-lonesome";

test("real capture: VideoObject synopsis, show-title link and canonical episode URL", () => {
  const { doc, navigator } = makeDocument({
    href: REAL_WATCH_URL,
    children: [
      jsonLd({
        "@type": "VideoObject",
        name: "Alone and Lonesome",
        description: REAL_SYNOPSIS,
        partOfSeries: { name: "Darling in the FRANXX", url: REAL_SERIES_URL }
      }),
      meta("og:description", REAL_SYNOPSIS),
      namedMeta("description", REAL_META),
      node("link", { attrs: { rel: "canonical", href: REAL_WATCH_URL } }),
      meta("og:url", REAL_WATCH_URL),
      node("a", {
        attrs: { class: "show-title-link", href: REAL_SERIES_URL },
        children: [node("h4", { text: "Darling in the FRANXX" })]
      }),
      node("h1", { text: "E1 - Alone and Lonesome" }),
      node("div", {
        attrs: { class: "expandable-section__text--abc" },
        text: "Join for free or go Premium."
      })
    ]
  });

  const result = state(doc, navigator);
  assert.equal(result.synopsis, REAL_SYNOPSIS);
  assert.equal(result.seriesUrl, REAL_SERIES_URL);
  assert.equal(result.episodeUrl, REAL_WATCH_URL);
  assert.equal(result.series, "Darling in the FRANXX");
});

test("og:description survives untouched", () => {
  assert.equal(REAL_SYNOPSIS.length, 208);
  const { doc, navigator } = makeDocument({
    children: [meta("og:description", REAL_SYNOPSIS)]
  });
  assert.equal(state(doc, navigator).synopsis, REAL_SYNOPSIS);
});

test("meta description strips the Watch…on Crunchyroll. prefix to the synopsis", () => {
  const metaOnly = makeDocument({ children: [namedMeta("description", REAL_META)] });
  assert.equal(state(metaOnly.doc, metaOnly.navigator).synopsis, REAL_SYNOPSIS);

  const both = makeDocument({
    children: [meta("og:description", REAL_SYNOPSIS), namedMeta("description", REAL_META)]
  });
  assert.equal(state(both.doc, both.navigator).synopsis, REAL_SYNOPSIS);
});

test("synopsis precedence: JSON-LD description, og:description, meta description, expandable-section", () => {
  const ogText = "The open graph description is the one that survives from this document.";
  const metaText = `Watch Whatever on Crunchyroll. ${ogText}`;

  const ldDoc = makeDocument({
    children: [
      jsonLd({ "@type": "TVEpisode", name: "Ep", description: REAL_SYNOPSIS }),
      meta("og:description", ogText),
      namedMeta("description", metaText)
    ]
  });
  assert.equal(state(ldDoc.doc, ldDoc.navigator).synopsis, REAL_SYNOPSIS);

  const ogDoc = makeDocument({
    children: [meta("og:description", ogText), namedMeta("description", metaText)]
  });
  assert.equal(state(ogDoc.doc, ogDoc.navigator).synopsis, ogText);

  const metaDoc = makeDocument({ children: [namedMeta("description", metaText)] });
  assert.equal(state(metaDoc.doc, metaDoc.navigator).synopsis, ogText);

  const domDoc = makeDocument({
    children: [node("div", { attrs: { class: "expandable-section__text--abc" }, text: ogText })]
  });
  assert.equal(state(domDoc.doc, domDoc.navigator).synopsis, ogText);
});

test("expandable-section synopsis is quote-stripped; Join for free is never used", () => {
  const quoted = `\u201c${REAL_SYNOPSIS}\u201d`;
  const valid = makeDocument({
    children: [node("div", { attrs: { class: "expandable-section__text--abc" }, text: quoted })]
  });
  assert.equal(state(valid.doc, valid.navigator).synopsis, REAL_SYNOPSIS);

  const garbage = makeDocument({
    children: [
      node("div", {
        attrs: { class: "expandable-section__text--abc" },
        text: "Join for free or go Premium."
      }),
      node("div", { attrs: { class: "synopsis-copy" }, text: REAL_SYNOPSIS })
    ]
  });
  assert.equal(state(garbage.doc, garbage.navigator).synopsis, null);
});

test("synopsis rejects stream/upsell, consent, language lists and short text", () => {
  const cases = [
    "Stream every episode of Frieren on Crunchyroll in HD.",
    "Sign up for Crunchyroll Premium to unlock this episode now.",
    "We've Updated Our Terms and Privacy Policy before you continue.",
    "English, Spanish, Portuguese, French",
    "Watch Frieren Beyond Journey's End on Crunchyroll today.",
    "Too short to show."
  ];
  for (const text of cases) {
    const { doc, navigator } = makeDocument({ children: [namedMeta("description", text)] });
    assert.equal(state(doc, navigator).synopsis, null, text);
  }
});

/* ------------------------------------- real JSON-LD: titles, links, duration */

const DARLING_SERIES_URL = "https://www.crunchyroll.com/series/GY8VEQ95Y/darling-in-the-franxx";
const DARLING_WATCH_URL = "https://www.crunchyroll.com/watch/GRDKJZ81Y/alone-and-lonesome";
const DARLING_RAW_TITLE = "Darling in the FRANXX | E1 - Alone and Lonesome";
const DARLING_ISO_DURATION = "PT24M0.023999999999887223S";

const darlingEpisode = (overrides = {}) => ({
  "@context": ["https://schema.org", { "@language": "en-us" }],
  "@id": DARLING_WATCH_URL,
  name: DARLING_RAW_TITLE,
  "@type": "TVEpisode",
  url: DARLING_WATCH_URL,
  episodeNumber: 1,
  partOfSeason: {
    "@type": "TVSeason",
    "@id": DARLING_SERIES_URL,
    name: "Darling in the FRANXX",
    seasonNumber: 1
  },
  partOfSeries: {
    "@type": "TVSeries",
    "@id": DARLING_SERIES_URL,
    name: "Darling in the FRANXX"
  },
  ...overrides
});

const darlingVideo = (overrides = {}) => ({
  "@context": "https://schema.org",
  "@type": "VideoObject",
  name: "Alone and Lonesome",
  duration: DARLING_ISO_DURATION,
  ...overrides
});

test("real TVEpisode + VideoObject: direct links and h1 title, never the raw TVEpisode name", () => {
  const { doc, navigator } = makeDocument({
    href: DARLING_WATCH_URL,
    children: [
      jsonLd(darlingEpisode()),
      jsonLd(darlingVideo()),
      node("link", {
        attrs: { rel: "canonical", href: "https://www.crunchyroll.com/watch/WRONG/canonical" }
      }),
      node("h1", { text: "E1 - Alone and Lonesome" })
    ]
  });

  const result = state(doc, navigator);
  assert.equal(result.series, "Darling in the FRANXX");
  assert.equal(result.seasonNumber, 1);
  assert.equal(result.episodeNumber, 1);
  assert.equal(result.episodeTitle, "E1 - Alone and Lonesome");
  assert.notEqual(result.episodeTitle, DARLING_RAW_TITLE);
  assert.equal(result.seriesUrl, DARLING_SERIES_URL);
  assert.equal(result.episodeUrl, DARLING_WATCH_URL, "TVEpisode.url outranks canonical");
  assert.equal(result.duration, 1440.024);
});

test("episodeTitle falls back to VideoObject name, then a stripped TVEpisode name", () => {
  const videoOnly = makeDocument({
    href: DARLING_WATCH_URL,
    children: [jsonLd(darlingEpisode()), jsonLd(darlingVideo())]
  });
  assert.equal(state(videoOnly.doc, videoOnly.navigator).episodeTitle, "Alone and Lonesome");

  const episodeOnly = makeDocument({
    href: DARLING_WATCH_URL,
    children: [jsonLd(darlingEpisode())]
  });
  const stripped = state(episodeOnly.doc, episodeOnly.navigator);
  assert.equal(stripped.episodeTitle, "E1 - Alone and Lonesome");
  assert.notEqual(stripped.episodeTitle, DARLING_RAW_TITLE);

  // No series identity anywhere (no partOfSeries/partOfSeason name, no DOM
  // heading): the composite must still be cut, never returned raw.
  const noSeries = makeDocument({
    href: DARLING_WATCH_URL,
    children: [
      jsonLd({
        "@type": "TVEpisode",
        "@id": DARLING_WATCH_URL,
        url: DARLING_WATCH_URL,
        name: DARLING_RAW_TITLE,
        episodeNumber: 1
      })
    ]
  });
  const bare = state(noSeries.doc, noSeries.navigator);
  assert.equal(bare.episodeTitle, "E1 - Alone and Lonesome");
  assert.notEqual(bare.episodeTitle, DARLING_RAW_TITLE);
});

test("seriesUrl: partOfSeries.@id, then partOfSeason.@id, then show-title-link", () => {
  const seriesLd = makeDocument({
    href: DARLING_WATCH_URL,
    children: [jsonLd(darlingEpisode())]
  });
  assert.equal(state(seriesLd.doc, seriesLd.navigator).seriesUrl, DARLING_SERIES_URL);

  const seasonId = "https://www.crunchyroll.com/series/GY8VEQ95Y/from-season";
  const seasonLd = makeDocument({
    href: DARLING_WATCH_URL,
    children: [
      jsonLd(
        darlingEpisode({
          partOfSeries: undefined,
          partOfSeason: {
            "@type": "TVSeason",
            "@id": seasonId,
            name: "Darling in the FRANXX",
            seasonNumber: 1
          }
        })
      )
    ]
  });
  assert.equal(state(seasonLd.doc, seasonLd.navigator).seriesUrl, seasonId);

  const buttonOnly = makeDocument({
    href: DARLING_WATCH_URL,
    children: [node("a", { attrs: { class: "show-title-link", href: DARLING_SERIES_URL } })]
  });
  assert.equal(state(buttonOnly.doc, buttonOnly.navigator).seriesUrl, DARLING_SERIES_URL);
});

test("ISO-8601 duration fills the gap when the video has no duration; video wins when it has one", () => {
  const noVideo = makeDocument({
    href: DARLING_WATCH_URL,
    children: [jsonLd(darlingEpisode()), jsonLd(darlingVideo())]
  });
  const fromLd = state(noVideo.doc, noVideo.navigator);
  assert.equal(fromLd.hasVideo, false);
  assert.equal(fromLd.duration, 1440.024);

  const zeroVideo = makeDocument({
    href: DARLING_WATCH_URL,
    children: [jsonLd(darlingVideo()), video({ duration: 0 })]
  });
  assert.equal(state(zeroVideo.doc, zeroVideo.navigator).duration, 1440.024);

  const realVideo = makeDocument({
    href: DARLING_WATCH_URL,
    children: [jsonLd(darlingVideo()), video({ currentTime: 60, duration: 1200 })]
  });
  const fromVideo = state(realVideo.doc, realVideo.navigator);
  assert.equal(fromVideo.hasVideo, true);
  assert.equal(fromVideo.duration, 1200);
});
