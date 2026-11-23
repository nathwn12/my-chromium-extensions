import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  PACKAGES,
  checkExtension,
  installExtension,
  resolvePayload,
  uninstallExtension,
} from "./install-extension.mjs";

// ISOLATION: every case passes localAppData as a fresh mkdtemp root under the
// OS temp dir, through the module option or the CLI's --local-app-data flag.
// Nothing here writes the live %LOCALAPPDATA%, touches the registry, or spawns
// reg.exe. The temp roots are removed in after().
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "install-extension.mjs");
const tempRoots = [];

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", windowsHide: true });
}

function freshLocalAppData() {
  const dir = mkdtempSync(path.join(tmpdir(), "wdr-ext-install-"));
  tempRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

for (const pkg of PACKAGES) {
  test(`${pkg}: installs the payload to the stable dir and checks green`, async () => {
    const localAppData = freshLocalAppData();
    const result = await installExtension({ root: ROOT, pkg, localAppData });
    assert.equal(result.name, pkg, "manifest name yields the existing install-dir name");
    assert.equal(path.basename(path.dirname(result.dir)), pkg);
    assert.ok(result.files.includes("manifest.json"));
    assert.ok(existsSync(path.join(result.dir, "manifest.json")));

    const checked = checkExtension({ root: ROOT, pkg, localAppData });
    assert.equal(checked.ok, true, checked.checks.filter((c) => !c.ok).map((c) => c.name).join(", "));
  });
}

test("the payload follows real imports, not only the manifest", () => {
  const expected = {
    "audio-normalizer": [
      "background.js", "shared.js", "content-script.js", "page-hook.js",
      "audio/normalizer-worklet.js", "popup.html", "popup.css", "popup.js",
      "icons/icon24.png", "icons/icon128.png",
    ],
    "slowed-reverb": [
      "background.js", "shared.js", "player-actions.js", "content-script.js",
      "page-hook.js", "dattorro-worklet.js", ".dev/section-import.json",
      "popup.html", "popup.css", "popup.js", "icons/icon24.png",
    ],
    "crunchy-presence": [
      "background.js", "config.js", "bridge-status.js", "extract.js", "content.js",
      "popup.html", "options.html", "options.css", "options.js", "icons/icon24.png",
    ],
    "youtube-music-presence": [
      "background.js", "config.js", "bridge-status.js", "activity.js",
      "extract-youtube.js", "content.js", "popup.html", "options.html",
      "options.css", "options.js", "icons/icon24.png",
    ],
  };
  for (const [pkg, files] of Object.entries(expected)) {
    const resolved = resolvePayload(path.join(ROOT, "packages", pkg));
    for (const rel of files) {
      assert.ok(resolved.includes(rel), `${pkg}: payload is missing ${rel}`);
    }
    assert.equal(resolved.includes("test/extension/activity.test.mjs"), false);
    assert.equal(resolved.includes("scripts/e2e-ipc.mjs"), false);
  }
});

test("--check goes red when one payload file is deleted", async () => {
  const localAppData = freshLocalAppData();
  await installExtension({ root: ROOT, pkg: "audio-normalizer", localAppData });
  const dir = path.join(localAppData, "audio-normalizer", "extension");
  const victim = path.join(dir, "popup.js");
  assert.ok(existsSync(victim));
  rmSync(victim);

  const checked = checkExtension({ root: ROOT, pkg: "audio-normalizer", localAppData });
  assert.equal(checked.ok, false);
  assert.ok(checked.checks.some((c) => !c.ok && c.name === "payload popup.js"));
});

test("--check goes red when one installed byte changes", async () => {
  const localAppData = freshLocalAppData();
  await installExtension({ root: ROOT, pkg: "audio-normalizer", localAppData });
  const victim = path.join(localAppData, "audio-normalizer", "extension", "popup.js");
  writeFileSync(victim, `${readFileSync(victim, "utf8")}\n`);

  const checked = checkExtension({ root: ROOT, pkg: "audio-normalizer", localAppData });
  assert.equal(checked.ok, false);
  const failure = checked.checks.find((c) => !c.ok && c.name === "payload popup.js");
  assert.ok(failure, "the modified payload file is named");
  assert.match(failure.detail, /hash mismatch/);
});

test("--check goes red and names an added file, including in a nested folder", async () => {
  const localAppData = freshLocalAppData();
  const result = await installExtension({ root: ROOT, pkg: "crunchy-presence", localAppData });
  const rogue = path.join(result.dir, "rogue.js");
  writeFileSync(rogue, "not part of the payload");
  const nested = path.join(result.dir, "old", "nested.js");
  mkdirSync(path.dirname(nested), { recursive: true });
  writeFileSync(nested, "stale nested file");

  const checked = checkExtension({ root: ROOT, pkg: "crunchy-presence", localAppData });
  assert.equal(checked.ok, false);
  const failures = checked.checks.filter((c) => !c.ok).map((c) => c.name);
  assert.ok(failures.includes("extra file rogue.js"), failures.join(", "));
  assert.ok(failures.includes("extra file old/nested.js"), failures.join(", "));
  assert.equal(checked.checks.find((c) => c.name === "extra file rogue.js").detail, rogue);
  assert.ok(existsSync(path.join(result.dir, ".install-state.json")), "the state file is not extra");
});

test("--check --json returns one parseable verdict", async () => {
  const localAppData = freshLocalAppData();
  await installExtension({ root: ROOT, pkg: "audio-normalizer", localAppData });
  const run = runCli([
    "audio-normalizer", "--check", "--json", "--local-app-data", localAppData,
  ]);
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dir, path.join(localAppData, "audio-normalizer", "extension"));
  assert.ok(Array.isArray(parsed.checks) && parsed.checks.length > 0);
  assert.ok(parsed.checks.every((check) => check.ok === true));
});

test("--check still passes after the install dir moves to another root", async () => {
  const first = freshLocalAppData();
  const second = freshLocalAppData();
  await installExtension({ root: ROOT, pkg: "crunchy-presence", localAppData: first });
  cpSync(
    path.join(first, "crunchy-presence"),
    path.join(second, "crunchy-presence"),
    { recursive: true },
  );
  const checked = checkExtension({ root: ROOT, pkg: "crunchy-presence", localAppData: second });
  assert.equal(checked.ok, true, checked.checks.filter((c) => !c.ok).map((c) => c.name).join(", "));
});

test("reinstall is idempotent and wipes a stale extra file", async () => {
  const localAppData = freshLocalAppData();
  const first = await installExtension({ root: ROOT, pkg: "slowed-reverb", localAppData });
  const stale = path.join(first.dir, "stale.js");
  writeFileSync(stale, "left over from an older payload");
  const nestedStale = path.join(first.dir, "old", "stale.js");
  mkdirSync(path.dirname(nestedStale), { recursive: true });
  writeFileSync(nestedStale, "left over in a nested folder");

  const second = await installExtension({ root: ROOT, pkg: "slowed-reverb", localAppData });
  assert.equal(existsSync(stale), false, "the wipe rule removes stale files at the root");
  assert.equal(existsSync(path.join(first.dir, "old")), false, "and stale folders");
  assert.deepEqual(second.files, first.files);
  assert.equal(checkExtension({ root: ROOT, pkg: "slowed-reverb", localAppData }).ok, true);
});

test("--uninstall removes only the extension subdir", async () => {
  const localAppData = freshLocalAppData();
  const result = await installExtension({ root: ROOT, pkg: "youtube-music-presence", localAppData });
  const parent = path.dirname(result.dir);
  writeFileSync(path.join(parent, "host.cmd"), "sentinel for the native host");
  writeFileSync(path.join(parent, "host-manifest.json"), "sentinel");

  const removed = await uninstallExtension({ root: ROOT, pkg: "youtube-music-presence", localAppData });
  assert.equal(removed.dir, result.dir);
  assert.equal(existsSync(result.dir), false);
  assert.ok(existsSync(path.join(parent, "host.cmd")), "native host files are untouched");
  assert.ok(existsSync(path.join(parent, "host-manifest.json")));
});

test("--uninstall via the CLI flag removes the folder and its state file", async () => {
  const localAppData = freshLocalAppData();
  const result = await installExtension({ root: ROOT, pkg: "youtube-music-presence", localAppData });
  const parent = path.dirname(result.dir);
  const statePath = path.join(result.dir, ".install-state.json");
  assert.ok(existsSync(statePath));
  writeFileSync(path.join(parent, "host.cmd"), "sentinel for the native host");

  const run = runCli([
    "youtube-music-presence", "--uninstall", "--local-app-data", localAppData,
  ]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^removed: /);
  assert.equal(existsSync(result.dir), false);
  assert.equal(existsSync(statePath), false);
  assert.ok(existsSync(path.join(parent, "host.cmd")), "native host files are untouched");
});

test("installs from an unzipped release root, not only from the repo", async () => {
  const pkg = "crunchy-presence";
  const unzipped = mkdtempSync(path.join(tmpdir(), "wdr-unzip-"));
  const localAppData = freshLocalAppData();
  cpSync(path.join(ROOT, "packages", pkg), unzipped, { recursive: true });
  mkdirSync(path.join(unzipped, "scripts"), { recursive: true });
  cpSync(
    path.join(ROOT, "scripts", "install-extension.mjs"),
    path.join(unzipped, "scripts", "install-extension.mjs"),
  );

  const result = await installExtension({ root: unzipped, pkg, localAppData });
  assert.ok(existsSync(path.join(result.dir, "manifest.json")));
  assert.equal(checkExtension({ root: unzipped, pkg, localAppData }).ok, true);
});

test("an unknown package is refused before any path is built", async () => {
  const localAppData = freshLocalAppData();
  await assert.rejects(
    installExtension({ root: ROOT, pkg: "../audio-normalizer", localAppData }),
    /unknown package/,
  );
});

// BULK SELECTOR: `all` refreshes every package in one call. Every case below
// uses a fresh mkdtemp localAppData through --local-app-data. No live path,
// registry, or registration is touched.

test("all: one install call refreshes all four trees and prints each path", async () => {
  const localAppData = freshLocalAppData();
  const run = runCli(["all", "--local-app-data", localAppData]);
  assert.equal(run.status, 0, run.stderr);
  const paths = [];
  for (const pkg of PACKAGES) {
    const dir = path.join(localAppData, pkg, "extension");
    paths.push(dir);
    assert.ok(run.stdout.includes(`Load unpacked: ${dir}`), run.stdout);
    assert.ok(existsSync(path.join(dir, "manifest.json")));
    const checked = checkExtension({ root: ROOT, pkg, localAppData });
    assert.equal(checked.ok, true, checked.checks.filter((c) => !c.ok).map((c) => c.name).join(", "));
  }
  assert.equal(new Set(paths).size, 4, "four distinct stable paths");
});

test("all --check: aggregate exit 0 when every tree is green", async () => {
  const localAppData = freshLocalAppData();
  for (const pkg of PACKAGES) await installExtension({ root: ROOT, pkg, localAppData });
  const run = runCli(["all", "--check", "--local-app-data", localAppData]);
  assert.equal(run.status, 0, run.stderr);
  for (const pkg of PACKAGES) assert.ok(run.stdout.includes(pkg), run.stdout);
});

test("all --check: aggregate exit 1 and names the tree when one is tampered", async () => {
  const localAppData = freshLocalAppData();
  for (const pkg of PACKAGES) await installExtension({ root: ROOT, pkg, localAppData });
  rmSync(path.join(localAppData, "audio-normalizer", "extension", "popup.js"));
  const run = runCli(["all", "--check", "--local-app-data", localAppData]);
  assert.equal(run.status, 1, run.stderr);
  assert.ok(run.stdout.includes("audio-normalizer"), run.stdout);
  assert.match(run.stdout, /payload popup\.js/);
});

test("all --check --json: one parseable aggregate verdict", async () => {
  const localAppData = freshLocalAppData();
  for (const pkg of PACKAGES) await installExtension({ root: ROOT, pkg, localAppData });
  rmSync(path.join(localAppData, "slowed-reverb", "extension", "popup.js"));
  const run = runCli(["all", "--check", "--json", "--local-app-data", localAppData]);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(run.status, 1);
  assert.ok(Array.isArray(parsed.results));
  assert.equal(parsed.results.length, 4);
  assert.equal(parsed.results.find((r) => r.pkg === "slowed-reverb").ok, false);
});

test("all: refused in a standalone release root (one manifest, not four)", () => {
  const unzipped = mkdtempSync(path.join(tmpdir(), "wdr-unzip-all-"));
  tempRoots.push(unzipped);
  cpSync(path.join(ROOT, "packages", "crunchy-presence"), unzipped, { recursive: true });
  mkdirSync(path.join(unzipped, "scripts"), { recursive: true });
  const cli = path.join(unzipped, "scripts", "install-extension.mjs");
  cpSync(path.join(ROOT, "scripts", "install-extension.mjs"), cli);
  const localAppData = freshLocalAppData();
  const run = spawnSync(process.execPath, [cli, "all", "--local-app-data", localAppData], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /repository layout/);
});

test("all --uninstall: bulk uninstall is refused", () => {
  const localAppData = freshLocalAppData();
  const run = runCli(["all", "--uninstall", "--local-app-data", localAppData]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /does not accept all/);
});
