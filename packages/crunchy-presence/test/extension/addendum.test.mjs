import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const worker = await import(pathToFileURL(join(here, "..", "..", "background.js")).href);
const { buildActivity, isCrunchyrollPageUrl } = worker;
const { validateActivity } = await import("../../native/protocol.mjs");

const bgSource = readFileSync(join(here, "..", "..", "background.js"), "utf8");
const contentSource = readFileSync(join(here, "..", "..", "content.js"), "utf8");
const popupSource = readFileSync(join(here, "..", "..", "popup.js"), "utf8");
const optionsCss = readFileSync(join(here, "..", "..", "options.css"), "utf8");
const manifest = JSON.parse(readFileSync(join(here, "..", "..", "manifest.json"), "utf8"));
const readme = readFileSync(join(here, "..", "..", "README.md"), "utf8");
const changelog = readFileSync(join(here, "..", "..", "CHANGELOG.md"), "utf8");

const NOW = 1_700_000_000_000;
const base = (overrides = {}) => ({
  series: "Frieren",
  episodeTitle: "The Beginning",
  seasonNumber: 1,
  episodeNumber: 5,
  duration: 1440,
  position: 754,
  paused: false,
  pageUrl: "https://www.crunchyroll.com/watch/G6VU774M5/x",
  ...overrides
});

test("artwork from a non-Crunchyroll https host is dropped", () => {
  const evil = buildActivity(base({ artworkUrl: "https://evil.example/ep.jpg" }), NOW);
  assert.equal(evil.assets, undefined);
  const ok = buildActivity(base({ artworkUrl: "https://img.crunchyroll.com/ep.jpg" }), NOW);
  assert.equal(ok.assets.large_image, "https://img.crunchyroll.com/ep.jpg");
});

test("isCrunchyrollPageUrl rejects http", () => {
  assert.equal(isCrunchyrollPageUrl("http://www.crunchyroll.com/watch/G1"), false);
  assert.equal(isCrunchyrollPageUrl("https://www.crunchyroll.com/watch/G1"), true);
  assert.deepEqual(manifest.host_permissions, ["https://*.crunchyroll.com/*"]);
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://*.crunchyroll.com/*"]);
});

test("handleState gates on sender.id and Crunchyroll URL", () => {
  assert.match(bgSource, /sender\.id !== chromeApi\.runtime\.id/);
  assert.match(bgSource, /isCrunchyrollPageUrl\(sender\.url\)/);
});

test("protocol buttons reject http and foreign hosts", () => {
  const foreign = validateActivity({
    type: 3,
    buttons: [{ label: "Watch", url: "https://evil.example/watch/G1" }]
  });
  assert.equal(foreign.ok, false);
  const http = validateActivity({
    type: 3,
    buttons: [{ label: "Watch", url: "http://www.crunchyroll.com/watch/G1" }]
  });
  assert.equal(http.ok, false);
  const ok = validateActivity({
    type: 3,
    buttons: [{ label: "Watch", url: "https://www.crunchyroll.com/watch/G1" }]
  });
  assert.equal(ok.ok, true);
});

test("README and CHANGELOG require Chrome 120", () => {
  assert.match(readme, /120 or newer/);
  assert.doesNotMatch(readme, /156 or newer/);
  assert.match(changelog, /Chrome 120\+/);
  assert.doesNotMatch(changelog, /Chrome 156\+/);
});

test("persist dedupes on lastPersistedJson", () => {
  assert.match(bgSource, /lastPersistedJson/);
  assert.match(bgSource, /if \(key === lastPersistedJson\) return;/);
});

test("content interval clears on pagehide and returns early while disabled", () => {
  assert.match(contentSource, /clearInterval\(pollTimer\)/);
  assert.match(contentSource, /if \(!enabled\) return;/);
});

test("options placeholder uses #9aa3af", () => {
  assert.match(optionsCss, /#clientId::placeholder/);
  assert.match(optionsCss, /#9aa3af/);
});

test("popup toggle reads Active", () => {
  assert.match(popupSource, /Active/);
  assert.doesNotMatch(popupSource, /Presence enabled/);
});
