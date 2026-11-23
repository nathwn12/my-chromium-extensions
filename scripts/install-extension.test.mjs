import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
// OS temp dir through the installer's --local-app-data equivalent option.
// Nothing here writes the live %LOCALAPPDATA%, touches the registry, or spawns
// reg.exe. The temp roots are removed in after().
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoots = [];

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
