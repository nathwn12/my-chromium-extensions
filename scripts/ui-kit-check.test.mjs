#!/usr/bin/env node
// Proves each ui-kit-check predicate red for its own reason on a temp fixture.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runCheck } from "./ui-kit-check.mjs";

const TOKENS = ":root { color-scheme: light dark; --bg: light-dark(#f4f3ef, #16171b); }\n";
const COMPONENTS = ".card { border: 1px solid var(--line); }\n";
const ACCENT = ":root { --accent: light-dark(#9e521d, #df8f4d); }\n";
const LINKED = [
  "<!doctype html><head>",
  '<link rel="stylesheet" href="ui-kit/tokens.css">',
  '<link rel="stylesheet" href="ui-kit/components.css">',
  '<link rel="stylesheet" href="popup.css">',
  "</head><body></body></html>",
  "",
].join("\n");
const MISSING = [
  "<!doctype html><head>",
  '<link rel="stylesheet" href="ui-kit/tokens.css">',
  '<link rel="stylesheet" href="popup.css">',
  "</head><body></body></html>",
  "",
].join("\n");

function put(root, relative, text) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ui-kit-check-"));
  put(root, "packages/ui-kit/tokens.css", TOKENS);
  put(root, "packages/ui-kit/components.css", COMPONENTS);
  // Compliant package: byte-identical copies, both kit links first, accent only.
  put(root, "packages/good/ui-kit/tokens.css", TOKENS);
  put(root, "packages/good/ui-kit/components.css", COMPONENTS);
  put(root, "packages/good/popup.html", LINKED);
  put(root, "packages/good/popup.css", ACCENT);
  // Broken package: one fault per predicate.
  put(root, "packages/bad/ui-kit/tokens.css", TOKENS + "/* drift */\n");
  put(root, "packages/bad/ui-kit/components.css", COMPONENTS);
  put(root, "packages/bad/ui-kit/switch.js", "export {};\n");
  put(root, "packages/bad/popup.html", MISSING);
  put(root, "packages/bad/popup.css", ":root { --muted: #000000; }\n.pill { color: red; }\n");
  return root;
}

test("a compliant tree produces no findings, including the --accent override", () => {
  const root = fixture();
  try {
    const onlyGood = runCheck(root).filter((f) => f.file.startsWith("packages/good/"));
    assert.deepEqual(onlyGood, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(existsSync(root), false, "temp fixture was not removed");
});

test("each predicate goes red for its own named reason", () => {
  const root = fixture();
  try {
    const findings = runCheck(root);
    const forFile = (file) => findings.filter((f) => f.file === file);
    const drift = forFile("packages/bad/ui-kit/tokens.css");
    assert.ok(drift.some((f) => f.kind === "hash-drift" && /SHA-256 .* differs from canonical/.test(f.reason)),
      "hash drift did not go red by name");

    const links = forFile("packages/bad/popup.html");
    assert.ok(links.some((f) => f.kind === "missing-link" && /missing ui-kit\/components\.css link/.test(f.reason)),
      "missing link did not go red by name");

    const sheet = forFile("packages/bad/popup.css");
    assert.ok(sheet.some((f) => f.kind === "token-redefinition" && /--muted/.test(f.reason)),
      "token redefinition did not go red by name");
    assert.ok(sheet.some((f) => f.kind === "class-redefinition" && /\.pill/.test(f.reason)),
      "class redefinition did not go red by name");

    const stale = forFile("packages/bad/ui-kit/switch.js");
    assert.ok(stale.some((f) => f.kind === "stale-switch-js" && /switch\.js/.test(f.reason)),
      "leftover switch.js did not go red by name");

    assert.ok(!findings.some((f) => f.file.startsWith("packages/good/")),
      "the compliant package was flagged");
    assert.ok(!findings.some((f) => f.kind === "canonical-missing"), "canonical was flagged as missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(existsSync(root), false, "temp fixture was not removed");
});
