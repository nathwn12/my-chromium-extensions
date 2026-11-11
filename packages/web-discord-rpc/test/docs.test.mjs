import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CLIENT_ID, SOURCE_META } from "../config.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const rootReadme = readFileSync(path.join(root, "..", "..", "README.md"), "utf8");
const rootLock = JSON.parse(readFileSync(path.join(root, "..", "..", "package-lock.json"), "utf8"));
const readme = read("README.md");
const arch = read("docs/ARCHITECTURE.md");
const research = read("docs/RESEARCH.md");
const install = read("docs/INSTALL.md");
const changelog = read("CHANGELOG.md");

test("product docs describe one YouTube Music source and one desktop IPC transport", () => {
  for (const [name, doc] of [["README", readme], ["ARCHITECTURE", arch], ["RESEARCH", research], ["INSTALL", install]]) {
    assert.match(doc, /YouTube Music/i, `${name} names Music`);
    assert.match(doc, /desktop IPC/i, `${name} names desktop IPC`);
    assert.doesNotMatch(doc, /YouTube and YouTube Music|two sources|per-source budgets|choosing sites|transport preference/i, `${name} is not stale`);
  }
  assert.match(rootReadme, /YouTube Music only/i);
  assert.match(readme, /only user-facing preference/i);
});

test("the documented presence matches the artist header and status payload", () => {
  assert.equal(SOURCE_META["youtube-music"].type, 2);
  assert.equal(Object.keys(SOURCE_META).length, 1);
  assert.match(readme, /static name `YouTube Music`/);
  assert.match(readme, /artist in `state`/);
  assert.match(readme, /status_display_type: `?1/);
  assert.match(readme, /not Discord's rendered UI/);
  assert.match(arch, /status_display_type.*1/);
  assert.match(arch, /artist/);
});

test("timestamp documentation requires real media position and duration", () => {
  for (const doc of [readme, arch]) {
    assert.match(doc, /real.*position/i);
    assert.match(doc, /positive duration/i);
    assert.match(doc, /not.*invented|invent.*not|never.*invented/i);
  }
});

test("version 1.1.2 is aligned across package, manifest, root index and changelog", () => {
  const pkg = JSON.parse(read("package.json"));
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(pkg.version, "1.1.2");
  assert.equal(manifest.version, "1.1.2");
  assert.equal(rootLock.packages["packages/web-discord-rpc"].version, "1.1.2");
  assert.match(changelog, /\[1\.1\.2\]/);
  assert.match(rootReadme, /YouTube Music.*\| 1\.1\.2/);
  assert.equal(DEFAULT_CLIENT_ID, "1566530911514923188");
});

test("docs name the fixed presence control and local-only data flow", () => {
  assert.match(readme, /accessible presence switch/i);
  assert.match(readme, /persists across refreshes and Discord reconnects/i);
  assert.match(readme, /makes no network requests of its own/i);
  assert.match(install, /Load unpacked/);
});
