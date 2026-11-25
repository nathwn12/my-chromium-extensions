/**
 * youtube-music-presence — YouTube Music extraction.
 *
 * Loaded by the manifest as a *classic* content script (Chrome cannot load
 * content scripts as ES modules), so it exposes `globalThis.YoutubeExtract`.
 * `content.js` consumes it; the test suite evaluates this file in a `vm`
 * sandbox with a fake document/navigator, so every DOM touch stays behind the
 * injected `doc` / `nav` / `loc` arguments.
 *
 * Rule of this file: never throw. Every field is nullable; a malformed page
 * yields nulls, never an exception. Playback comes from the real media
 * element (`<video>` or `<audio>`); duration is never invented.
 *
 * MediaSession values are trusted as-is: when the page publishes a title,
 * artist or album there, it is taken verbatim and only trimmed/collapsed like
 * every other string. The player-bar DOM outranks it for the artist and the
 * album because those come with the anchor the button opens.
 *
 * An artist is structural, never textual: only a `/channel/` anchor,
 * MediaSession's `artist`, or JSON-LD's `author` may name one. A byline
 * segment is never promoted to artist, so a localized count such as
 * `1,5 M vues` can never become one; a real name such as `50 Cent` is not
 * special-cased either — it survives only through one of those three sources.
 */
(function (root) {
  "use strict";

  /** Every tunable selector, regex and cap lives here. */
  /** The selected media element's source, kept local to this content script. */
  var chosenSource = null;

  var RULES = {
    maxChars: 256,
    maxUrlChars: 1024,

    hosts: {
      "youtube-music": ["music.youtube.com"]
    },

    eligibility: {
      requiresMediaId: []
    },

    noise: {
      suffixes: [" - YouTube Music", " - YouTube", " | YouTube"]
    },

    /** Two clocks this close together describe the same track. */
    timing: {
      toleranceSeconds: 1
    },

    views: {
      segment: /^\d[\d.,]*\s*[KMB]?\s*views?$/i
    },

    dom: {
      video: ["#movie_player video.html5-main-video", "video.html5-main-video", "video", "audio"],
      title: [
        "h1.ytd-watch-metadata yt-formatted-string",
        "h1.title yt-formatted-string",
        "h1 yt-formatted-string",
        "h1"
      ],
      channel: ["#owner #channel-name a", "ytd-channel-name a", "#channel-name a"],
      ogImage: 'meta[property="og:image"]',
      ogTitle: 'meta[property="og:title"]',
      musicTitle: "ytmusic-player-bar .title",
      musicByline: "ytmusic-player-bar .byline",
      musicTitleLink: ["ytmusic-player-bar .title a", ".middle-controls .title a"],
      musicBylineLinks: [".byline.ytmusic-player-bar a", "ytmusic-player-bar .subtitle a"],
      musicAlbumLink: [".complex-string.ytmusic-player-bar a"],
      musicTime: ["ytmusic-player-bar .time", "ytmusic-player-bar .time-info"],
      musicTimeScan: "ytmusic-player-bar *",
      trackIdFallbacks: ['a.ytp-title-link', 'link[rel="canonical"]'],
      musicArtwork: "ytmusic-player-bar img, ytmusic-player-bar img.image, #song-image img",
      jsonLd: 'script[type="application/ld+json"]'
    },

    jsonLd: {
      types: ["videoobject", "musicrecording"]
    }
  };


  function stripInvisible(value) {
    return String(value).replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u061C\u180E]/g, "");
  }

  function clean(value) {
    if (typeof value !== "string") return null;
    var text = stripInvisible(value).replace(/\s+/g, " ").trim();
    if (!text) return null;
    return text.length > RULES.maxChars ? text.slice(0, RULES.maxChars) : text;
  }

  /** document.title keeps the site suffix; the media title never does. */
  function cleanDocumentTitle(value) {
    var text = clean(value);
    if (!text) return null;
    var changed = true;
    while (changed) {
      changed = false;
      for (var i = 0; i < RULES.noise.suffixes.length; i += 1) {
        var suffix = RULES.noise.suffixes[i];
        if (text.length > suffix.length && text.slice(-suffix.length).toLowerCase() === suffix.toLowerCase()) {
          text = text.slice(0, -suffix.length).trim();
          changed = true;
        }
      }
    }
    return text || null;
  }

  /** Only absolute https URLs leave this file. */
  function httpsUrl(value) {
    if (typeof value !== "string") return null;
    var text = value.trim();
    if (!text) return null;
    var url = null;
    if (/^https:\/\//i.test(text)) url = text;
    else if (text.slice(0, 2) === "//") url = "https:" + text;
    if (!url) return null;
    return url.length > RULES.maxUrlChars ? url.slice(0, RULES.maxUrlChars) : url;
  }

  function finite(value) {
    if (value === null || value === undefined || value === "") return null;
    var n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  }

  /** True only for a whole segment that is a view count, never for a year. */
  function isViewCount(text) {
    return typeof text === "string" && RULES.views.segment.test(text);
  }

  function textOf(node) {
    if (!node) return null;
    try {
      var raw = node.textContent;
      if (typeof raw !== "string") return null;
      var text = raw.replace(/\s+/g, " ").trim();
      return text || null;
    } catch (_) {
      return null;
    }
  }

  function attrOf(node, name) {
    if (!node || typeof node.getAttribute !== "function") return null;
    try {
      return node.getAttribute(name);
    } catch (_) {
      return null;
    }
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

  /** Every anchor matched by any selector, in document order, deduplicated. */
  function collectAnchors(doc, selectors) {
    var list = Array.isArray(selectors) ? selectors : [selectors];
    var out = [];
    for (var s = 0; s < list.length; s += 1) {
      var hits = queryAll(doc, list[s]);
      for (var i = 0; i < hits.length; i += 1) {
        if (out.indexOf(hits[i]) === -1) out.push(hits[i]);
      }
    }
    return out;
  }


  function hrefOf(loc) {
    try {
      if (!loc) return null;
      if (typeof loc === "string") return loc.trim() || null;
      var href = loc.href;
      return typeof href === "string" && href.trim() ? href.trim() : null;
    } catch (_) {
      return null;
    }
  }

  function parseHref(href) {
    if (typeof href !== "string") return null;
    var m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)/i.exec(href);
    if (!m) return null;
    return { protocol: m[1].toLowerCase() + ":", host: m[2].toLowerCase().split(":")[0] };
  }

  function sourceForHref(href) {
    var parts = parseHref(href);
    if (!parts || parts.protocol !== "https:") return null;
    if (RULES.hosts["youtube-music"].indexOf(parts.host) !== -1) return "youtube-music";
    return null;
  }

  function mediaIdFrom(href) {
    if (typeof href !== "string") return null;
    var query = /[?&]v=([A-Za-z0-9_-]{11})(?:[&#]|$)/.exec(href);
    if (query) return query[1];
    var path = /\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/.exec(href);
    if (path) return path[1];
    return null;
  }

  /**
   * Resolve an anchor href against the current page URL. This file is a
   * classic content script evaluated in a bare `vm`, so the `URL` global does
   * not exist; scheme, origin and directory resolution are done by hand.
   * Unresolvable or dot-relative paths stay null: a wrong URL is worse than
   * none, and a link is never invented.
   */
  function absoluteUrl(href, base) {
    if (typeof href !== "string") return null;
    var raw = stripInvisible(href).trim();
    if (!raw) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : null;
    }
    var baseMatch = /^([a-z][a-z0-9+.-]*:)\/\/([^/?#]+)([^?#]*)/i.exec(
      typeof base === "string" ? stripInvisible(base).trim() : ""
    );
    if (!baseMatch) return null;
    if (raw.slice(0, 2) === "//") return baseMatch[1] + raw;
    if (raw.charAt(0) === ".") return null;
    var origin = baseMatch[1] + "//" + baseMatch[2];
    var basePath = baseMatch[3] || "/";
    if (raw.charAt(0) === "/") return origin + raw;
    if (raw.charAt(0) === "?" || raw.charAt(0) === "#") return origin + basePath + raw;
    var dir = basePath.slice(0, basePath.lastIndexOf("/") + 1) || "/";
    return origin + dir + raw;
  }

  /**
   * The path of an absolute URL, query and fragment dropped. Classification
   * must never read the query: `?next=/browse/MPRE…` is not an album link.
   */
  function pathOf(href) {
    if (typeof href !== "string") return null;
    var m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(stripInvisible(href).trim());
    if (!m) return null;
    return m[1] || "/";
  }

  function pathStartsWith(href, prefix) {
    var path = pathOf(href);
    return path !== null && path.slice(0, prefix.length) === prefix;
  }

  function pageUrlFor(href, source) {
    if (!href || !source) return null;
    var parts = parseHref(href);
    if (!parts || parts.protocol !== "https:") return null;
    if ((RULES.hosts[source] || []).indexOf(parts.host) === -1) return null;
    var url = stripInvisible(href).split("#")[0].trim();
    return url.length > RULES.maxUrlChars ? url.slice(0, RULES.maxUrlChars) : url;
  }


  /** `M:SS / M:SS` as the player bar shows it for the title in the same bar. */
  function parseClock(value) {
    var text = clean(value);
    if (!text) return null;
    var m = /^(\d{1,3}):([0-5]?\d)\s*\/\s*(\d{1,3}):([0-5]?\d)$/.exec(text);
    if (!m) return null;
    var position = Number(m[1]) * 60 + Number(m[2]);
    var duration = Number(m[3]) * 60 + Number(m[4]);
    if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return null;
    return { position: Math.min(position, duration), duration: duration };
  }

  /** Two displayed clocks that disagree; not the same as no clock at all. */
  var CLOCK_CONFLICT = { conflict: true };

  /**
   * A player-bar clock is evidence only when every displayed clock agrees.
   * The class list is a fast path; a pattern scan of the same player bar is
   * the fallback, so a markup rename cannot silently restore stale timing.
   * A disagreement is reported as a conflict: reading it as "no clock" would
   * fall through to the media element and stamp the stale pair it just caught.
   */
  function readMusicTime(doc) {
    var found = null;
    function consider(nodes) {
      for (var i = 0; i < nodes.length; i += 1) {
        var clock = parseClock(textOf(nodes[i]));
        if (!clock) continue;
        if (found && (found.position !== clock.position || found.duration !== clock.duration)) return false;
        found = clock;
      }
      return true;
    }
    var selectors = RULES.dom.musicTime;
    for (var s = 0; s < selectors.length; s += 1) {
      if (!consider(queryAll(doc, selectors[s]))) return CLOCK_CONFLICT;
    }
    if (!found && !consider(queryAll(doc, RULES.dom.musicTimeScan))) return CLOCK_CONFLICT;
    return found;
  }

  /** MediaSession playback is the page's own word, independent of a media element. */
  function readPlaybackState(nav) {
    try {
      var value = nav && nav.mediaSession ? nav.mediaSession.playbackState : null;
      return value === "playing" || value === "paused" ? value : null;
    } catch (_) {
      return null;
    }
  }

  function readVideoEntries(doc) {
    var els = queryAll(doc, RULES.dom.video);
    var out = [];
    for (var i = 0; i < els.length; i += 1) {
      var el = els[i];
      var duration = finite(el.duration);
      var position = finite(el.currentTime);
      if (duration !== null && duration > 0 && position !== null && position > duration) {
        position = duration;
      }
      out.push({
        duration: duration !== null && duration > 0 ? duration : null,
        elapsed: position,
        paused: typeof el.paused === "boolean" ? el.paused : true,
        rate: finite(el.playbackRate),
        source: typeof el.currentSrc === "string" && el.currentSrc
          ? el.currentSrc
          : typeof el.src === "string" && el.src ? el.src : null
      });
    }
    return out;
  }

  /**
   * Pick the media element that belongs to the current title. Document order
   * never decides: with a player-bar clock, only a matching duration is that
   * song's media element; without one, a lone playing element is the evidence.
   * Otherwise timing is withheld rather than borrowed from a stale, hidden or
   * paused element.
   */
  function chooseVideo(entries, musicTime) {
    if (!entries.length) return { entry: null, coherent: false, useClock: Boolean(musicTime) };
    var timed = [];
    for (var t = 0; t < entries.length; t += 1) {
      if (entries[t].duration !== null) timed.push(entries[t]);
    }
    if (!timed.length) return { entry: entries[0], coherent: false, useClock: Boolean(musicTime) };

    if (musicTime) {
      var matched = [];
      for (var m = 0; m < timed.length; m += 1) {
        if (Math.abs(timed[m].duration - musicTime.duration) <= RULES.timing.toleranceSeconds) {
          matched.push(timed[m]);
        }
      }
      return matched.length === 1 ? { entry: matched[0], coherent: true } : { entry: null, coherent: false };
    }

    var playing = [];
    for (var p = 0; p < timed.length; p += 1) {
      if (timed[p].paused === false) playing.push(timed[p]);
    }
    if (playing.length === 1) return { entry: playing[0], coherent: true };
    if (playing.length > 1) {
      for (var q = 1; q < playing.length; q += 1) {
        var sameElapsed = playing[q].elapsed === playing[0].elapsed ||
          (typeof playing[q].elapsed === "number" && typeof playing[0].elapsed === "number" &&
            Math.abs(playing[q].elapsed - playing[0].elapsed) <= RULES.timing.toleranceSeconds);
        if (Math.abs(playing[q].duration - playing[0].duration) > RULES.timing.toleranceSeconds || !sameElapsed) {
          return { entry: null, coherent: false };
        }
      }
      return { entry: playing[0], coherent: true };
    }
    if (timed.length === 1) return { entry: timed[0], coherent: true };
    return { entry: null, coherent: false };
  }


  function pickArtwork(artwork) {
    if (!artwork) return null;
    var list = Array.isArray(artwork) ? artwork : [artwork];
    var best = null;
    var bestArea = -1;
    for (var i = 0; i < list.length; i += 1) {
      var entry = list[i];
      var src = typeof entry === "string" ? entry : entry && entry.src;
      var url = httpsUrl(src);
      if (!url) continue;
      var area = i; // document order is the tiebreak
      var sizes = typeof entry === "object" && entry ? entry.sizes : null;
      if (typeof sizes === "string") {
        var m = /^(\d+)\s*x\s*(\d+)$/.exec(sizes.trim());
        if (m) area = Number(m[1]) * Number(m[2]);
      }
      if (area >= bestArea) {
        bestArea = area;
        best = url;
      }
    }
    return best;
  }

  function readMediaSession(nav) {
    try {
      var metadata = nav && nav.mediaSession ? nav.mediaSession.metadata : null;
      if (!metadata) return null;
      var session = {
        title: clean(metadata.title),
        artist: clean(metadata.artist),
        album: clean(metadata.album),
        artwork: pickArtwork(metadata.artwork)
      };
      if (!session.title && !session.artist && !session.album && !session.artwork) return null;
      return session;
    } catch (_) {
      return null;
    }
  }


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

  /** An author may be a string, a Person, or an array of either. */
  function authorName(value) {
    if (!value) return null;
    if (typeof value === "string") return clean(value);
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i += 1) {
        var hit = authorName(value[i]);
        if (hit) return hit;
      }
      return null;
    }
    if (typeof value === "object") return clean(value.name);
    return null;
  }

  function figureUrl(value) {
    if (!value) return null;
    if (typeof value === "string") return httpsUrl(value);
    if (Array.isArray(value)) {
      var best = null;
      var bestArea = -1;
      for (var i = 0; i < value.length; i += 1) {
        var entry = value[i];
        var url = figureUrl(entry);
        if (!url) continue;
        var area = i;
        var width = typeof entry === "object" && entry ? Number(entry.width) : Number.NaN;
        var height = typeof entry === "object" && entry ? Number(entry.height) : Number.NaN;
        if (Number.isFinite(width) && Number.isFinite(height)) area = width * height;
        if (area >= bestArea) {
          bestArea = area;
          best = url;
        }
      }
      return best;
    }
    if (typeof value === "object") return httpsUrl(value.url || value.contentUrl);
    return null;
  }

  function isoDuration(value) {
    if (typeof value !== "string") return null;
    var m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(
      value.trim()
    );
    if (!m) return null;
    var seconds =
      Number(m[1] || 0) * 86400 +
      Number(m[2] || 0) * 3600 +
      Number(m[3] || 0) * 60 +
      Number(m[4] || 0);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return Math.round(seconds * 1000) / 1000;
  }

  function readJsonLd(doc) {
    var nodes = queryAll(doc, RULES.dom.jsonLd);
    var found = null;
    for (var n = 0; n < nodes.length; n += 1) {
      var raw = textOf(nodes[n]);
      if (!raw) continue;
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

        var name = clean(dig(item, "name"));
        var author = authorName(dig(item, "author"));
        var artwork = figureUrl(dig(item, "thumbnailUrl")) || figureUrl(dig(item, "image"));
        var duration = isoDuration(dig(item, "duration"));
        if (!name && !author && !artwork && duration === null) continue;

        if (!found) found = { name: null, author: null, artwork: null, duration: null };
        if (!found.name && name) found.name = name;
        if (!found.author && author) found.author = author;
        if (!found.artwork && artwork) found.artwork = artwork;
        if (found.duration === null && duration !== null) found.duration = duration;
      }
    }
    return found;
  }


  function readYoutubeDom(doc) {
    return {
      title: clean(textOf(firstMatch(doc, RULES.dom.title))),
      channel: clean(textOf(firstMatch(doc, RULES.dom.channel))),
      artwork: httpsUrl(attrOf(queryOne(doc, RULES.dom.ogImage), "content"))
    };
  }

  function readMusicDom(doc, base) {
    var byline = clean(textOf(queryOne(doc, RULES.dom.musicByline)));
    var views = null;
    if (byline) {
      var parts = byline.split("•");
      for (var i = 0; i < parts.length; i += 1) {
        var segment = clean(parts[i]);
        if (segment && !views && isViewCount(segment)) views = segment;
      }
    }

    var anchors = collectAnchors(doc, RULES.dom.musicBylineLinks);
    var artistNames = [];
    var artistUrl = null;
    var artistSeen = false;
    var albumAnchor = null;
    var albumHref = null;
    for (var a = 0; a < anchors.length; a += 1) {
      var anchor = anchors[a];
      var href = attrOf(anchor, "href");
      var resolved = href ? absoluteUrl(href, base) : null;
      if (!resolved) continue;
      if (pathStartsWith(resolved, "/channel/")) {
        if (!artistSeen) {
          artistSeen = true;
          artistUrl = pageUrlFor(resolved, "youtube-music");
        }
        var name = clean(textOf(anchor));
        if (name) artistNames.push(name);
      }
      if (!albumAnchor && pathStartsWith(resolved, "/browse/MPRE")) {
        albumAnchor = anchor;
        albumHref = resolved;
      }
    }
    if (!albumAnchor) {
      var fallbackAnchors = queryAll(doc, RULES.dom.musicAlbumLink);
      for (var f = fallbackAnchors.length - 1; f >= 0; f -= 1) {
        var fallbackHref = absoluteUrl(attrOf(fallbackAnchors[f], "href"), base);
        if (fallbackHref && pathStartsWith(fallbackHref, "/browse/MPRE")) {
          albumAnchor = fallbackAnchors[f];
          albumHref = fallbackHref;
          break;
        }
      }
    }

    var trackId = null;
    var titleLink = firstMatch(doc, RULES.dom.musicTitleLink);
    if (titleLink) trackId = mediaIdFrom(attrOf(titleLink, "href"));
    var fallbacks = RULES.dom.trackIdFallbacks;
    for (var t = 0; t < fallbacks.length && !trackId; t += 1) {
      var fallbackNode = queryOne(doc, fallbacks[t]);
      trackId = fallbackNode ? mediaIdFrom(attrOf(fallbackNode, "href")) : null;
    }
    if (!trackId) trackId = mediaIdFrom(base);

    return {
      title: clean(textOf(queryOne(doc, RULES.dom.musicTitle))),
      channel: artistNames.length ? clean(artistNames.join("; ")) : null,
      album: albumAnchor ? clean(textOf(albumAnchor)) : null,
      views: views,
      artwork: httpsUrl(attrOf(firstMatch(doc, RULES.dom.musicArtwork), "src")),
      artistUrl: artistUrl,
      albumUrl: albumAnchor ? pageUrlFor(albumHref, "youtube-music") : null,
      trackId: trackId
    };
  }


  function safeDocumentTitle(doc) {
    try {
      return doc ? cleanDocumentTitle(doc.title) : null;
    } catch (_) {
      return null;
    }
  }

  function safeVisible(doc) {
    try {
      return Boolean(doc) && doc.visibilityState === "visible";
    } catch (_) {
      return false;
    }
  }

  function readUnsafe(doc, nav, loc) {
    chosenSource = null;
    var href = hrefOf(loc);
    if (!href) href = hrefOf(doc && doc.location);

    var source = sourceForHref(href);
    if (!source) return null;
    var requiresMediaId = RULES.eligibility.requiresMediaId.indexOf(source) !== -1;
    var mediaId = mediaIdFrom(href);
    if (requiresMediaId && !mediaId) return null;

    var clock = readMusicTime(doc);
    var clockConflict = clock === CLOCK_CONFLICT;
    var musicTime = clockConflict ? null : clock;
    var playbackState = readPlaybackState(nav);
    var chosen = clockConflict
      ? { entry: null, coherent: false, conflict: true }
      : chooseVideo(readVideoEntries(doc), musicTime);
    var pick = chosen.entry;
    chosenSource = chosen.coherent && pick ? pick.source : null;
    var session = readMediaSession(nav);
    var ld = readJsonLd(doc);
    var dom = readMusicDom(doc, href);
    var ogTitle = clean(attrOf(queryOne(doc, RULES.dom.ogTitle), "content"));
    var documentTitle = safeDocumentTitle(doc);

    var title = (session && session.title) || dom.title || (ld && ld.name) || ogTitle || documentTitle;
    var channel = dom.channel || (session && session.artist) || (ld && ld.author);
    var album = dom.album || (session && session.album);
    var artwork = (session && session.artwork) || dom.artwork || (ld && ld.artwork);

    if (!title) return null;

    var trackId = dom.trackId || mediaId;
    var trackUrl = trackId ? "https://music.youtube.com/watch?v=" + trackId : null;

    var duration = null;
    var position = null;
    if (chosen.coherent && pick && pick.duration !== null) {
      duration = pick.duration;
      position = pick.elapsed;
    } else if (!clockConflict && chosen.useClock && musicTime) {
      duration = musicTime.duration;
      position = musicTime.position;
    } else if (!clockConflict && !musicTime && ld) {
      duration = ld.duration;
    }
    if (duration !== null && position !== null && position > duration) position = duration;

    var paused = chosen.coherent && pick ? pick.paused
      : playbackState === "playing" ? false
      : playbackState === "paused" ? true
      : true;

    return {
      title: title || null,
      channel: channel || null,
      album: album || null,
      views: dom.views || null,
      artworkUrl: artwork || null,
      trackUrl: trackUrl,
      artistUrl: dom.artistUrl,
      albumUrl: dom.albumUrl,
      pageUrl: pageUrlFor(href, source),
      mediaId: mediaId,
      duration: duration,
      position: position,
      paused: paused,
      playbackRate: pick ? pick.rate : null,
      visible: safeVisible(doc)
    };
  }

  function read(doc, nav, loc) {
    try {
      return readUnsafe(doc, nav, loc);
    } catch (_) {
      return null;
    }
  }

  root.YoutubeExtract = {
    sourceForLocation: function (loc) {
      try {
        return sourceForHref(hrefOf(loc));
      } catch (_) {
        return null;
      }
    },
    /** Local-only evidence: which media source the last read actually used. */
    mediaSourceOf: function () {
      return chosenSource;
    },
    read: read
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
