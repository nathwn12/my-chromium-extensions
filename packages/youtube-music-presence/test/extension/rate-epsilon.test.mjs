import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(here, "..", "..");

/**
 * The rate tolerance used to live as a literal in three files. background.js
 * and activity.js are ES modules and now share one exported definition;
 * content.js is a classic content script (manifest content_scripts.js has no
 * module type) and cannot import, so it keeps a literal. This guard reads the
 * three files as text and pins every remaining literal to the one export.
 */
const SOURCES = ["activity.js", "background.js", "content.js"];
const LITERAL = /\b(?:var|let|const)\s+RATE_EPSILON\s*=\s*(-?[0-9]*\.?[0-9]+)\s*;/;
const EXPORT = /^export\s+const\s+RATE_EPSILON\s*=/;

function literals(file) {
  const text = readFileSync(join(extensionDir, file), "utf8");
  const found = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const match = line.match(LITERAL);
    if (match) {
      found.push({
        file,
        line: index + 1,
        value: Number(match[1]),
        exported: EXPORT.test(line.trimStart()),
      });
    }
  }
  return found;
}

test("rate tolerance has one exported definition and every literal matches it", () => {
  const all = SOURCES.flatMap(literals);

  const exported = all.filter((entry) => entry.exported);
  assert.equal(exported.length, 1, "exactly one exported RATE_EPSILON definition");
  const canonical = exported[0];
  assert.equal(
    canonical.file,
    "activity.js",
    `activity.js must own the exported rate tolerance (found in ${canonical.file})`
  );
  assert.equal(
    canonical.value,
    0.01,
    `activity.js:${canonical.line} exported rate tolerance must stay 0.01`
  );

  for (const { file, line, value } of all) {
    assert.equal(
      value,
      canonical.value,
      `${file}:${line} RATE_EPSILON literal drifted: ${value} !== exported ${canonical.value}`
    );
  }

  const duplicates = all.filter((entry) => entry.file !== "content.js" && !entry.exported);
  assert.deepEqual(duplicates, [], "no duplicate RATE_EPSILON literal in an ES module");
});
