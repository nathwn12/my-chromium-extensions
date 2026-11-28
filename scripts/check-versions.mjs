#!/usr/bin/env node
// Version coherence gate. A package's version lives in four places; compare all
// of them in one run so a release cannot ship a silently wrong version:
//   packages/<pkg>/manifest.json#version  - reference, must be x.y.z
//   packages/<pkg>/package.json#version   - checked only when the key exists
//   bun.lock workspaces["packages/<pkg>"].version
//   packages/<pkg>/CHANGELOG.md top released "## [x.y.z]" heading
// A missing CHANGELOG.md is a warning, not a failure. Every disagreement is
// reported; the run never stops at the first one.
// Usage: node scripts/check-versions.mjs [--root <dir>] [--json]
// Exit 0 = coherent, 1 = at least one disagreement, 2 = bad arguments.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+$/;
const rel = (...parts) => parts.join("/");

function readIfExists(path) {
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  return readFileSync(path, "utf8");
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// bun.lock is JSONC, not strict JSON: the workspace objects carry trailing
// commas. Strip them outside strings, then parse only the workspaces object.
// Extracting by brace matching keeps the rest of the lockfile (whose package
// entries are arbitrary JSONC arrays) out of this gate entirely. No deps.
export function parseWorkspaces(text) {
  const key = /"workspaces"\s*:\s*\{/.exec(text);
  if (!key) return null;
  const start = key.index + key[0].length - 1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        let out = "";
        quoted = false;
        escaped = false;
        const body = text.slice(start, i + 1);
        for (let j = 0; j < body.length; j++) {
          const c = body[j];
          if (quoted) {
            out += c;
            if (escaped) escaped = false;
            else if (c === "\\") escaped = true;
            else if (c === '"') quoted = false;
            continue;
          }
          if (c === '"') {
            quoted = true;
            out += c;
            continue;
          }
          if (c === ",") {
            let next = j + 1;
            while (next < body.length && /\s/.test(body[next])) next++;
            if (body[next] === "}" || body[next] === "]") continue;
          }
          out += c;
        }
        return parseJson(out);
      }
    }
  }
  return null;
}

// The highest released heading, ignoring "## [Unreleased]" and any prose.
function topReleasedHeading(changelog) {
  let best = null;
  let bestParts = null;
  for (const match of changelog.matchAll(/^##\s+\[(\d+\.\d+\.\d+)\]/gm)) {
    const version = match[1];
    const parts = version.split(".").map(Number);
    const higher = !bestParts || parts[0] > bestParts[0] ||
      (parts[0] === bestParts[0] && parts[1] > bestParts[1]) ||
      (parts[0] === bestParts[0] && parts[1] === bestParts[1] && parts[2] > bestParts[2]);
    if (higher) {
      best = version;
      bestParts = parts;
    }
  }
  return best;
}

export function runCheck(root) {
  const problems = [];
  const warnings = [];
  const packages = [];
  const fail = (pkg, file, expected, actual, message) =>
    problems.push({ package: pkg, file, expected, actual, message });

  let entries;
  try {
    entries = readdirSync(join(root, "packages"), { withFileTypes: true });
  } catch (error) {
    fail("(repo)", "packages", "(packages/)", "(missing)",
      `cannot read packages/: ${error.message}`);
    return { packages, problems, warnings, ok: false };
  }

  const workspaces = parseWorkspaces(readIfExists(join(root, "bun.lock")) ?? "");
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const dir = join(root, "packages", name);
    const manifestRel = rel("packages", name, "manifest.json");
    if (!existsSync(join(dir, "manifest.json"))) continue;
    packages.push(name);

    const manifest = parseJson(readIfExists(join(dir, "manifest.json")) ?? "");
    const version = typeof manifest?.version === "string" ? manifest.version : null;
    if (version === null || !SEMVER.test(version)) {
      fail(name, manifestRel, "x.y.z", version ?? "(missing)",
        `manifest version ${version ?? "(missing)"} is not a valid x.y.z reference`);
      continue;
    }

    const packageRel = rel("packages", name, "package.json");
    const pkgJson = parseJson(readIfExists(join(dir, "package.json")) ?? "");
    if (pkgJson && Object.hasOwn(pkgJson, "version")) {
      const actual = typeof pkgJson.version === "string" ? pkgJson.version : JSON.stringify(pkgJson.version);
      if (actual !== version)
        fail(name, packageRel, version, actual,
          `version ${actual} != manifest.json ${version}`);
    }

    const lockRel = "bun.lock";
    const workspace = workspaces?.[rel("packages", name)];
    if (!workspace) {
      fail(name, lockRel, version, "(missing)",
        `no workspace entry for "packages/${name}" (expected version ${version})`);
    } else if (typeof workspace.version !== "string" || !SEMVER.test(workspace.version)) {
      fail(name, lockRel, version, workspace.version ?? "(missing)",
        `workspace version ${workspace.version ?? "(missing)"} is not a valid x.y.z, expected ${version}`);
    } else if (workspace.version !== version) {
      fail(name, lockRel, version, workspace.version,
        `workspace version ${workspace.version} != manifest.json ${version}`);
    }

    const changelogRel = rel("packages", name, "CHANGELOG.md");
    const changelog = readIfExists(join(dir, "CHANGELOG.md"));
    if (changelog === null) {
      warnings.push({ package: name, file: changelogRel,
        message: "CHANGELOG.md missing - changelog version check skipped" });
      continue;
    }
    const top = topReleasedHeading(changelog);
    if (top === null) {
      fail(name, changelogRel, version, "(none)",
        `no released "## [x.y.z]" heading, expected ${version}`);
    } else if (top !== version) {
      fail(name, changelogRel, version, top,
        `top released heading ${top} != manifest.json ${version}`);
    }
  }

  return { packages, problems, warnings, ok: problems.length === 0 };
}

function parseArgs(argv) {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") json = true;
    else if (argv[i] === "--root") {
      if (!argv[i + 1]) {
        console.error("check-versions: --root needs a directory");
        process.exit(2);
      }
      root = resolve(argv[++i]);
    } else {
      console.error(`check-versions: unknown argument ${argv[i]}`);
      process.exit(2);
    }
  }
  return { root, json };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { root, json } = parseArgs(process.argv.slice(2));
  const result = runCheck(root);
  const summary = result.problems.length === 0
    ? `version check: OK (${result.packages.length} packages)`
    : `version check: ${result.problems.length} problems`;
  if (json) {
    process.stdout.write(`${JSON.stringify({
      ok: result.ok,
      packages: result.packages.length,
      problems: result.problems,
      warnings: result.warnings,
      summary,
    }, null, 2)}\n`);
  } else {
    for (const w of result.warnings)
      process.stdout.write(`WARN ${w.package} ${w.file}: ${w.message}\n`);
    for (const p of result.problems)
      process.stdout.write(`FAIL ${p.package} ${p.file}: ${p.message}\n`);
    process.stdout.write(`${summary}\n`);
  }
  process.exit(result.problems.length === 0 ? 0 : 1);
}
