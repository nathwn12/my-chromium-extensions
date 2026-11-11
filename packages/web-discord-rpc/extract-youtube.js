/**
 * web-discord-rpc — YouTube Music extraction.
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
 */
(function (root) {
  "use strict";

  /** Every tunable selector, regex and cap lives here. */
  var RULES = {
    // The activity builder caps details/state at 128; extraction stays above it.
    maxChars: 256,
    maxUrlChars: 1024,

    hosts: {
      "youtube-music": ["music.youtube.com"]
    },

    // YouTube Music keeps one persistent player bar across Home, Explore and
    // shelves and its SPA never rewrites the URL with `?v=`, so every page on
    // the host is eligible and a resolved title stands in for the missing id.
    // No media id is ever required.
    eligibility: {
      requiresMediaId: []
    },

    // The <title> suffix the site appends; never part of the media title.
    noise: {
      suffixes: [" - YouTube Music", " - YouTube", " | YouTube"]
    },

    dom: {
      // live probe: the Music player is an audio element on song pages (video
      // on video pages); read whichever media element is present so timestamps
      // come from the real clock, never invented.
      video: ["#movie_player video.html5-main-video", "video.html5-main-video", "video", "audio"],
      // live probe: the watch h1 is the title, #owner #channel-name a the channel
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
      // The title anchor is the canonical track id on the persistent player.
      musicTitleLink: ["ytmusic-player-bar .title a", ".middle-controls .title a"],
      // Byline anchors are classified in code: /channel/ is an artist,
      // /browse/MPRE an album. No :last-child and no [href] selectors.
      musicBylineLinks: [".byline.ytmusic-player-bar a", "ytmusic-player-bar .subtitle a"],
      musicAlbumLink: [".complex-string.ytmusic-player-bar a"],
      // Fallbacks when the player-bar title anchor is missing.
      trackIdFallbacks: ['a.ytp-title-link', 'link[rel="canonical"]'],
      musicArtwork: "ytmusic-player-bar img, ytmusic-player-bar img.image, #song-image img",
      jsonLd: 'script[type="application/ld+json"]'
    },

    jsonLd: {
      types: ["videoobject", "musicrecording"]
    }
  };

  /* ---------------------------------------------------------------- utils */

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

  /* ---------------------------------------------------------------- urls */

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

  function pageUrlFor(href, source) {
    if (!href || !source) return null;
    var parts = parseHref(href);
    if (!parts || parts.protocol !== "https:") return null;
    if ((RULES.hosts[source] || []).indexOf(parts.host) === -1) return null;
    var url = stripInvisible(href).split("#")[0].trim();
    return url.length > RULES.maxUrlChars ? url.slice(0, RULES.maxUrlChars) : url;
  }

  /* ------------------------------------------------------------ playback */

  function readVideo(doc) {
    var el = firstMatch(doc, RULES.dom.video);
    if (!el) return { elapsed: null, length: null, paused: true, rate: null };

    var duration = finite(el.duration);
    var position = finite(el.currentTime);
    if (duration !== null && duration > 0 && position !== null && position > duration) {
      position = duration;
    }
    return {
      elapsed: position,
      length: duration !== null && duration > 0 ? duration : null,
      paused: typeof el.paused === "boolean" ? el.paused : true,
      rate: finite(el.playbackRate)
    };
  }

  /* --------------------------------------------------------- mediaSession */

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

  /* -------------------------------------------------------------- JSON-LD */

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

  /* ------------------------------------------------------------- dom text */

  function readYoutubeDom(doc) {
    return {
      title: clean(textOf(firstMatch(doc, RULES.dom.title))),
      channel: clean(textOf(firstMatch(doc, RULES.dom.channel))),
      artwork: httpsUrl(attrOf(queryOne(doc, RULES.dom.ogImage), "content"))
    };
  }

  function readMusicDom(doc, base) {
    // A byline without anchors still names the artist and album as text; it is
    // the last fallback after the anchors and MediaSession.
    var byline = clean(textOf(queryOne(doc, RULES.dom.musicByline)));
    var segmentChannel = null;
    var segmentAlbum = null;
    if (byline) {
      var parts = byline.split("•");
      var segments = [];
      for (var i = 0; i < parts.length; i += 1) {
        var segment = clean(parts[i]);
        if (segment) segments.push(segment);
      }
      if (segments.length) segmentChannel = segments[0];
      if (segments.length >= 2 && !/^\d{4}$/.test(segments[1])) segmentAlbum = segments[1];
    }

    // Anchors are classified by their resolved href: /channel/ is an artist,
    // /browse/MPRE an album. Playlist ids (/browse/VL…) never match.
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
      if (resolved.indexOf("/channel/") !== -1) {
        // The first channel anchor decides artistUrl; a rejected host stays null.
        if (!artistSeen) {
          artistSeen = true;
          artistUrl = pageUrlFor(resolved, "youtube-music");
        }
        var name = clean(textOf(anchor));
        if (name) artistNames.push(name);
      }
      if (!albumAnchor && resolved.indexOf("/browse/MPRE") !== -1) {
        albumAnchor = anchor;
        albumHref = resolved;
      }
    }
    if (!albumAnchor) {
      // No album anchor in the byline: keep the last album link in the
      // complex-string, never a playlist id.
      var fallbackAnchors = queryAll(doc, RULES.dom.musicAlbumLink);
      for (var f = fallbackAnchors.length - 1; f >= 0; f -= 1) {
        var fallbackHref = absoluteUrl(attrOf(fallbackAnchors[f], "href"), base);
        if (fallbackHref && fallbackHref.indexOf("/browse/MPRE") !== -1) {
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
      segmentChannel: segmentChannel,
      album: albumAnchor ? clean(textOf(albumAnchor)) : null,
      segmentAlbum: segmentAlbum,
      artwork: httpsUrl(attrOf(firstMatch(doc, RULES.dom.musicArtwork), "src")),
      artistUrl: artistUrl,
      albumUrl: albumAnchor ? pageUrlFor(albumHref, "youtube-music") : null,
      trackId: trackId
    };
  }

  /* ------------------------------------------------------------- assemble */

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
    var href = hrefOf(loc);
    if (!href) href = hrefOf(doc && doc.location);

    var source = sourceForHref(href);
    if (!source) return null;
    var requiresMediaId = RULES.eligibility.requiresMediaId.indexOf(source) !== -1;
    var mediaId = mediaIdFrom(href);
    if (requiresMediaId && !mediaId) return null;

    var video = readVideo(doc);
    var session = readMediaSession(nav);
    var ld = readJsonLd(doc);
    var dom = readMusicDom(doc, href);
    var ogTitle = clean(attrOf(queryOne(doc, RULES.dom.ogTitle), "content"));
    var documentTitle = safeDocumentTitle(doc);

    // Music precedence: session first, then the player bar, JSON-LD, OG, title.
    var title = (session && session.title) || dom.title || (ld && ld.name) || ogTitle || documentTitle;
    // Artist anchors outrank the session; a byline without anchors falls back
    // to MediaSession's artist, then to the byline's first segment.
    var channel = dom.channel || (session && session.artist) || dom.segmentChannel || (ld && ld.author);
    // Album text and album URL come from the same matched anchor, so the
    // tooltip can never name an album the link does not open.
    var album = dom.album || (session && session.album) || dom.segmentAlbum;
    var artwork = (session && session.artwork) || dom.artwork || (ld && ld.artwork);

    // A resolved title is the proof that the persistent player is present;
    // without it there is nothing to show.
    if (!title) return null;

    // The canonical track URL is rebuilt from the id, never copied from an
    // address bar that may still be sitting on Home or Explore.
    var trackId = dom.trackId || mediaId;
    var trackUrl = trackId ? "https://music.youtube.com/watch?v=" + trackId : null;

    var duration = video.length !== null ? video.length : ld ? ld.duration : null;
    var position = video.elapsed;
    if (duration !== null && position !== null && position > duration) position = duration;

    return {
      title: title || null,
      channel: channel || null,
      album: album || null,
      artworkUrl: artwork || null,
      trackUrl: trackUrl,
      artistUrl: dom.artistUrl,
      albumUrl: dom.albumUrl,
      pageUrl: pageUrlFor(href, source),
      mediaId: mediaId,
      duration: duration,
      position: position,
      paused: video.paused,
      playbackRate: video.rate,
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
    read: read
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
