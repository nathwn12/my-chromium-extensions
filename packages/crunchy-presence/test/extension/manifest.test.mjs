import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(here, "..", "..");
const manifestPath = join(extensionDir, "manifest.json");
const generator = join(extensionDir, "tools", "make-icons.mjs");

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ICON_SIZES = [16, 32, 48, 128];

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

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
    bytes
  };
}

const EXPECTED_EXTENSION_ID = "afghbfidjjlgnhaacaiiakmknffnmiom";

/**
 * Chrome derives the extension ID from the manifest `key`: SHA-256 of the DER
 * SPKI, first 16 bytes, each nibble mapped to 'a' + nibble.
 */
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

before(() => {
  const missing = ICON_SIZES.some((size) => !existsSync(join(extensionDir, "icons", `icon${size}.png`)));
  if (missing) execFileSync(process.execPath, [generator], { stdio: "pipe" });
});

test("manifest is MV3 with the expected identity", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, "Crunchyroll Discord Presence");
  assert.equal(manifest.version, "1.0.0");
  assert.ok(manifest.host_permissions.includes("*://*.crunchyroll.com/*"));
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

test("permissions stay minimal and host access is Crunchyroll only", () => {
  const permissions = [...manifest.permissions].sort();
  // nativeMessaging + storage are required by the contract; alarms is the only
  // way an MV3 service worker can run the 30s watchdog. Anything broader fails.
  assert.deepEqual(permissions, ["alarms", "nativeMessaging", "storage"]);
  assert.deepEqual(manifest.host_permissions, ["*://*.crunchyroll.com/*"]);
  assert.ok(!("optional_permissions" in manifest), "no optional permissions to widen scope later");
  assert.ok(!JSON.stringify(manifest).includes("<all_urls>"));
});

test("content script covers Crunchyroll in every frame at document_idle", () => {
  assert.ok(Array.isArray(manifest.content_scripts) && manifest.content_scripts.length === 1);
  const [script] = manifest.content_scripts;
  assert.deepEqual(script.matches, ["*://*.crunchyroll.com/*"]);
  assert.equal(script.run_at, "document_idle");
  assert.equal(script.all_frames, true);
  assert.deepEqual(script.js, ["extract.js", "content.js"]);
  for (const file of script.js) assert.ok(existsSync(join(extensionDir, file)), `${file} exists`);
});

test("service worker, popup and options page are local files", () => {
  assert.equal(manifest.background.service_worker, "background.js");
  assert.equal(manifest.background.type, "module");
  assert.ok(existsSync(join(extensionDir, manifest.background.service_worker)));

  assert.equal(manifest.action.default_popup, "popup.html");
  assert.ok(existsSync(join(extensionDir, manifest.action.default_popup)));
  assert.ok(existsSync(join(extensionDir, "popup.js")));
  assert.ok(existsSync(join(extensionDir, "popup.css")));

  assert.equal(manifest.options_ui.page, "options.html");
  assert.ok(existsSync(join(extensionDir, manifest.options_ui.page)));
  assert.ok(existsSync(join(extensionDir, "options.js")));
  assert.ok(existsSync(join(extensionDir, "options.css")));
});

test("no remote code anywhere in the manifest or its HTML", () => {
  assert.ok(!("content_security_policy" in manifest), "default CSP only");
  const serialized = JSON.stringify(manifest);
  assert.ok(!/https?:\/\//.test(serialized), "manifest references no remote URL");
  assert.ok(!("externally_connectable" in manifest));
  assert.ok(!("web_accessible_resources" in manifest), "nothing is exposed to the page");

  const htmlFiles = readdirSync(extensionDir).filter((file) => file.endsWith(".html"));
  assert.ok(htmlFiles.length >= 2, "popup.html and options.html");
  for (const file of htmlFiles) {
    const html = readFileSync(join(extensionDir, file), "utf8");
    assert.ok(!/<script[^>]+src=["']https?:/i.test(html), `${file} loads no remote script`);
    assert.ok(!/<link[^>]+href=["']https?:/i.test(html), `${file} loads no remote stylesheet`);
    assert.ok(!/\beval\s*\(/.test(html), `${file} has no eval`);
  }
});

test("icons are declared at 16/32/48/128 and are real PNGs of that size", () => {
  for (const size of ICON_SIZES) {
    const relative = manifest.icons[String(size)];
    assert.equal(relative, `icons/icon${size}.png`);
    assert.equal(manifest.action.default_icon[String(size)], relative);
    const png = readPng(relative);
    assert.equal(png.width, size, `${relative} width`);
    assert.equal(png.height, size, `${relative} height`);
    assert.equal(png.bitDepth, 8);
    assert.equal(png.colorType, 6, "truecolour with alpha");
  }
});

test("icon generator is deterministic", () => {
  const first = ICON_SIZES.map((size) => readFileSync(join(extensionDir, "icons", `icon${size}.png`)));
  execFileSync(process.execPath, [generator], { stdio: "pipe" });
  const second = ICON_SIZES.map((size) => readFileSync(join(extensionDir, "icons", `icon${size}.png`)));
  for (let i = 0; i < ICON_SIZES.length; i += 1) {
    assert.ok(first[i].equals(second[i]), `icon${ICON_SIZES[i]}.png is byte-identical across runs`);
  }
});
