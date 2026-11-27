import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveIdFromManifest } from "../scripts/extension-key.mjs";

const dir = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = join(dir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

test("manifest is MV3 Presence Suite over both sites with no extra permissions", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, "Presence Suite");
  assert.equal(manifest.minimum_chrome_version, "120");
  assert.deepEqual(manifest.permissions.slice().sort(), ["alarms", "nativeMessaging", "storage"]);
  assert.deepEqual(manifest.host_permissions.slice().sort(), ["https://*.crunchyroll.com/*", "https://music.youtube.com/*"]);
  assert.deepEqual(manifest.background, { service_worker: "background.js", type: "module" });
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.deepEqual(manifest.options_ui, { page: "options.html", open_in_tab: true });
});

test("each site loads its own per-source extractor and content script", () => {
  const byMatch = (host) => manifest.content_scripts.find((entry) => entry.matches.includes(host));
  const youtube = byMatch("https://music.youtube.com/*");
  const crunchy = byMatch("https://*.crunchyroll.com/*");
  assert.ok(youtube);
  assert.ok(crunchy);
  assert.deepEqual(youtube.js, ["extract-youtube.js", "content.js"]);
  assert.deepEqual(crunchy.js, ["sources/crunchy/extract.js", "sources/crunchy/content.js"]);
  assert.equal(youtube.all_frames, true);
  assert.equal(crunchy.all_frames, true);
});

test("the extension key is present and freshly generated, not copied", () => {
  assert.equal(typeof manifest.key, "string");
  assert.ok(manifest.key.length > 100);
  const derived = deriveIdFromManifest(manifestPath);
  assert.equal(derived.ok, true);
  assert.match(derived.id, /^[a-p]{32}$/);
  for (const sibling of ["youtube-music-presence", "crunchy-presence"]) {
    const old = JSON.parse(readFileSync(join(dir, "..", sibling, "manifest.json"), "utf8"));
    assert.notEqual(manifest.key, old.key, "key must not be copied from " + sibling);
  }
});
