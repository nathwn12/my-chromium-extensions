#!/usr/bin/env node
// Every predicate is proved red on a temporary fixture, never on the live tree.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./check-versions.mjs", import.meta.url));

function put(root, relative, text) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function newRoot() {
  return mkdtempSync(join(tmpdir(), "check-versions-"));
}

function writePkg(root, pkg, version, options = {}) {
  const dir = `packages/${pkg}`;
  put(root, `${dir}/manifest.json`, `${JSON.stringify({ name: pkg, version }, null, 2)}\n`);
  const pkgJson = options.noPackageVersion
    ? { name: pkg }
    : { name: pkg, version: options.packageVersion ?? version };
  put(root, `${dir}/package.json`, `${JSON.stringify(pkgJson, null, 2)}\n`);
  if (!options.noChangelog) {
    const heading = options.heading ?? version;
    put(root, `${dir}/CHANGELOG.md`,
      `# Changelog\n\n## [Unreleased]\n\n## [${heading}] - 2026-11-28\n\n- entry\n`);
  }
}

// The workspace objects are JSONC: note the trailing commas after each entry.
function writeLock(root, entries) {
  const body = entries.map(({ pkg, version }) =>
    `    "packages/${pkg}": {\n      "name": "${pkg}",\n` +
    `      "version": "${version}",\n    },\n`).join("");
  put(root, "bun.lock",
    `{\n  "lockfileVersion": 2,\n  "workspaces": {\n${body}  },\n}\n`);
}

function run(root, ...args) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root, ...args],
    { encoding: "utf8", cwd: root });
}

function withRoot(root, body) {
  try {
    body();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(existsSync(root), false, "temp fixture was not removed");
}

test("all four sources agreeing passes with the exact human and JSON summaries", () => {
  const root = newRoot();
  withRoot(root, () => {
    writePkg(root, "alpha", "1.2.3");
    writeLock(root, [{ pkg: "alpha", version: "1.2.3" }]);
    const human = run(root);
    assert.equal(human.status, 0, human.stdout + human.stderr);
    assert.match(human.stdout, /version check: OK \(1 packages\)\n$/);
    assert.doesNotMatch(human.stdout, /^(FAIL|WARN)/m);
    const machine = run(root, "--json");
    assert.equal(machine.status, 0, machine.stdout + machine.stderr);
    const data = JSON.parse(machine.stdout);
    assert.equal(data.ok, true);
    assert.equal(data.packages, 1);
    assert.deepEqual(data.problems, []);
    assert.deepEqual(data.warnings, []);
    assert.equal(data.summary, "version check: OK (1 packages)");
  });
});

test("package.json mismatch fails and names the file and both values", () => {
  const root = newRoot();
  withRoot(root, () => {
    writePkg(root, "alpha", "1.2.3", { packageVersion: "1.2.4" });
    writeLock(root, [{ pkg: "alpha", version: "1.2.3" }]);
    const result = run(root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /FAIL alpha packages\/alpha\/package\.json:.*1\.2\.4.*1\.2\.3/);
    assert.match(result.stdout, /version check: 1 problems\n$/);
  });
});

test("bun.lock workspace mismatch fails and names bun.lock and both values", () => {
  const root = newRoot();
  withRoot(root, () => {
    writePkg(root, "alpha", "1.2.3");
    writeLock(root, [{ pkg: "alpha", version: "9.9.9" }]);
    const result = run(root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /FAIL alpha bun\.lock:.*9\.9\.9.*1\.2\.3/);
    assert.match(result.stdout, /version check: 1 problems\n$/);
  });
});

test("top released changelog heading mismatch fails and names the file", () => {
  const root = newRoot();
  withRoot(root, () => {
    writePkg(root, "alpha", "1.2.3", { heading: "2.0.0" });
    writeLock(root, [{ pkg: "alpha", version: "1.2.3" }]);
    const result = run(root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /FAIL alpha packages\/alpha\/CHANGELOG\.md:.*2\.0\.0.*1\.2\.3/);
    assert.match(result.stdout, /version check: 1 problems\n$/);
  });
});

test("a missing CHANGELOG.md warns but does not fail", () => {
  const root = newRoot();
  withRoot(root, () => {
    writePkg(root, "alpha", "1.2.3", { noChangelog: true });
    writeLock(root, [{ pkg: "alpha", version: "1.2.3" }]);
    const human = run(root);
    assert.equal(human.status, 0, human.stdout + human.stderr);
    assert.match(human.stdout, /WARN alpha packages\/alpha\/CHANGELOG\.md:.*skipped/);
    assert.match(human.stdout, /version check: OK \(1 packages\)\n$/);
    const machine = run(root, "--json");
    const data = JSON.parse(machine.stdout);
    assert.equal(data.ok, true);
    assert.equal(data.warnings.length, 1);
    assert.equal(data.warnings[0].file, "packages/alpha/CHANGELOG.md");
  });
});

test("two problems in two packages are both reported in one run", () => {
  const root = newRoot();
  withRoot(root, () => {
    writePkg(root, "alpha", "1.0.0", { packageVersion: "9.0.0" });
    writePkg(root, "beta", "2.0.0", { heading: "3.0.0" });
    writeLock(root, [
      { pkg: "alpha", version: "1.0.0" },
      { pkg: "beta", version: "2.0.0" },
    ]);
    const result = run(root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const fails = result.stdout.split(/\r?\n/).filter((line) => line.startsWith("FAIL "));
    assert.equal(fails.length, 2, result.stdout);
    assert.match(fails[0], /^FAIL alpha packages\/alpha\/package\.json:/);
    assert.match(fails[1], /^FAIL beta packages\/beta\/CHANGELOG\.md:/);
    assert.match(result.stdout, /version check: 2 problems\n$/);
    const machine = run(root, "--json");
    const data = JSON.parse(machine.stdout);
    assert.deepEqual(data.problems.map((p) => p.package), ["alpha", "beta"]);
  });
});

test("an absent package.json version is not a failure", () => {
  const root = newRoot();
  withRoot(root, () => {
    writePkg(root, "alpha", "1.2.3", { noPackageVersion: true });
    writeLock(root, [{ pkg: "alpha", version: "1.2.3" }]);
    assert.equal(run(root).status, 0);
  });
});

test("a missing bun.lock workspace entry fails with an explicit message", () => {
  const root = newRoot();
  withRoot(root, () => {
    writePkg(root, "alpha", "1.2.3");
    writeLock(root, []);
    const result = run(root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout,
      /FAIL alpha bun\.lock: no workspace entry for "packages\/alpha" \(expected version 1\.2\.3\)/);
  });
});

test("an invalid manifest version is the one reported reference failure", () => {
  const root = newRoot();
  withRoot(root, () => {
    writePkg(root, "alpha", "1.2");
    writeLock(root, [{ pkg: "alpha", version: "1.2" }]);
    const result = run(root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /FAIL alpha packages\/alpha\/manifest\.json:.*1\.2.*x\.y\.z/);
  });
});
