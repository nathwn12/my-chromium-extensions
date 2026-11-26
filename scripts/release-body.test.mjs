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

test("all four products get the exact documented byte shape", () => {
  assert.deepEqual([...PRODUCTS].sort(), [...PRESENCE, "audio-normalizer", "slowed-reverb"].sort());
  for (const product of PRODUCTS) {
    assert.equal(releaseBody(product), expectedFor(product), product);
  }
});

test("exactly the two presence products carry the native host line", () => {
  const withHost = PRODUCTS.filter((product) => releaseBody(product).includes(HOST));
  assert.deepEqual(withHost.sort(), [...PRESENCE].sort());
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
