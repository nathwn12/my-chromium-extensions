# sort-root-docs: root README truth, versions and installer labels

## Outcome

The root README now says four extensions and lists each package at its manifest version (audio-normalizer 5.4.3, slowed-reverb 1.1.0, crunchy-presence 1.2.0, web-discord-rpc 1.0.0), scopes Slowed Reverb to YouTube Music, and names the RPC extension **YouTube Presence** while its path stays `packages/web-discord-rpc`. The installer and native host descriptions follow the same name, pinned by an assertion in the installer test. `scripts/verify-integration.mjs` grew two predicates — one for the README row set and stated count, one for every version cell — each with a prove-red fixture, so count or version drift now fails by name.

## Evidence

Red first, before the README was touched — the two new predicates against the old README:

```text
$ node scripts/verify-integration.mjs
PASS: workspaces cover packages/*
PASS: root test script runs the web-discord-rpc workspace
PASS: package test script runs every test under test/
PASS: package test/ holds at least one test file
PASS: README names the package with its version
FAIL: README lists every package once
  README lists every package once: README says three; there are 4 packages
FAIL: README lists each package at its manifest version
  README lists each package at its manifest version: crunchy-presence: README 1.0.1 vs manifest 1.2.0; slowed-reverb: README 1.0.3 vs manifest 1.1.0
...
verify-integration: 2 wiring point(s) broken (root: Q:\PROJECTS\PERSONAL\my-chromium-extensions)
EXIT=1
```

The check that cannot go red is not a check — every predicate, including both new ones, fails on a broken fixture:

```text
$ node scripts/verify-integration.mjs --prove-red
prove-red: workspaces cover packages/* -> red as expected
...
prove-red: README lists every package once -> red as expected
prove-red: README lists each package at its manifest version -> red as expected
...
prove-red: 15/15 checks can go red
EXIT=0
```

The brief's check at the head handed back (`51b5797`):

```text
$ node scripts/verify-integration.mjs && node --test packages/web-discord-rpc/test/native/host.test.mjs packages/web-discord-rpc/test/scripts/install-host.test.mjs
PASS: workspaces cover packages/*
PASS: root test script runs the web-discord-rpc workspace
PASS: package test script runs every test under test/
PASS: package test/ holds at least one test file
PASS: README names the package with its version
PASS: README lists every package once
PASS: README lists each package at its manifest version
PASS: CI defines a web-discord-rpc job that runs tests
PASS: CI web job runs the native host selftest and both e2e scripts
PASS: release zips the package and attaches the zip
PASS: every file in the release zip step exists
PASS: release zip contains every local file the manifest names
PASS: no package.json declares Playwright
PASS: the lockfile resolves no Playwright package
PASS: no source or CI step imports Playwright

verify-integration: 15/15 wiring points hold
ℹ tests 20
ℹ pass 20
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
EXIT=0
```

The label change is proven by the installer test, not by the diff alone:

```text
✔ host manifest and launcher are built from absolute paths (1.0396ms)
```
(that test now asserts `manifest.description === 'YouTube Presence native messaging host'`; revert the description and it fails.)

Commit: `51b5797 root README lists four extensions at their real versions` — 5 files, 94 insertions, 7 deletions.

## Unverified

- **The whole `web-discord-rpc` suite is not green, and not because of me.** `npm test --workspace=web-discord-rpc` exits 1 at `test/extension/ui.test.mjs:494` (`actual 'Nothing playing'`, `expected 'Off in Settings'`). That file, `test/extension/manifest.test.mjs` and `test/docs.test.mjs` carry uncommitted edits from another seam that is renaming the extension to YouTube Presence; its `popup.js`/`options.js`/`manifest.json` half has not landed yet. I did not run the full root `npm test` for the same reason: it would report that seam's in-flight red, not mine.
- The README still documents only Crunchy Presence's installer. The brief's Out did not ask for a YouTube Presence install section, so I did not add one; the package README covers it.
- I did not check the rendered README on any browser or Markdown viewer; the table is plain GitHub-flavoured Markdown and the new predicates parse it, which is the only consumer I have.

## Scope

Touched, all inside Owns:

- `README.md` — four extensions, manifest versions, Slowed Reverb scope, YouTube Presence row label.
- `scripts/verify-integration.mjs` — `packages` in the context, `readmeRows`, two predicates, two prove-red fixtures.
- `packages/web-discord-rpc/scripts/install-host.mjs` — module doc line and host-manifest `description`.
- `packages/web-discord-rpc/test/scripts/install-host.test.mjs` — one assertion pinning the description.
- `packages/web-discord-rpc/native/host.mjs` — module doc line only.

Nothing outside Owns was edited by me. `HOST_NAME`, `INSTALL_DIR_NAME`, the extension ID and every other file are untouched; `.stack/` edits in the tree are the lead's and other seams', and my commit staged only the five paths above.

## Lesson

The root README was the last unverified surface: every other wiring point had a predicate, so it drifted to three extensions and two stale versions while the suite stayed green. If you rename this extension, the name lives in five places across three seams — `manifest.json` and the UI tests, the package docs test, the root README row, and the installer/host descriptions — so land the rename in one wave or each suite will contradict the next. The row parser keys on the link target `packages/<dir>` and the third cell, so a new package needs only a manifest plus a row, and a broken one fails by name instead of silently.
