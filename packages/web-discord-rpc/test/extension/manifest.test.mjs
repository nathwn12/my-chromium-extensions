import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(here, "..", "..");
const manifestPath = join(extensionDir, "manifest.json");

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ICON_SIZES = [16, 24, 32, 48, 128];
const DECLARED_ICON_SIZES = [16, 32, 48, 128];

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// Stable key generated once via `node scripts/extension-key.mjs --print`.
// The native host's allowed_origins names the extension ID derived from it.
const EXPECTED_EXTENSION_ID = "mnmmfbjinpokfnendlbhbbdmfjidgikf";

/** Chrome derives the extension ID from the manifest `key` (see extension-key.mjs). */
function extensionIdFromKey(key) {
  const der = Buffer.from(key, "base64");
  const digest = createHash("sha256").update(der).digest();
  let id = "";
  for (const byte of digest.subarray(0, 16)) {
    id += String.fromCharCode(97 + (byte >> 4));
    id += String.fromCharCode(97 + (byte & 0x0f));
  }
  return id;
}

function readPng(relative) {
  const path = join(extensionDir, relative);
  assert.ok(existsSync(path), `${relative} exists`);
  const bytes = readFileSync(path);
  assert.ok(bytes.length > 33, `${relative} has IHDR`);
  assert.deepEqual([...bytes.subarray(0, 8)], [...PNG_MAGIC], `${relative} PNG magic`);
  assert.equal(bytes.toString("latin1", 12, 16), "IHDR", `${relative} starts with IHDR`);
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colorType: bytes[25],
  };
}

test("manifest is MV3 with the expected identity", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, "YouTube Music Presence");
  assert.equal(manifest.version, "1.1.1");
  assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "strict semver MAJOR.MINOR.PATCH");
  assert.match(manifest.description, /YouTube Music/i);
});

test("the manifest calls the extension YouTube Music Presence, never an earlier name", () => {
  assert.equal(manifest.name, "YouTube Music Presence");
  assert.equal(manifest.short_name, "YouTube Music Presence");
  assert.equal(manifest.action.default_title, "YouTube Music Presence");
  const serialized = JSON.stringify(manifest);
  assert.ok(!serialized.includes("Discord RPC"), "the earlier name is gone from every field");
  assert.ok(!serialized.includes("Web Discord RPC"), "the first name is gone from every field");
  assert.ok(!serialized.includes('"YouTube Presence"'), "the two-source name is gone from every field");
});

test("manifest requires Chrome 120, expressed as a major version", () => {
  assert.equal(manifest.minimum_chrome_version, "120");
  assert.match(manifest.minimum_chrome_version, /^[1-9][0-9]*$/, "bare numeric major version, no dots");
});

test("manifest key decodes to the stable extension ID the native host allows", () => {
  assert.equal(typeof manifest.key, "string");
  assert.ok(manifest.key.length > 0);
  assert.match(manifest.key, /^[A-Za-z0-9+/]+={0,2}$/, "key is base64");
  const der = Buffer.from(manifest.key, "base64");
  assert.ok(der.length > 0, "key decodes to DER bytes");
  assert.equal(der.toString("base64"), manifest.key, "key round-trips through base64");
  assert.equal(der.subarray(0, 2).toString("hex"), "3082", "DER SEQUENCE header");
  assert.equal(extensionIdFromKey(manifest.key), EXPECTED_EXTENSION_ID);
});

test("permissions stay minimal and host access is YouTube Music only", () => {
  const permissions = [...manifest.permissions].sort();
  assert.deepEqual(permissions, ["alarms", "nativeMessaging", "storage"]);
  assert.ok(!("optional_permissions" in manifest), "no optional permissions to widen scope later");
  assert.deepEqual(manifest.host_permissions, ["https://music.youtube.com/*"]);
  assert.ok(!JSON.stringify(manifest).includes("<all_urls>"));
});

test("content script covers YouTube Music in every frame at document_idle", () => {
  assert.ok(Array.isArray(manifest.content_scripts) && manifest.content_scripts.length === 1);
  const [script] = manifest.content_scripts;
  assert.deepEqual([...script.matches].sort(), [...manifest.host_permissions].sort());
  assert.equal(script.run_at, "document_idle");
  assert.equal(script.all_frames, true);
  assert.deepEqual(script.js, ["extract-youtube.js", "content.js"]);
});

test("service worker, popup and options page are declared as local files", () => {
  assert.equal(manifest.background.service_worker, "background.js");
  assert.equal(manifest.background.type, "module");
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.equal(manifest.action.default_title, "YouTube Music Presence");
  assert.equal(manifest.options_ui.page, "options.html");
  assert.equal(manifest.options_ui.open_in_tab, true);
});

test("no remote code anywhere in the manifest or its HTML", () => {
  assert.ok(!("content_security_policy" in manifest), "default CSP only");
  const serialized = JSON.stringify(manifest);
  const withoutMatches = serialized
    .replace(/https:\/\/([a-z0-9-]+\.)*music\.youtube\.com/g, "");
  assert.ok(!/https?:\/\//.test(withoutMatches), "manifest references no remote URL beyond the Music match pattern");
  assert.ok(!("externally_connectable" in manifest));
  assert.ok(!("web_accessible_resources" in manifest), "nothing is exposed to the page");
});

test("icons are declared at 16/32/48/128 and shipped at 16/24/32/48/128 as real PNGs", () => {
  for (const size of DECLARED_ICON_SIZES) {
    const relative = manifest.icons[String(size)];
    assert.equal(relative, `icons/icon${size}.png`);
    assert.equal(manifest.action.default_icon[String(size)], relative);
  }
  for (const size of ICON_SIZES) {
    const png = readPng(`icons/icon${size}.png`);
    assert.equal(png.width, size, `icon${size}.png width`);
    assert.equal(png.height, size, `icon${size}.png height`);
    assert.equal(png.bitDepth, 8);
    assert.equal(png.colorType, 6, "truecolour with alpha");
  }
});
