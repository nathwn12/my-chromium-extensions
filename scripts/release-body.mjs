#!/usr/bin/env node
// Single source of truth for the release notes body.
// Usage: node scripts/release-body.mjs <product>
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);

export const PRODUCTS = [
  "audio-normalizer",
  "slowed-reverb",
  "crunchy-presence",
  "youtube-music-presence",
];

export function manifestOf(product) {
  if (!PRODUCTS.includes(product)) {
    throw new Error(`unknown product ${JSON.stringify(product)}`);
  }
  const manifest = JSON.parse(readFileSync(join(ROOT, "packages", product, "manifest.json"), "utf8"));
  for (const key of ["name", "description", "version"]) {
    if (typeof manifest[key] !== "string" || manifest[key].length === 0) {
      throw new Error(`packages/${product}/manifest.json has no ${key}`);
    }
  }
  return manifest;
}

export function requiresNativeHost(product) {
  const permissions = manifestOf(product).permissions;
  return Array.isArray(permissions) && permissions.includes("nativeMessaging");
}

export function releaseBody(product) {
  const manifest = manifestOf(product);
  const lines = [
    manifest.description,
    "",
    `**Version:** ${manifest.version}`,
    "**Install:** download the zip, unzip it anywhere, then Load unpacked the folder containing `manifest.json` in `chrome://extensions` with Developer mode on.",
  ];
  if (requiresNativeHost(product)) {
    lines.push("**Native host:** run `node scripts/install-host.mjs` once from the unzipped folder to register the host for Discord.");
  }
  lines.push(`**Source:** \`packages/${product}\` in this repository.`);
  lines.push("");
  lines.push("This release is replaced in place on every update - the link never changes.");
  return lines.join("\n");
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === SELF;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !PRODUCTS.includes(args[0])) {
    console.error("usage: node scripts/release-body.mjs <product>");
    process.exit(1);
  }
  try {
    // Write verbatim: one body, no trailing newline and therefore no trailing blank line.
    process.stdout.write(releaseBody(args[0]));
  } catch (error) {
    console.error(`release-body: ${error.message}`);
    process.exit(1);
  }
}
