/**
 * Tiny fake UI for the popup and options controllers. No jsdom, no dependencies.
 *
 * It parses the markup that actually ships, then imports the controller module
 * for real (with a cache-busting query) so a failure means the shipped module
 * graph or the shipped markup is wrong, not that a re-implementation drifted.
 *
 * The DOM surface is deliberately small: attributes, dataset, hidden, value,
 * checked, disabled, textContent, element lookup and listener dispatch. The
 * controllers may only use what is here, and `ui.test.mjs` proves they do.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const ATTR_RE = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const ENTITY_RE = /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi;
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

function decodeEntities(text) {
  return String(text).replace(ENTITY_RE, (whole, code) => {
    if (code[0] === "#") {
      const value = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : whole;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? whole;
  });
}

function parseAttributes(text) {
  const attrs = {};
  for (const match of String(text || "").matchAll(ATTR_RE)) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attrs[name] = decodeEntities(value);
  }
  return attrs;
}

/* ------------------------------------------------------------- selectors -- */

const SELECTOR_CACHE = new Map();

function parseCompound(token) {
  const compound = { tag: "", id: null, classes: [], attrs: [] };
  let rest = token;
  const tagMatch = /^(\*|[a-zA-Z][a-zA-Z0-9-]*)/.exec(rest);
  if (tagMatch) {
    compound.tag = tagMatch[1] === "*" ? "" : tagMatch[1].toLowerCase();
    rest = rest.slice(tagMatch[1].length);
  }
  const partRe = /#([\w-]+)|\.([\w-]+)|\[([a-zA-Z0-9_:.-]+)(?:([*^$~|]?)=["']?([^"'\]]*)["']?)?\]/g;
  let match;
  while ((match = partRe.exec(rest))) {
    if (match[1]) compound.id = match[1];
    else if (match[2]) compound.classes.push(match[2]);
    else compound.attrs.push({ name: match[3].toLowerCase(), op: match[4] || "", value: match[5] });
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
  let combinator = " ";
  for (const token of tokenizeChain(text)) {
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
  const key = String(selector);
  const cached = SELECTOR_CACHE.get(key);
  if (cached) return cached;
  const parsed = key
    .split(",")
    .map((part) => parseChain(part.trim()))
    .filter((chain) => chain.length > 0);
  SELECTOR_CACHE.set(key, parsed);
  return parsed;
}

function compoundMatches(node, compound) {
  if (compound.tag && node.tagName.toLowerCase() !== compound.tag) return false;
  if (compound.id && node.attrs.id !== compound.id) return false;
  if (compound.classes.length) {
    const classes = String(node.attrs.class || "").split(/\s+/).filter(Boolean);
    for (const name of compound.classes) if (!classes.includes(name)) return false;
  }
  for (const attr of compound.attrs) {
    if (!(attr.name in node.attrs)) return false;
    if (attr.value === undefined) continue;
    const actual = String(node.attrs[attr.name]);
    switch (attr.op) {
      case "*":
        if (!actual.includes(attr.value)) return false;
        break;
      case "^":
        if (!actual.startsWith(attr.value)) return false;
        break;
      case "$":
        if (!actual.endsWith(attr.value)) return false;
        break;
      case "~":
        if (!actual.split(/\s+/).includes(attr.value)) return false;
        break;
      case "|":
        if (actual !== attr.value && !actual.startsWith(`${attr.value}-`)) return false;
        break;
      default:
        if (actual !== attr.value) return false;
    }
  }
  return true;
}

function chainMatches(node, steps) {
  let index = steps.length - 1;
  if (!compoundMatches(node, steps[index].compound)) return false;
  let current = node;
  index -= 1;
  while (index >= 0) {
    const combinator = steps[index + 1].combinator;
    const wanted = steps[index].compound;
    current = current.parentElement;
    if (combinator === ">") {
      if (!current || !compoundMatches(current, wanted)) return false;
    } else {
      while (current && !compoundMatches(current, wanted)) current = current.parentElement;
      if (!current) return false;
    }
    index -= 1;
  }
  return true;
}

function selectorMatches(node, selector) {
  return parseSelector(selector).some((chain) => chainMatches(node, chain));
}

/* ------------------------------------------------------------------ node -- */

function dataAttribute(key) {
  return `data-${String(key).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

function walk(node, visit) {
  for (const child of node.children) {
    if (visit(child) === false) return false;
    if (walk(child, visit) === false) return false;
  }
  return true;
}

export class UiNode {
  constructor(tagName, text = "") {
    this.tagName = String(tagName).toUpperCase();
    this.attrs = {};
    this.children = [];
    this.parentElement = null;
    this._text = text;
    this._listeners = new Map();
    this._checked = undefined;
    this.focused = false;
    this.ownerDocument = null;
  }

  get id() {
    return this.attrs.id || "";
  }

  get nodeType() {
    return this.tagName === "#TEXT" ? 3 : 1;
  }

  get dataset() {
    return new Proxy(this, {
      get: (node, key) =>
        typeof key === "symbol" || key === "then" ? undefined : node.attrs[dataAttribute(key)],
      set: (node, key, value) => {
        node.attrs[dataAttribute(key)] = String(value);
        return true;
      },
      has: (node, key) => typeof key === "string" && dataAttribute(key) in node.attrs,
      deleteProperty: (node, key) => {
        delete node.attrs[dataAttribute(key)];
        return true;
      },
    });
  }

  get hidden() {
    return "hidden" in this.attrs;
  }

  set hidden(value) {
    if (value) this.attrs.hidden = "";
    else delete this.attrs.hidden;
  }

  get disabled() {
    return "disabled" in this.attrs;
  }

  set disabled(value) {
    if (value) this.attrs.disabled = "";
    else delete this.attrs.disabled;
  }

  get value() {
    return "value" in this.attrs ? this.attrs.value : "";
  }

  set value(next) {
    this.attrs.value = String(next);
  }

  get checked() {
    return this._checked ?? "checked" in this.attrs;
  }

  set checked(next) {
    this._checked = Boolean(next);
  }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    return key in this.attrs ? this.attrs[key] : null;
  }

  setAttribute(name, value) {
    this.attrs[String(name).toLowerCase()] = String(value);
  }

  removeAttribute(name) {
    delete this.attrs[String(name).toLowerCase()];
  }

  hasAttribute(name) {
    return String(name).toLowerCase() in this.attrs;
  }

  get textContent() {
    return this.children.map((child) => child.textContent).join("") + this._text;
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  append(...values) {
    for (const value of values) {
      const child = typeof value === "string" ? new UiNode("#text", value) : value;
      if (!child) continue;
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }

  appendChild(child) {
    return this.append(child);
  }

  replaceChildren(...values) {
    this.children = [];
    return this.append(...values);
  }

  remove() {
    if (!this.parentElement) return;
    const at = this.parentElement.children.indexOf(this);
    if (at !== -1) this.parentElement.children.splice(at, 1);
    this.parentElement = null;
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this._listeners.get(type) || [];
    const at = list.indexOf(fn);
    if (at !== -1) list.splice(at, 1);
  }

  querySelectorAll(selector) {
    const found = [];
    walk(this, (node) => {
      if (selectorMatches(node, selector)) found.push(node);
      return true;
    });
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  focus() {
    this.focused = true;
  }

  select() {
    this.focused = true;
  }

  click() {
    fireEvent(this, "click");
  }
}

/* -------------------------------------------------------------- document -- */

function parseHtml(html) {
  const root = new UiNode("#document");
  const stack = [root];
  const tagRe = /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/gi;
  let match;
  while ((match = tagRe.exec(html))) {
    const [, closing, tag, attrText, selfClose, text] = match;
    if (text !== undefined) {
      if (text.length) stack[stack.length - 1].append(text);
      continue;
    }
    if (!tag) continue;
    const name = tag.toLowerCase();
    if (closing) {
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].tagName.toLowerCase() === name) {
          stack.length = index;
          break;
        }
      }
      continue;
    }
    const node = new UiNode(name);
    node.attrs = parseAttributes(attrText);
    stack[stack.length - 1].append(node);
    if (!selfClose && !VOID_TAGS.has(name)) stack.push(node);
  }
  return root;
}

export function createDocument(html) {
  const root = parseHtml(String(html));
  const document = {
    nodeType: 9,
    tagName: "#DOCUMENT",
    _root: root,
    get documentElement() {
      return root.children.find((child) => child.tagName === "HTML") || root;
    },
    get head() {
      return this.documentElement.querySelector("head");
    },
    get body() {
      return this.documentElement.querySelector("body");
    },
    get title() {
      const title = this.documentElement.querySelector("title");
      return title ? title.textContent.trim() : "";
    },
    getElementById(id) {
      return root.querySelector(`#${id}`);
    },
    querySelector(selector) {
      return root.querySelector(selector);
    },
    querySelectorAll(selector) {
      return root.querySelectorAll(selector);
    },
    createElement(tagName) {
      const node = new UiNode(tagName);
      node.ownerDocument = document;
      return node;
    },
    addEventListener() {},
    removeEventListener() {},
    execCommand() {
      return false;
    },
  };
  for (const node of [root, ...root.querySelectorAll("*")]) node.ownerDocument = document;
  return document;
}

/* ---------------------------------------------------------------- events -- */

export function fireEvent(node, type, extra = {}) {
  const event = {
    type,
    target: node,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...extra,
  };
  for (const fn of [...(node._listeners.get(type) || [])]) fn(event);
  return event;
}

/* ----------------------------------------------------------------- chrome -- */

/**
 * A chrome-like API over plain objects. Storage areas resolve promises and
 * announce changes, `sendMessage` answers `wdr-get-status` from `status`, and
 * every write is recorded in `writes` so a test can assert the exact payload.
 */
export function createChrome({ local = {}, session = {}, status = null } = {}) {
  const listeners = [];
  const writes = [];
  const requests = [];
  const state = { local: { ...local }, session: { ...session } };
  let optionsOpened = 0;

  function emit(changes, area) {
    for (const fn of [...listeners]) fn(changes, area);
  }

  function createArea(name) {
    return {
      async get(keys) {
        if (keys == null) return { ...state[name] };
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const key of list) if (key in state[name]) out[key] = state[name][key];
        return out;
      },
      async set(values) {
        const next = values || {};
        writes.push({ area: name, method: "set", values: { ...next } });
        const changes = {};
        for (const [key, value] of Object.entries(next)) {
          changes[key] = { oldValue: state[name][key], newValue: value };
          state[name][key] = value;
        }
        emit(changes, name);
      },
      async remove(key) {
        const keys = Array.isArray(key) ? key : [key];
        writes.push({ area: name, method: "remove", keys: [...keys] });
        const changes = {};
        for (const name_ of keys) {
          const oldValue = state[name][name_];
          delete state[name][name_];
          changes[name_] = { oldValue, newValue: undefined };
        }
        emit(changes, name);
      },
    };
  }

  const api = {
    storage: {
      local: createArea("local"),
      session: createArea("session"),
      onChanged: {
        addListener(fn) {
          listeners.push(fn);
        },
        removeListener(fn) {
          const at = listeners.indexOf(fn);
          if (at !== -1) listeners.splice(at, 1);
        },
      },
    },
    runtime: {
      lastError: undefined,
      sendMessage(message, callback) {
        requests.push(JSON.parse(JSON.stringify(message ?? null)));
        const response = message && message.t === "wdr-get-status" ? status : null;
        if (typeof callback === "function") {
          Promise.resolve().then(() => callback(response));
          return undefined;
        }
        return Promise.resolve(response);
      },
      openOptionsPage() {
        optionsOpened += 1;
      },
    },
  };

  return {
    api,
    writes,
    requests,
    state,
    emit,
    get optionsOpened() {
      return optionsOpened;
    },
    /** Move the worker's live answer, as the worker would between two reads. */
    setStatus(next) {
      status = next;
    },
  };
}

/* ------------------------------------------------------------------ mount -- */

let mounts = 0;

/** Let every resolved promise chain and queued callback run. */
export async function settle(turns = 8) {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export function readSurface(extensionDir, surface, extension) {
  return readFileSync(join(extensionDir, `${surface}.${extension}`), "utf8");
}

/**
 * Parse `<surface>.html`, install it plus `chrome` as globals, import
 * `<surface>.js` for real, and wait for the first render.
 */
export async function mountSurface({ surface, extensionDir, chrome }) {
  const doc = createDocument(readSurface(extensionDir, surface, "html"));
  const previousDocument = globalThis.document;
  const previousChrome = globalThis.chrome;
  globalThis.document = doc;
  globalThis.chrome = chrome.api;

  const url = new URL(pathToFileURL(join(extensionDir, `${surface}.js`)).href);
  url.searchParams.set("mount", String((mounts += 1)));
  await import(url.href);
  await settle();

  return {
    doc,
    chrome,
    async settle() {
      await settle();
    },
    unmount() {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
      if (previousChrome === undefined) delete globalThis.chrome;
      else globalThis.chrome = previousChrome;
    },
  };
}
