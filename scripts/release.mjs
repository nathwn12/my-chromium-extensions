#!/usr/bin/env node
// Bump one extension package to the next version across every file that carries it.
// Usage: node scripts/release.mjs <package> <major|minor|patch|x.y.z> [--dry-run]
//
// Reads the current version from the package's manifest.json, computes the next
// version, and writes it to manifest.json, package.json (when it carries a
// version) and the CHANGELOG (promoting `## [Unreleased]` to the new version and
// leaving a fresh empty `## [Unreleased]` above it). Prints the exact git
// commands to commit, tag and push; this script never commits, tags or pushes.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function parseSemver(text, what) {
  const match = SEMVER_RE.exec(text.trim());
  if (!match) fail(`${what} is not x.y.z (got ${JSON.stringify(text)})`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

// Keep the file's own line endings so the diff touches only version lines.
function eolOf(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function formatJson(raw, value) {
  return JSON.stringify(value, null, 2).split("\n").join(eolOf(raw)) + eolOf(raw);
}

const [pkg, bump, flag] = process.argv.slice(2);
if (!pkg || !bump || (flag !== undefined && flag !== "--dry-run")) {
  fail("usage: node scripts/release.mjs <package> <major|minor|patch|x.y.z> [--dry-run]");
}
const dryRun = flag === "--dry-run";
if (pkg.includes("/") || pkg.includes("\\") || pkg === "." || pkg === "..") {
  fail(`invalid package name ${JSON.stringify(pkg)}`);
}
const dir = join(ROOT, "packages", pkg);

let manifestRaw;
try {
  manifestRaw = readFileSync(join(dir, "manifest.json"), "utf8");
} catch {
  fail(`unknown package ${JSON.stringify(pkg)} (no packages/${pkg}/manifest.json)`);
}
const current = parseSemver(JSON.parse(manifestRaw).version ?? "", `packages/${pkg}/manifest.json version`);

let next;
if (bump === "major" || bump === "minor" || bump === "patch") {
  next = [...current];
  const index = bump === "major" ? 0 : bump === "minor" ? 1 : 2;
  next[index] += 1;
  for (let i = index + 1; i < 3; i += 1) next[i] = 0;
} else {
  next = parseSemver(bump, "requested version");
  if (compare(next, current) === 0) fail(`requested version ${bump} equals the current version`);
  if (compare(next, current) < 0) fail(`requested version ${bump} is below the current version ${current.join(".")}`);
}
const nextText = next.join(".");

let packageRaw = null;
let packageJson = null;
try {
  packageRaw = readFileSync(join(dir, "package.json"), "utf8");
  packageJson = JSON.parse(packageRaw);
} catch {
  packageJson = null;
}
const packageHasVersion = !!packageJson && typeof packageJson.version === "string";

let changelogRaw;
try {
  changelogRaw = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
} catch {
  fail(`packages/${pkg}/CHANGELOG.md is missing`);
}
const changelogEol = eolOf(changelogRaw);
if (!new RegExp(`^## \\[Unreleased\\][ \\t]*$`, "m").test(changelogRaw)) {
  fail(`packages/${pkg}/CHANGELOG.md has no ## [Unreleased] section to promote`);
}
const latestMatch = [...changelogRaw.matchAll(/^## \[(\d+\.\d+\.\d+)\].*$/gm)][0];
const latest = latestMatch ? latestMatch[1] : null;

// The one check that can fail: every versioned copy must agree before the bump.
const disagreements = [];
if (packageHasVersion && packageJson.version !== current.join(".")) {
  disagreements.push(`package.json is ${packageJson.version}`);
}
if (latest !== current.join(".")) {
  disagreements.push(`CHANGELOG latest is ${latest ?? "missing"}`);
}
if (disagreements.length > 0) {
  fail(
    `versions already disagree for ${pkg}: manifest is ${current.join(".")}, ` +
      `${disagreements.join(", ")}; fix by hand before releasing`
  );
}

const status = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
if (status.error) fail(`cannot check tree cleanliness: ${status.error.message}`);
const dirty = (status.stdout ?? "").trim() !== "";
if (dirty && !dryRun) {
  fail("tree is dirty (git status is not empty); commit or stash first, or pass --dry-run to preview");
}

const today = new Date().toISOString().slice(0, 10);
const nextChangelogRaw = changelogRaw.replace(
  new RegExp(`^## \\[Unreleased\\][ \\t]*$`, "m"),
  `## [Unreleased]${changelogEol}${changelogEol}## [${nextText}] - ${today}`
);

const changedFiles = [`packages/${pkg}/manifest.json`];
if (packageHasVersion) changedFiles.push(`packages/${pkg}/package.json`);
changedFiles.push(`packages/${pkg}/CHANGELOG.md`);

if (dryRun) {
  if (dirty) console.error("release: note: tree is dirty, a real run would refuse; preview only");
  console.log(`package: ${pkg}`);
  console.log(`current: ${current.join(".")}`);
  console.log(`next: ${nextText}`);
  console.log(`would write packages/${pkg}/manifest.json: "version": "${current.join(".")}" -> "${nextText}"`);
  if (packageHasVersion) {
    console.log(`would write packages/${pkg}/package.json: "version": "${packageJson.version}" -> "${nextText}"`);
  }
  console.log(
    `would update packages/${pkg}/CHANGELOG.md: promote ## [Unreleased] to ## [${nextText}] - ${today}`
  );
} else {
  writeFileSync(
    join(dir, "manifest.json"),
    formatJson(manifestRaw, { ...JSON.parse(manifestRaw), version: nextText })
  );
  console.log(`wrote packages/${pkg}/manifest.json: ${current.join(".")} -> ${nextText}`);
  if (packageHasVersion) {
    writeFileSync(join(dir, "package.json"), formatJson(packageRaw, { ...packageJson, version: nextText }));
    console.log(`wrote packages/${pkg}/package.json: ${packageJson.version} -> ${nextText}`);
  }
  writeFileSync(join(dir, "CHANGELOG.md"), nextChangelogRaw);
  console.log(`wrote packages/${pkg}/CHANGELOG.md: promoted ## [Unreleased] to ## [${nextText}] - ${today}`);
}

console.log("run:");
console.log(`git add ${changedFiles.join(" ")}`);
console.log(`git commit -m "${pkg}: release ${nextText}"`);
console.log(`git tag v${nextText}`);
console.log("git push origin HEAD");
console.log(`git push origin v${nextText}`);
