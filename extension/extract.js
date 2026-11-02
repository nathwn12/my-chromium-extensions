/**
 * Crunchyroll Discord Presence — DOM extraction.
 *
 * Loaded by the manifest as a *classic* content script (Chrome cannot load
 * content scripts as ES modules), so it exposes `globalThis.CrunchyrollExtract`.
 * `content.js` consumes it; the test suite evaluates this file in a `vm`
 * sandbox with a fake document/navigator, so every DOM touch stays behind the
 * injected `doc` / `nav` arguments.
 *
 * Rule of this file: never throw. Every field is nullable; a malformed page
 * yields nulls, never an exception.
 */
(function (root) {
  "use strict";

  /** Every tunable selector, regex and cap lives here. */
  var RULES = {
    maxChars: 128,

    noise: {
      prefixes: ["Watch ", "Watching "],
      suffixes: [" - Crunchyroll", " | Crunchyroll", " - Crunchyroll.", " on Crunchyroll"]
    },

    mediaSession: {
      // which metadata fields feed which output field
      title: "title",
      series: ["artist", "album"]
    },

    jsonLd: {
      script: 'script[type="application/ld+json"]',
      types: ["videoobject", "tvepisode", "episode"],
      fields: {
        name: "name",
        series: "partOfSeries.name",
        seriesUrl: ["partOfSeries.url", "partOfSeries.@id"],
        season: "partOfSeason.seasonNumber",
        episode: "episodeNumber",
        artwork: ["thumbnailUrl", "image"],
        description: "description"
      }
    },

    meta: {
      title: 'meta[property="og:title"]',
      image: 'meta[property="og:image"]',
      imageFallback: 'meta[name="twitter:image"]',
      canonical: 'link[rel="canonical"]',
      url: 'meta[property="og:url"]',
      description: 'meta[name="description"]',
      ogDescription: 'meta[property="og:description"]'
    },

    synopsis: {
      minChars: 40,
      maxChars: 1000,
      // the real synopsis node is expandable-section__text--…
      dom: ['*[class*="expandable-section" i]'],
      // meta[name="description"] is prefixed with this clause, not boilerplate
      watchPrefix: /^Watch\b.*?\bon Crunchyroll\b[.,!?]?\s*/i,
      terms: /\b(we'?ve updated our terms|updated our terms|terms of (use|service)|privacy (policy|notice)|cookie (policy|consent))\b/i,
      languages: [
        "english",
        "spanish",
        "español",
        "espanol",
        "portuguese",
        "português",
        "portugues",
        "french",
        "français",
        "francais",
        "german",
        "deutsch",
        "italian",
        "italiano",
        "russian",
        "русский",
        "arabic",
        "hindi",
        "japanese",
        "korean",
        "chinese",
        "tamil",
        "telugu"
      ]
    },

    title: {
      // first pattern that matches wins; earlier patterns are more specific
      patterns: [
        { name: "sxxexx", re: /\bS(\d{1,3})\s?E(\d{1,4})\b/i, season: 1, episode: 2, deriveSeries: true },
        { name: "seasonEpisode", re: /\bSeason\s+(\d{1,3})\s+Episode\s+(\d{1,4})\b/i, season: 1, episode: 2, deriveSeries: true },
        { name: "episodeOnly", re: /\bEp?\.?\s?(\d{1,4})\b/i, episode: 1, deriveSeries: true }
      ]
    },

    dom: {
      // first match wins; the player lives inside these two containers
      video: ["#player-container video", "video"],
      headings: ["h1", "h2"],
      // PreMiD-verified Crunchyroll player selectors
      episode: "h1.title",
      series: "a > h4",
      button: "a.show-title-link",
      testId: "[data-testid]",
      ancestorDepth: 8,
      watchPath: /\/watch\/(G[A-Z0-9]+)/,
      generic: [
        "crunchyroll",
        "watch",
        "video",
        "episode",
        "series",
        "home",
        "sign in",
        "premium"
      ]
    }
  };

  /* ---------------------------------------------------------------- utils */

  function clean(value) {
    if (typeof value !== "string") return null;
    var text = value.replace(/\s+/g, " ").trim();
    var changed = true;
    var i;
    while (changed) {
      changed = false;
      for (i = 0; i < RULES.noise.prefixes.length; i += 1) {
        var p = RULES.noise.prefixes[i];
        if (text.length > p.length && text.slice(0, p.length).toLowerCase() === p.toLowerCase()) {
          text = text.slice(p.length).trim();
          changed = true;
        }
      }
      for (i = 0; i < RULES.noise.suffixes.length; i += 1) {
        var s = RULES.noise.suffixes[i];
        if (text.length > s.length && text.slice(-s.length).toLowerCase() === s.toLowerCase()) {
          text = text.slice(0, -s.length).trim();
          changed = true;
        }
      }
    }
    if (!text) return null;
    return text.length > RULES.maxChars ? text.slice(0, RULES.maxChars) : text;
  }

  function cleanUrl(value) {
    if (typeof value !== "string") return null;
    var text = value.trim();
    if (!text) return null;
    if (/^https?:\/\//i.test(text)) return text.length > 1024 ? text.slice(0, 1024) : text;
    if (text.slice(0, 2) === "//") return "https:" + text;
    return null;
  }

  /**
   * Direct links may only leave this file as an absolute https URL.
   * A relative reference is resolved against the page URL (which must itself
   * be https), never against an http base.
   */
  function absoluteHttps(value, base) {
    if (typeof value !== "string") return null;
    var text = value.trim();
    if (!text) return null;
    if (/^https:\/\//i.test(text)) return text.length > 1024 ? text.slice(0, 1024) : text;
    if (text.slice(0, 2) === "//") return ("https:" + text).slice(0, 1024);
    if (text.charAt(0) === "/" && typeof base === "string" && /^https:\/\//i.test(base)) {
      var origin = /^(https:\/\/[^/]+)/i.exec(base);
      if (origin) return (origin[1] + text).slice(0, 1024);
    }
    return null;
  }

  function stripQuotes(text) {
    var pairs = { '"': '"', "'": "'", "\u201c": "\u201d", "\u2018": "\u2019" };
    var out = text;
    while (out.length >= 2) {
      var first = out.charAt(0);
      if (!pairs[first] || pairs[first] !== out.charAt(out.length - 1)) break;
      out = out.slice(1, -1).trim();
    }
    return out;
  }

  /** Remove the leading "Watch … on Crunchyroll." clause from a meta description. */
  function stripWatchPrefix(value) {
    if (typeof value !== "string") return value;
    return value.replace(RULES.synopsis.watchPrefix, "");
  }

  function isLanguageList(text) {
    var parts = text.split(",");
    if (parts.length < 4) return false;
    var hits = 0;
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i].trim().toLowerCase();
      if (!part || part.split(/\s+/).length > 3) return false;
      if (RULES.synopsis.languages.indexOf(part) !== -1) hits += 1;
    }
    return hits >= 2;
  }

  function isBoilerplate(text) {
    var lower = text.toLowerCase();
    if (lower.indexOf("watch ") === 0 && lower.indexOf(" on crunchyroll") !== -1) return true;
    if (/\bstream\b/i.test(text) && /crunchyroll/i.test(text)) return true;
    if (/\b(premium|sign\s?-?up|subscribe|free\s+trial)\b/i.test(text)) return true;
    if (RULES.synopsis.terms.test(text)) return true;
    if (isLanguageList(text)) return true;
    return false;
  }

  /** Synopsis text: full length for later smart truncation, never boilerplate. */
  function cleanSynopsis(value) {
    if (typeof value !== "string") return null;
    var text = stripQuotes(value.replace(/\s+/g, " ").trim());
    if (!text || text.length < RULES.synopsis.minChars) return null;
    if (isBoilerplate(text)) return null;
    return text.length > RULES.synopsis.maxChars ? text.slice(0, RULES.synopsis.maxChars) : text;
  }

  function finite(value) {
    if (value === null || value === undefined || value === "") return null;
    var n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  }

  function number(value) {
    if (value === null || value === undefined || value === "") return null;
    var n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function textOf(node) {
    if (!node) return null;
    var raw = node.textContent;
    if (typeof raw !== "string") return null;
    var text = raw.replace(/\s+/g, " ").trim();
    return text || null;
  }

  function attrOf(node, name) {
    if (!node || typeof node.getAttribute !== "function") return null;
    return node.getAttribute(name);
  }

  function queryOne(doc, selector) {
    if (!doc || typeof doc.querySelector !== "function") return null;
    try {
      return doc.querySelector(selector);
    } catch (_) {
      return null;
    }
  }

  function queryAll(doc, selector) {
    if (!doc || typeof doc.querySelectorAll !== "function") return [];
    try {
      var list = doc.querySelectorAll(selector);
      if (!list) return [];
      var out = [];
      for (var i = 0; i < list.length; i += 1) out.push(list[i]);
      return out;
    } catch (_) {
      return [];
    }
  }

  function firstMatch(doc, selectors) {
    var list = Array.isArray(selectors) ? selectors : [selectors];
    for (var i = 0; i < list.length; i += 1) {
      var hit = queryOne(doc, list[i]);
      if (hit) return hit;
    }
    return null;
  }

  function isGeneric(text) {
    if (!text) return true;
    var lower = text.toLowerCase();
    for (var i = 0; i < RULES.dom.generic.length; i += 1) {
      if (lower === RULES.dom.generic[i]) return true;
    }
    return lower.length < 2;
  }

  /* ------------------------------------------------------------ layer (a) */

  function pickArtwork(artwork) {
    if (!artwork) return null;
    var list = Array.isArray(artwork) ? artwork : [artwork];
    var best = null;
    var bestArea = -1;
    for (var i = 0; i < list.length; i += 1) {
      var entry = list[i];
      var src = typeof entry === "string" ? entry : entry && entry.src;
      var url = cleanUrl(src);
      if (!url) continue;
      var area = -1;
      var sizes = typeof entry === "object" && entry ? entry.sizes : null;
      if (typeof sizes === "string") {
        var m = /^(\d+)\s*x\s*(\d+)$/.exec(sizes.trim());
        if (m) area = Number(m[1]) * Number(m[2]);
      }
      if (area < 0) area = i; // fall back to document order (later = larger)
      if (area >= bestArea) {
        bestArea = area;
        best = url;
      }
    }
    return best;
  }

  function readMediaSession(nav) {
    var md = nav && nav.mediaSession ? nav.mediaSession.metadata : null;
    if (!md) return null;
    var title = clean(md[RULES.mediaSession.title]);
    var series = null;
    for (var i = 0; i < RULES.mediaSession.series.length; i += 1) {
      var candidate = clean(md[RULES.mediaSession.series[i]]);
      if (candidate) {
        series = candidate;
        break;
      }
    }
    var artwork = pickArtwork(md.artwork);
    if (!title && !series && !artwork) return null;
    return { title: title, series: series, artwork: artwork };
  }

  /* ------------------------------------------------------------ layer (b) */

  function flattenJsonLd(data) {
    var out = [];
    if (!data) return out;
    if (Array.isArray(data)) {
      for (var i = 0; i < data.length; i += 1) out = out.concat(flattenJsonLd(data[i]));
      return out;
    }
    if (typeof data !== "object") return out;
    if (Array.isArray(data["@graph"])) {
      for (var g = 0; g < data["@graph"].length; g += 1) out = out.concat(flattenJsonLd(data["@graph"][g]));
    }
    if (data["@type"]) out.push(data);
    return out;
  }

  function typeNames(item) {
    var raw = item["@type"];
    var list = Array.isArray(raw) ? raw : [raw];
    var names = [];
    for (var i = 0; i < list.length; i += 1) {
      if (typeof list[i] === "string") names.push(list[i].toLowerCase());
    }
    return names;
  }

  function dig(item, path) {
    var parts = path.split(".");
    var cur = item;
    for (var i = 0; i < parts.length; i += 1) {
      if (!cur || typeof cur !== "object") return null;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function figureUrl(value) {
    if (!value) return null;
    if (typeof value === "string") return cleanUrl(value);
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i += 1) {
        var hit = figureUrl(value[i]);
        if (hit) return hit;
      }
      return null;
    }
    if (typeof value === "object") return cleanUrl(value.url || value.contentUrl);
    return null;
  }

  function readJsonLd(doc) {
    var nodes = queryAll(doc, RULES.jsonLd.script);
    var found = null;
    for (var n = 0; n < nodes.length; n += 1) {
      var raw = nodes[n].textContent;
      if (typeof raw !== "string" || !raw.trim()) continue;
      var data;
      try {
        data = JSON.parse(raw);
      } catch (_) {
        continue; // malformed JSON-LD is never fatal
      }
      var items = flattenJsonLd(data);
      for (var i = 0; i < items.length; i += 1) {
        var item = items[i];
        var names = typeNames(item);
        var wanted = false;
        for (var t = 0; t < names.length; t += 1) {
          if (RULES.jsonLd.types.indexOf(names[t]) !== -1) {
            wanted = true;
            break;
          }
        }
        if (!wanted) continue;
        var fields = RULES.jsonLd.fields;
        var name = clean(dig(item, fields.name));
        var series = clean(dig(item, fields.series));
        var season = number(dig(item, fields.season));
        var episode = number(dig(item, fields.episode));
        var artwork = null;
        for (var a = 0; a < fields.artwork.length; a += 1) {
          artwork = figureUrl(dig(item, fields.artwork[a]));
          if (artwork) break;
        }
        var seriesUrl = null;
        for (var u = 0; u < fields.seriesUrl.length; u += 1) {
          seriesUrl = figureUrl(dig(item, fields.seriesUrl[u]));
          if (seriesUrl) break;
        }
        var description = cleanSynopsis(dig(item, fields.description));
        if (
          !name &&
          !series &&
          season === null &&
          episode === null &&
          !artwork &&
          !seriesUrl &&
          !description
        ) {
          continue;
        }
        if (!found) {
          found = {
            name: null,
            series: null,
            season: null,
            episode: null,
            artwork: null,
            seriesUrl: null,
            description: null
          };
        }
        if (!found.name && name) found.name = name;
        if (!found.series && series) found.series = series;
        if (found.season === null && season !== null) found.season = season;
        if (found.episode === null && episode !== null) found.episode = episode;
        if (!found.artwork && artwork) found.artwork = artwork;
        if (!found.seriesUrl && seriesUrl) found.seriesUrl = seriesUrl;
        if (!found.description && description) found.description = description;
      }
    }
    return found;
  }

  /* ------------------------------------------------------------ layer (c) */

  function readMeta(doc) {
    var title = clean(attrOf(queryOne(doc, RULES.meta.title), "content"));
    var image =
      cleanUrl(attrOf(queryOne(doc, RULES.meta.image), "content")) ||
      cleanUrl(attrOf(queryOne(doc, RULES.meta.imageFallback), "content"));
    if (!title && !image) return null;
    return { title: title, image: image };
  }

  /* ------------------------------------------------------------ layer (d) */

  function parseTitleText(text) {
    if (!text) return null;
    for (var i = 0; i < RULES.title.patterns.length; i += 1) {
      var rule = RULES.title.patterns[i];
      var m = rule.re.exec(text);
      if (!m) continue;
      var season = rule.season ? number(m[rule.season]) : null;
      var episode = rule.episode ? number(m[rule.episode]) : null;
      if (episode === null) continue;
      var series = null;
      if (rule.deriveSeries) {
        var before = text
          .slice(0, m.index)
          .replace(/[\s\-–—:|,]+$/, "")
          .replace(/[([{]+$/, "")
          .trim();
        series = before && before.length >= 2 ? clean(before) : null;
      }
      return { season: season, episode: episode, series: series };
    }
    return null;
  }

  /* ------------------------------------------------------------ layer (e) */

  function ancestorHeading(video) {
    var node = video;
    for (var depth = 0; depth < RULES.dom.ancestorDepth; depth += 1) {
      if (!node || !node.parentElement) break;
      node = node.parentElement;
      for (var h = 0; h < RULES.dom.headings.length; h += 1) {
        var heading = queryOne(node, RULES.dom.headings[h]);
        var text = clean(textOf(heading));
        if (text && !isGeneric(text)) return text;
      }
    }
    return null;
  }

  function readDomText(doc, video) {
    var seriesText = clean(textOf(queryOne(doc, RULES.dom.series)));
    if (!seriesText || isGeneric(seriesText)) seriesText = ancestorHeading(video);
    if (!seriesText || isGeneric(seriesText)) seriesText = documentHeading(doc);

    var episodeText = clean(textOf(queryOne(doc, RULES.dom.episode)));
    if (!episodeText || isGeneric(episodeText)) episodeText = testIdText(doc);

    if (!seriesText && !episodeText) return null;
    return {
      series: seriesText && !isGeneric(seriesText) ? seriesText : null,
      episode: episodeText && !isGeneric(episodeText) ? episodeText : null
    };
  }

  function documentHeading(doc) {
    for (var h = 0; h < RULES.dom.headings.length; h += 1) {
      var text = clean(textOf(queryOne(doc, RULES.dom.headings[h])));
      if (text && !isGeneric(text)) return text;
    }
    return null;
  }

  function testIdText(doc) {
    var nodes = queryAll(doc, RULES.dom.testId);
    for (var i = 0; i < nodes.length; i += 1) {
      var text = clean(textOf(nodes[i]));
      if (text && !isGeneric(text) && text.length <= RULES.maxChars) return text;
    }
    return null;
  }

  /* ----------------------------------------------------------- direct links */

  function domSynopsis(doc) {
    for (var s = 0; s < RULES.synopsis.dom.length; s += 1) {
      var nodes = queryAll(doc, RULES.synopsis.dom[s]);
      for (var i = 0; i < nodes.length; i += 1) {
        var text = cleanSynopsis(textOf(nodes[i]));
        if (text) return text;
      }
    }
    return null;
  }

  function readSeriesUrl(ld, doc, base) {
    var fromLd = ld && ld.seriesUrl ? absoluteHttps(ld.seriesUrl, base) : null;
    if (fromLd) return fromLd;

    var fromButton = absoluteHttps(attrOf(queryOne(doc, RULES.dom.button), "href"), base);
    if (fromButton) return fromButton;

    var heading = queryOne(doc, RULES.dom.series);
    var node = heading ? heading.parentElement : null;
    for (var depth = 0; node && depth < RULES.dom.ancestorDepth; depth += 1) {
      if (String(node.tagName || "").toUpperCase() === "A") {
        var fromAnchor = absoluteHttps(attrOf(node, "href"), base);
        if (fromAnchor) return fromAnchor;
      }
      node = node.parentElement;
    }
    return null;
  }

  function readEpisodeUrl(doc, base) {
    var canonical = absoluteHttps(attrOf(queryOne(doc, RULES.meta.canonical), "href"), base);
    if (canonical) return canonical;

    var og = absoluteHttps(attrOf(queryOne(doc, RULES.meta.url), "content"), base);
    if (og) return og;

    if (base && RULES.dom.watchPath.test(base)) return absoluteHttps(base, null);
    return null;
  }

  function readSynopsis(ld, doc) {
    if (ld && ld.description) return ld.description;

    var ogDescription = cleanSynopsis(
      attrOf(queryOne(doc, RULES.meta.ogDescription), "content")
    );
    if (ogDescription) return ogDescription;

    var metaDescription = cleanSynopsis(
      stripWatchPrefix(attrOf(queryOne(doc, RULES.meta.description), "content"))
    );
    if (metaDescription) return metaDescription;

    return domSynopsis(doc);
  }

  /* ------------------------------------------------------------- assemble */

  function extract(doc, nav) {
    doc = doc || root.document || {};
    nav = nav || root.navigator || {};

    var out = {
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
    };
    var signals = out.signals;

    var href = "";
    if (doc.location && typeof doc.location.href === "string") href = doc.location.href;
    else if (root.location && typeof root.location.href === "string") href = root.location.href;

    // (e) the video element is the only playback truth
    var video = firstMatch(doc, RULES.dom.video);
    if (video) {
      out.hasVideo = true;
      signals.push("video");
      out.duration = finite(video.duration);
      out.position = finite(video.currentTime);
      out.paused = typeof video.paused === "boolean" ? video.paused : null;
      out.playbackRate = finite(video.playbackRate);
    }

    // (a) media session
    var session = readMediaSession(nav);
    if (session) {
      signals.push("mediaSession");
      if (session.title) out.episodeTitle = session.title;
      if (session.series) out.series = session.series;
      if (session.artwork) out.artworkUrl = session.artwork;
    }

    // (b) JSON-LD
    var ld = readJsonLd(doc);
    if (ld) {
      signals.push("jsonLd");
      if (!out.episodeTitle && ld.name) out.episodeTitle = ld.name;
      if (!out.series && ld.series) out.series = ld.series;
      if (out.seasonNumber === null && ld.season !== null) out.seasonNumber = ld.season;
      if (out.episodeNumber === null && ld.episode !== null) out.episodeNumber = ld.episode;
      if (!out.artworkUrl && ld.artwork) out.artworkUrl = ld.artwork;
    }

    // (c) open graph
    var meta = readMeta(doc);
    if (meta) {
      signals.push("og");
      if (!out.artworkUrl && meta.image) out.artworkUrl = meta.image;
    }

    // (d) title regexes, og:title first then document.title
    var titleSource = (meta && meta.title) || clean(doc.title);
    var parsed = parseTitleText(titleSource);
    if (!parsed && meta && meta.title) parsed = parseTitleText(clean(doc.title));
    if (parsed) {
      signals.push("title");
      if (out.seasonNumber === null) out.seasonNumber = parsed.season;
      if (out.episodeNumber === null) out.episodeNumber = parsed.episode;
      if (!out.series && parsed.series) out.series = parsed.series;
    } else if (!out.episodeTitle && meta && meta.title) {
      out.episodeTitle = meta.title;
    }

    // (e) DOM text fallbacks
    var dom = readDomText(doc, video);
    if (dom && (dom.series || dom.episode)) {
      signals.push("dom");
      if (!out.series && dom.series) out.series = dom.series;
      if (!out.episodeTitle && dom.episode) out.episodeTitle = dom.episode;
      if (!out.episodeTitle && dom.series && out.series !== dom.series) out.episodeTitle = dom.series;
    }

    // (e) watch URL / player button
    if (RULES.dom.watchPath.test(href)) signals.push("watchUrl");
    if (queryOne(doc, RULES.dom.button)) signals.push("button");

    // (f) direct links and synopsis: layered, lowest priority last, always nullable
    out.seriesUrl = readSeriesUrl(ld, doc, href);
    out.episodeUrl = readEpisodeUrl(doc, href);
    out.synopsis = readSynopsis(ld, doc);

    // normalise: strings capped and noise-stripped, numbers finite or null
    out.series = clean(out.series);
    out.episodeTitle = clean(out.episodeTitle);
    out.artworkUrl = cleanUrl(out.artworkUrl);
    out.seriesUrl = absoluteHttps(out.seriesUrl, href);
    out.episodeUrl = absoluteHttps(out.episodeUrl, href);
    out.synopsis = cleanSynopsis(out.synopsis);
    out.seasonNumber = number(out.seasonNumber);
    out.episodeNumber = number(out.episodeNumber);
    out.duration = finite(out.duration);
    out.position = finite(out.position);
    out.playbackRate = finite(out.playbackRate);

    return out;
  }

  root.CrunchyrollExtract = { extract: extract, RULES: RULES };
})(typeof globalThis !== "undefined" ? globalThis : this);
