/**
 * Tiny fake DOM — just enough surface for `extension/extract.js`.
 * No jsdom, no dependencies.
 *
 * Selector grammar supported: descendant (`a b`), child (`a > b`), tag,
 * `#id`, `.class`, `[attr]`, `[attr="value"]`, and comma lists.
 */

function parseCompound(token) {
  const compound = { tag: "", id: null, classes: [], attrs: [] };
  let rest = token;
  const tagMatch = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(rest);
  if (tagMatch) {
    compound.tag = tagMatch[1].toLowerCase();
    rest = rest.slice(tagMatch[1].length);
  }
  const partRe = /#([\w-]+)|\.([\w-]+)|\[([a-zA-Z0-9_:.-]+)(?:=["']([^"']*)["'])?\]/g;
  let m;
  while ((m = partRe.exec(rest))) {
    if (m[1]) compound.id = m[1];
    else if (m[2]) compound.classes.push(m[2]);
    else compound.attrs.push([m[3], m[4]]);
  }
  return compound;
}

function parseChain(text) {
  const steps = [];
  const tokens = text
    .replace(/\s*>\s*/g, " > ")
    .split(/\s+/)
    .filter(Boolean);
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
  for (const [name, value] of compound.attrs) {
    if (!(name in node.attrs)) return false;
    if (value !== undefined && node.attrs[name] !== value) return false;
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

export function makeDocument({
  title = "",
  href = "https://www.crunchyroll.com/",
  children = [],
  mediaSession = null
} = {}) {
  const root = new FakeNode("#root", {});
  for (const child of children) root.append(child);

  const doc = {
    title,
    location: { href },
    documentElement: root,
    querySelector: (selector) => root.querySelector(selector),
    querySelectorAll: (selector) => root.querySelectorAll(selector)
  };

  const navigator = {
    mediaSession: mediaSession ? { metadata: mediaSession } : null
  };

  return { doc, navigator };
}
