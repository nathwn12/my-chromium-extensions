import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PRODUCTS, releaseBody, requiresNativeHost } from "./release-body.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRESENCE = ["crunchy-presence", "youtube-music-presence"];
const INSTALL =
  "**Install:** download the zip, unzip it anywhere, then Load unpacked the folder containing `manifest.json` in `chrome://extensions` with Developer mode on.";
const HOST =
  "**Native host:** run `node scripts/install-host.mjs` once from the unzipped folder to register the host for Discord.";
const FOOTER = "This release is replaced in place on every update - the link never changes.";

function manifestFor(product) {
  return JSON.parse(readFileSync(join(ROOT, "packages", product, "manifest.json"), "utf8"));
}

function expectedFor(product) {
  const manifest = manifestFor(product);
  const lines = [manifest.description, "", `**Version:** ${manifest.version}`, INSTALL];
  if (manifest.permissions.includes("nativeMessaging")) lines.push(HOST);
  lines.push(`**Source:** \`packages/${product}\` in this repository.`, "", FOOTER);
  return lines.join("\n");
}

test("all five products get the exact documented byte shape", () => {
  assert.deepEqual(
    [...PRODUCTS].sort(),
    [...PRESENCE, "audio-normalizer", "slowed-reverb", "presence-suite"].sort()
  );
  for (const product of PRODUCTS) {
    assert.equal(releaseBody(product), expectedFor(product), product);
  }
});

test("exactly the three nativeMessaging products carry the native host line", () => {
  const withHost = PRODUCTS.filter((product) => releaseBody(product).includes(HOST));
  assert.deepEqual(withHost.sort(), [...PRESENCE, "presence-suite"].sort());
  for (const product of PRODUCTS) {
    assert.equal(
      requiresNativeHost(product),
      manifestFor(product).permissions.includes("nativeMessaging"),
      `${product} derives the host line from nativeMessaging`
    );
    assert.equal(releaseBody(product).includes(HOST), requiresNativeHost(product), product);
  }
});

test("the version line equals the manifest version and is never a literal", () => {
  const source = readFileSync(join(ROOT, "scripts", "release-body.mjs"), "utf8");
  for (const product of PRODUCTS) {
    const match = /^\*\*Version:\*\* (.+)$/m.exec(releaseBody(product));
    assert.ok(match, `${product} has a version line`);
    assert.equal(match[1], manifestFor(product).version, product);
    assert.equal(source.includes(manifestFor(product).version), false, `${product} version is hardcoded`);
  }
});

test("the body has no trailing blank line", () => {
  for (const product of PRODUCTS) {
    const body = releaseBody(product);
    assert.equal(body.endsWith("\n"), false, product);
    assert.equal(body.includes("\n\n\n"), false, product);
  }
});

test("presence-suite is supported with its real body and required install files", () => {
  assert.ok(PRODUCTS.includes("presence-suite"), "presence-suite must be a supported product");
  const manifest = manifestFor("presence-suite");
  const body = releaseBody("presence-suite");
  assert.equal(body, expectedFor("presence-suite"), "byte shape derives from the real manifest");
  assert.ok(body.startsWith(manifest.description), "body opens with the package's real description");
  assert.ok(body.includes(`**Version:** ${manifest.version}`), "version comes from the manifest");
  assert.ok(body.includes(HOST), "nativeMessaging presence-suite requires the native host line");
  assert.ok(body.includes("`manifest.json`"), "body names manifest.json as an install file");
  assert.ok(body.includes("`node scripts/install-host.mjs`"), "body names the host installer as an install file");
});

test("the CLI prints the body verbatim and exits 1 for an unknown product", () => {
  const script = join(ROOT, "scripts", "release-body.mjs");
  for (const product of PRODUCTS) {
    const result = spawnSync(process.execPath, [script, product], { encoding: "utf8" });
    assert.equal(result.status, 0, `${product}: ${result.stderr}`);
    assert.equal(result.stdout, releaseBody(product), product);
    assert.equal(result.stdout.endsWith("\n\n"), false, product);
  }
  const unknown = spawnSync(process.execPath, [script, "not-a-product"], { encoding: "utf8" });
  assert.equal(unknown.status, 1);
});
