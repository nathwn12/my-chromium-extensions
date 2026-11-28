#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildPlan, validatePackageName } from "./release-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FLAGS = new Set(["--dry-run", "--commit", "--tag", "--push"]);
const USAGE =
  "usage: node scripts/release.mjs <package> [<package>...] <major|minor|patch|x.y.z> [--dry-run] [--commit] [--tag] [--push]";

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function parseArgs(args) {
  const flags = new Set();
  const positional = [];
  for (const arg of args) {
    if (FLAGS.has(arg)) {
      if (flags.has(arg)) fail(`duplicate flag ${arg}`);
      flags.add(arg);
    } else if (arg.startsWith("--")) {
      fail(`unknown flag ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  const bump = positional.at(-1);
  const pkgs = positional.slice(0, -1);
  if (!bump || pkgs.length === 0) fail(USAGE);
  for (const pkg of pkgs) {
    try { validatePackageName(pkg); } catch (error) { fail(error.message); }
  }
  if (flags.has("--tag") && !flags.has("--commit")) fail("--tag requires --commit");
  if (flags.has("--push") && (!flags.has("--commit") || !flags.has("--tag"))) {
    fail("--push requires --commit and --tag");
  }
  return { pkgs, bump, flags, dryRun: flags.has("--dry-run") };
}

function readInputs(root, pkgs) {
  const files = {};
  try { files["bun.lock"] = readFileSync(join(root, "bun.lock"), "utf8"); }
  catch { fail("bun.lock is missing"); }
  for (const pkg of pkgs) {
    for (const name of ["manifest.json", "package.json", "CHANGELOG.md"]) {
      const rel = `packages/${pkg}/${name}`;
      try { files[rel] = readFileSync(join(root, "packages", pkg, name), "utf8"); }
      catch (error) {
        if (name === "package.json" && error.code === "ENOENT") continue;
        fail(`${rel} is missing or unreadable for ${pkg}`);
      }
    }
  }
  return files;
}

function git(args, root) {
  const command = ["git", ...args].join(" ");
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} failed with exit ${result.status}: ${(result.stderr ?? "").trim()}`);
  return result.stdout ?? "";
}

const { pkgs, bump, flags, dryRun } = parseArgs(process.argv.slice(2));
const files = readInputs(ROOT, pkgs);
let plan;
try { plan = buildPlan({ pkgs, bump, date: new Date().toISOString().slice(0, 10), files }); }
catch (error) { fail(error.message); }

const owners = new Map(plan.writes.map((write) => [
  write.path,
  write.path === "bun.lock" ? pkgs.join(", ") : write.path.split("/")[1],
]));
const dirtyLines = git(["status", "--porcelain", "--", ...plan.writes.map((write) => write.path)], ROOT)
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);
if (dirtyLines.length > 0) {
  const names = dirtyLines.map((line) => {
    const path = line.slice(3).trim();
    return owners.has(path) ? `${path} (for ${owners.get(path)})` : line;
  }).join(", ");
  if (dryRun) {
    console.error(`release: note: a real run would refuse; dirty write paths: ${names}`);
  } else {
    fail(`refusing to overwrite modified files: ${names}; commit or stash first`);
  }
}

if (dryRun) {
  console.log("dry run: no files written");
  for (const entry of plan.packages) console.log(`${entry.pkg}: ${entry.current} -> ${entry.next}`);
  for (const write of plan.writes) console.log(`would write ${write.path}: ${write.note}`);
} else {
  for (const write of plan.writes) {
    writeFileSync(join(ROOT, ...write.path.split("/")), write.content);
    console.log(`wrote ${write.path}: ${write.note}`);
  }
}

const commands = [
  plan.commands.add,
  plan.commands.commit,
  ...plan.commands.tag,
  ...plan.commands.push,
];
console.log(dryRun ? "would run:" : "run:");
for (const command of commands) console.log(`  ${command}`);

if (dryRun) process.exit(0);
if (flags.has("--commit")) {
  git(["add", ...plan.writes.map((write) => write.path)], ROOT);
  git(["commit", "-m", plan.commitMessage], ROOT);
}
if (flags.has("--tag")) {
  for (const pkg of plan.tags) git(["tag", "-f", pkg], ROOT);
}
if (flags.has("--push")) {
  git(["push", "origin", "HEAD"], ROOT);
  git(["push", "--force", "origin", ...plan.tags], ROOT);
}
