#!/usr/bin/env node
// Consistency gate for the vendored ui-kit. Exits 1 with a named reason for:
//   hash drift, missing/out-of-order kit links, redefined kit tokens or classes,
//   and a leftover ui-kit/switch.js.
// Usage: node scripts/ui-kit-check.mjs [--root <dir>]
// --root lets a test point the same predicates at a fixture tree.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const KIT_FILES = ["tokens.css", "components.css"];
// --accent and --accent-2 are deliberately absent: a package sets them.
export const KIT_TOKENS = ["bg", "card", "line", "ink", "muted", "ok", "warn", "bad", "neutral"];
export const KIT_CLASSES = ["pill", "card", "toggle", "sources", "source", "field", "btn"];
const PAGES = ["popup.html", "options.html"];
const SHEETS = ["popup.css", "options.css"];

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const rel = (...parts) => parts.join("/");
const lineAt = (text, index) => text.slice(0, index).split(/\r?\n/).length;

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

// Rule preludes, including nested @media rules, without their declarations.
function ruleSelectors(css) {
  const out = [];
  let buffer = "";
  for (const ch of stripComments(css)) {
    if (ch === "{") {
      const selector = buffer.trim();
      if (selector && !selector.startsWith("@")) out.push(selector);
      buffer = "";
    } else if (ch === "}" || ch === ";") {
      buffer = "";
    } else {
      buffer += ch;
    }
  }
  return out;
}

function readIfExists(path) {
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  return readFileSync(path, "utf8");
}

/**
 * Run every predicate against `root` and return findings.
 * Each finding is { kind, file, reason } so callers can assert a named reason.
 */
export function runCheck(root) {
  const findings = [];
  const add = (kind, file, reason) => findings.push({ kind, file, reason });
  const kitDir = join(root, "packages", "ui-kit");
  const canonical = new Map();

  for (const file of KIT_FILES) {
    const path = join(kitDir, file);
    const bytes = existsSync(path) ? readFileSync(path) : null;
    if (!bytes) {
      add("canonical-missing", rel("packages", "ui-kit", file), "canonical stylesheet is missing");
      continue;
    }
    canonical.set(file, { sha: hash(bytes), text: bytes.toString("utf8") });
  }

  let names = [];
  try {
    names = readdirSync(join(root, "packages")).sort();
  } catch (error) {
    add("packages-missing", "packages", `cannot read packages/: ${error.message}`);
    return findings;
  }

  for (const name of names) {
    const pkgDir = join(root, "packages", name);
    if (!statSync(pkgDir).isDirectory()) continue;
    const vendoredDir = join(pkgDir, "ui-kit");
    const hasVendoredDir = existsSync(vendoredDir) && statSync(vendoredDir).isDirectory();

    // 1. vendored CSS must be byte-identical to canonical (SHA-256).
    for (const file of KIT_FILES) {
      const base = rel("packages", name, "ui-kit", file);
      const vendored = join(vendoredDir, file);
      if (!existsSync(vendored) || !statSync(vendored).isFile()) continue;
      const reference = canonical.get(file);
      if (!reference) continue;
      const actual = hash(readFileSync(vendored));
      if (actual !== reference.sha)
        add("hash-drift", base, `SHA-256 ${actual} differs from canonical ${reference.sha}`);
    }

    // 2. no leftover polyfill loader.
    if (hasVendoredDir && existsSync(join(vendoredDir, "switch.js")))
      add("stale-switch-js", rel("packages", name, "ui-kit", "switch.js"),
        "switch.js was removed from canonical; CSS draws the switch");

    // 3. both kit stylesheets must be linked, before the package's own sheet.
    for (const page of PAGES) {
      const base = rel("packages", name, page);
      const text = readIfExists(join(pkgDir, page));
      if (text === null) continue;
      const tags = [...text.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
      const hrefs = tags.map((tag) =>
        (/\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? "").replace(/\\/g, "/"));
      const kitIndex = (file) =>
        hrefs.findIndex((href) => new RegExp(`(^|/)ui-kit/${file}$`).test(href));
      const tokensIndex = kitIndex("tokens\\.css");
      const componentsIndex = kitIndex("components\\.css");
      const ownIndex = hrefs.findIndex((href) =>
        /\.css$/i.test(href) && !/ui-kit\//.test(href) && !/^(tokens|components)\.css$/.test(href));
      const problems = [];
      if (tokensIndex < 0) problems.push("missing ui-kit/tokens.css link");
      if (componentsIndex < 0) problems.push("missing ui-kit/components.css link");
      if (ownIndex >= 0) {
        const lastKit = Math.max(tokensIndex, componentsIndex);
        if (lastKit >= 0 && lastKit > ownIndex)
          problems.push("kit stylesheet(s) linked after the package stylesheet");
      }
      if (problems.length) add("missing-link", base, problems.join("; "));
    }

    // 4. a package stylesheet may set --accent only; it may not redefine a
    //    kit token or style a kit-owned class.
    for (const sheet of SHEETS) {
      const base = rel("packages", name, sheet);
      const text = readIfExists(join(pkgDir, sheet));
      if (text === null) continue;
      const clean = stripComments(text);
      const tokenPattern = new RegExp(`--(${KIT_TOKENS.join("|")})\\s*:`, "g");
      for (const match of clean.matchAll(tokenPattern))
        add("token-redefinition", base,
          `line ${lineAt(clean, match.index)} redefines kit token --${match[1]}`);
      const classPattern = new RegExp(`\\.(${KIT_CLASSES.join("|")})(?![\\w-])`);
      for (const selector of ruleSelectors(text)) {
        // Only the styled subject counts: ".card h2" styles a package element,
        // while ".card" or ".sources" takes ownership of a kit component.
        const subject = selector.split(/,/).pop().trim().split(/[\s>+~]+/).pop();
        const match = classPattern.exec(subject);
        if (match)
          add("class-redefinition", base,
            `kit-owned class .${match[1]} styled by package rule "${selector}"`);
      }
    }
  }
  return findings;
}

function rootFrom(argv) {
  const i = argv.indexOf("--root");
  if (i < 0) return resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (!argv[i + 1]) {
    console.error("ui-kit-check: --root needs a directory");
    process.exit(2);
  }
  return resolve(argv[i + 1]);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = rootFrom(process.argv);
  const findings = runCheck(root);
  if (findings.length === 0) {
    console.log("ui-kit-check: no drift, every package links the kit first, no kit tokens/classes redefined, no switch.js");
    process.exit(0);
  }
  for (const { kind, file, reason } of findings)
    console.error(`FAIL [${kind}] ${file}: ${reason}`);
  console.error(`ui-kit-check: ${findings.length} finding(s) (root: ${root})`);
  process.exit(1);
}
