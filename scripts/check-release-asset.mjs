#!/usr/bin/env node
// Verify that every file path named in the generated release body is in the zip.
// Usage: node scripts/check-release-asset.mjs --zip dist/<product>.zip --product <product>
//        node scripts/check-release-asset.mjs --asset <downloaded.zip> --product <product>
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { releaseBody, requiresNativeHost } from "./release-body.mjs";

function fail(message) {
  console.error(`check-release-asset: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  let zip = null;
  let product = null;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag !== "--zip" && flag !== "--asset" && flag !== "--product") {
      fail(`unknown argument ${JSON.stringify(flag)}`);
    }
    const value = argv[++i];
    if (!value || value.startsWith("--")) fail(`${flag} needs a value`);
    if (flag === "--product") {
      if (product !== null) fail("--product given twice");
      product = value;
    } else {
      if (zip !== null) fail("give either --zip or --asset once");
      zip = value;
    }
  }
  if (!zip) fail("usage: node scripts/check-release-asset.mjs --zip <path> --product <product> [--asset <path>]");
  if (!product) fail("--product is required");
  return { zip, product };
}

// Prefer the same tool CI uses. Fall back to a small central-directory reader on
// hosts without unzip (Node has no built-in zip entry API).
function entriesFromUnzip(zip) {
  const result = spawnSync("unzip", ["-Z1", zip], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).filter((name) => name !== "");
}

function entriesFromCentralDirectory(zip) {
  const buf = readFileSync(zip);
  const EOCD = 0x06054b50;
  const CENTRAL = 0x02014b50;
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${zip} is not a zip archive`);
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(offset) !== CENTRAL) throw new Error(`${zip} has a broken central directory`);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    names.push(buf.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

function zipEntries(zip) {
  const fromUnzip = entriesFromUnzip(zip);
  const names = fromUnzip ?? entriesFromCentralDirectory(zip);
  return new Set(names.map((name) => name.replace(/\\/g, "/").replace(/^\.\//, "")));
}

// Backtick spans in the body: manifest.json, chrome://extensions,
// `node scripts/install-host.mjs`, packages/<product>. Only file-like tokens
// are zip candidates; URLs and source-tree paths are not shipped files.
const FILE_TOKEN = /(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.[A-Za-z0-9]+/g;

function bodyPaths(body) {
  const paths = new Set();
  for (const span of body.match(/`[^`]+`/g) ?? []) {
    const text = span.slice(1, -1);
    for (const token of text.match(FILE_TOKEN) ?? []) {
      if (token.includes("://") || token.startsWith("packages/")) continue;
      paths.add(token);
    }
  }
  return paths;
}

const { zip, product } = parseArgs(process.argv.slice(2));

let body;
try {
  body = releaseBody(product);
} catch (error) {
  fail(error.message);
}

const paths = bodyPaths(body);
const required = ["manifest.json"];
if (requiresNativeHost(product)) required.push("scripts/install-host.mjs");
const shapeMissing = required.filter((path) => !paths.has(path));
if (shapeMissing.length > 0) {
  for (const path of shapeMissing) console.log(`MISSING ${path}`);
  process.exit(1);
}

let entries;
try {
  entries = zipEntries(zip);
} catch (error) {
  fail(error.message);
}

let missing = 0;
for (const path of [...paths].sort()) {
  const ok = entries.has(path);
  console.log(`${ok ? "OK" : "MISSING"} ${path}`);
  if (!ok) missing += 1;
}
process.exit(missing === 0 ? 0 : 1);
