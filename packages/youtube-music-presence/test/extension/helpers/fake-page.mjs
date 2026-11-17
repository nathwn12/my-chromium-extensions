import { createContext, runInContext } from "node:vm";

/**
 * Tiny fake page for the YouTube extractor and content script.
 * No jsdom, no dependencies.
 *
 * Selector grammar supported: descendant (`a b`), child (`a > b`), tag,
 * `#id`, `.class`, `[attr]`, `[attr="value"]` (and the `*`, `^`, `$`, `~`, `|`
 * operators), comma lists.
 */

function parseCompound(token) {
  const compound = { tag: "", id: null, classes: [], attrs: [] };
  let rest = token;
  const tagMatch = /^(\*|[a-zA-Z][a-zA-Z0-9-]*)/.exec(rest);
  if (tagMatch) {
    compound.tag = tagMatch[1] === "*" ? "" : tagMatch[1].toLowerCase();
    rest = rest.slice(tagMatch[1].length);
  }
  const partRe = /#([\w-]+)|\.([\w-]+)|\[([a-zA-Z0-9_:.-]+)(?:([*^$~|]?)=["']?([^"'\]]*)["']?(?:\s+([iIsS]))?)?\]/g;
  let m;
  while ((m = partRe.exec(rest))) {
    if (m[1]) compound.id = m[1];
    else if (m[2]) compound.classes.push(m[2]);
    else {
      compound.attrs.push({
        name: m[3],
        op: m[4] || "",
        value: m[5],
        insensitive: Boolean(m[6])
      });
    }
  }
  return compound;
}

function tokenizeChain(text) {
  const tokens = [];
  let current = "";
  let inBracket = false;
  let quote = null;
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "[") inBracket = true;
    if (ch === "]") inBracket = false;
    if (!inBracket && (ch === ">" || /\s/.test(ch))) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      if (ch === ">") tokens.push(">");
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function parseChain(text) {
  const steps = [];
  const tokens = tokenizeChain(text);
  let combinator = " ";
  for (const token of tokens) {
    if (token === ">") {
      combinator = ">";
      continue;
    }
    steps.push({ compound: parseCompound(token), combinator });
    combinator = " ";
  }
  return steps;
}

function parseSelector(selector) {
  return String(selector)
    .split(",")
    .map((part) => parseChain(part.trim()))
    .filter((chain) => chain.length > 0);
}

function matchesCompound(node, compound) {
  if (compound.tag && node.tagName.toLowerCase() !== compound.tag) return false;
  if (compound.id && node.attrs.id !== compound.id) return false;
  if (compound.classes.length) {
    const classes = String(node.attrs.class || "").split(/\s+/).filter(Boolean);
    for (const name of compound.classes) if (!classes.includes(name)) return false;
  }
  for (const attr of compound.attrs) {
    if (!(attr.name in node.attrs)) return false;
    if (attr.value === undefined) continue;
    const raw = String(node.attrs[attr.name]);
    const actual = attr.insensitive ? raw.toLowerCase() : raw;
    const wanted = attr.insensitive ? attr.value.toLowerCase() : attr.value;
    switch (attr.op) {
      case "*":
        if (!actual.includes(wanted)) return false;
        break;
      case "^":
        if (!actual.startsWith(wanted)) return false;
        break;
      case "$":
        if (!actual.endsWith(wanted)) return false;
        break;
      case "~":
        if (!actual.split(/\s+/).includes(wanted)) return false;
        break;
      case "|":
        if (actual !== wanted && !actual.startsWith(`${wanted}-`)) return false;
        break;
      default:
        if (actual !== wanted) return false;
    }
  }
  return true;
}

function matchesChain(node, steps) {
  let index = steps.length - 1;
  if (!matchesCompound(node, steps[index].compound)) return false;

  let current = node;
  index -= 1;
  while (index >= 0) {
    const combinator = steps[index + 1].combinator;
    const wanted = steps[index].compound;
    current = current.parentElement;
    if (combinator === ">") {
      if (!current || !matchesCompound(current, wanted)) return false;
    } else {
      while (current && !matchesCompound(current, wanted)) current = current.parentElement;
      if (!current) return false;
    }
    index -= 1;
  }
  return true;
}

function matches(node, selector) {
  return parseSelector(selector).some((chain) => matchesChain(node, chain));
}

function walk(node, visit) {
  for (const child of node.children) {
    if (visit(child) === false) return false;
    if (walk(child, visit) === false) return false;
  }
  return true;
}

export class FakeNode {
  constructor(tagName, { attrs = {}, text = "", props = {}, children = [] } = {}) {
    this.tagName = String(tagName).toUpperCase();
    this.attrs = { ...attrs };
    this.text = text;
    this.children = [];
    this.parentElement = null;
    Object.assign(this, props);
    for (const child of children) this.append(child);
  }

  append(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  getAttribute(name) {
    return name in this.attrs ? this.attrs[name] : null;
  }

  get textContent() {
    const own = this.text || "";
    return this.children.map((child) => child.textContent).join("") + own;
  }

  set textContent(value) {
    this.text = String(value);
    this.children = [];
  }

  querySelectorAll(selector) {
    const found = [];
    walk(this, (node) => {
      if (matches(node, selector)) found.push(node);
      return true;
    });
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

export function node(tagName, options) {
  return new FakeNode(tagName, options);
}

/** `<video>` with playback state; Chrome exposes these as own properties. */
export function video(props = {}) {
  return node("video", {
    attrs: { class: "html5-main-video" },
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

/** `<audio>` with playback state: the Music song path. Same shape as video. */
export function audio(props = {}) {
  return node("audio", {
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

export function meta(property, content) {
  return node("meta", { attrs: { property, content } });
}

export function namedMeta(name, content) {
  return node("meta", { attrs: { name, content } });
}

export function jsonLd(obj) {
  return node("script", {
    attrs: { type: "application/ld+json" },
    text: typeof obj === "string" ? obj : JSON.stringify(obj)
  });
}

/** YouTube watch-page furniture: h1 + owner block + og:image. */
export function youtubePage({
  title = "Never Gonna Give You Up",
  channel = "Rick Astley",
  image = "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
  ...rest
} = {}) {
  const children = [];
  if (title !== null) {
    children.push(
      node("h1", {
        attrs: { class: "ytd-watch-metadata" },
        children: [node("yt-formatted-string", { text: title })]
      })
    );
  }
  if (channel !== null) {
    children.push(
      node("div", {
        attrs: { id: "owner" },
        children: [
          node("div", {
            attrs: { id: "channel-name" },
            children: [node("a", { text: channel })]
          })
        ]
      })
    );
  }
  if (image !== null) children.push(meta("og:image", image));
  for (const child of rest.children || []) children.push(child);
  return makePage({ ...rest, children });
}

/** YouTube Music player-bar furniture: title, byline, artwork. */
export function musicPage({ title, byline, artwork, ...rest } = {}) {
  const barChildren = [];
  if (title !== null && title !== undefined) {
    barChildren.push(
      node("div", {
        attrs: { class: "title" },
        // A node is already the <a> YT Music puts inside the title cell.
        ...(typeof title === "string" ? { text: title } : { children: [title] })
      })
    );
  }
  if (byline !== null && byline !== undefined) {
    const parts = Array.isArray(byline) ? byline : [byline];
    barChildren.push(
      node("div", {
        // Live YT Music carries both classes on the byline element.
        attrs: { class: "byline ytmusic-player-bar" },
        children: parts.map((part) =>
          typeof part === "string" ? node("span", { text: part }) : part
        )
      })
    );
  }
  if (artwork) {
    barChildren.push(node("img", { attrs: { src: artwork, class: "image" } }));
  }
  const children = [node("ytmusic-player-bar", { children: barChildren })];
  for (const child of rest.children || []) children.push(child);
  return makePage({
    href: "https://music.youtube.com/watch?v=aqz-KE-bpKQ",
    ...rest,
    children
  });
}

/**
 * A page is a document + navigator, each with a listener registry the tests
 * dispatch into by hand. `setHref` rewrites the shared location object.
 */
export function makePage({
  href = "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
  title = "",
  visibilityState = "visible",
  readyState = "complete",
  children = [],
  mediaSession = null
} = {}) {
  const root = node("#root", { children: [] });
  for (const child of children) root.append(child);

  const docListeners = new Map();
  const winListeners = new Map();

  const location = { href };

  const doc = {
    title,
    readyState,
    visibilityState,
    location,
    documentElement: root,
    querySelector: (selector) => root.querySelector(selector),
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = docListeners.get(type) || [];
      const at = list.indexOf(fn);
      if (at !== -1) list.splice(at, 1);
    }
  };

  const win = {
    location,
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = winListeners.get(type) || [];
      const at = list.indexOf(fn);
      if (at !== -1) list.splice(at, 1);
    }
  };

  const navigator = {
    mediaSession: mediaSession ? { metadata: mediaSession } : null
  };

  function dispatchFrom(map, type, event = {}) {
    for (const fn of [...(map.get(type) || [])]) {
      fn(Object.assign({ type, target: event.target || doc }, event));
    }
  }

  return {
    doc,
    win,
    navigator,
    location,
    root,
    setHref(next) {
      location.href = next;
    },
    setVisibility(next) {
      doc.visibilityState = next;
    },
    dispatchOnDoc(type, event) {
      dispatchFrom(docListeners, type, event);
    },
    dispatchOnWindow(type, event) {
      dispatchFrom(winListeners, type, event);
    }
  };
}

/**
 * Evaluate the classic scripts in one vm context, with a fake `chrome` and
 * timers the test drives. Returns the message log plus controls.
 */
export function loadContent({ extractSource, contentSource, page, sendMessage, top, storage }) {
  const messages = [];
  const record = (message) => {
    // Content runs in a vm realm; round-trip proves the payload is wire-serializable.
    messages.push(JSON.parse(JSON.stringify(message)));
  };
  const chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(message, callback) {
        if (sendMessage) sendMessage(message, record);
        else record(message);
        if (typeof callback === "function") callback();
      }
    }
  };
  // Only the storage-aware tests carry a `chrome.storage`; every other test
  // boots the content script with the surface a real content script can always
  // count on, which is why the script guards the read.
  if (storage) chrome.storage = storage;

  const intervals = new Map();
  const timeouts = new Map();
  let seq = 0;

  const sandbox = {
    document: page.doc,
    window: page.win,
    location: page.location,
    navigator: page.navigator,
    top,
    chrome,
    setInterval(fn, ms) {
      seq += 1;
      intervals.set(seq, { fn, ms, active: true });
      return seq;
    },
    clearInterval(id) {
      const entry = intervals.get(id);
      if (entry) entry.active = false;
    },
    setTimeout(fn, ms) {
      seq += 1;
      timeouts.set(seq, { fn, ms, active: true });
      return seq;
    },
    clearTimeout(id) {
      const entry = timeouts.get(id);
      if (entry) entry.active = false;
    }
  };

  const context = createContext(sandbox);
  runInContext(extractSource, context, { filename: "extract-youtube.js" });
  runInContext(contentSource, context, { filename: "content.js" });

  return {
    messages,
    page,
    /** Run every live interval callback once (the 1 s poll). */
    poll() {
      for (const entry of intervals.values()) {
        if (entry.active) entry.fn();
      }
    },
    intervalDelays() {
      return [...intervals.values()].filter((entry) => entry.active).map((entry) => entry.ms);
    },
    /** Run every live timeout in registration order. */
    flush() {
      for (const entry of [...timeouts.values()]) {
        if (!entry.active) continue;
        entry.active = false;
        entry.fn();
      }
    },
    pendingTimeouts() {
      return [...timeouts.values()].filter((entry) => entry.active).length;
    }
  };
}
