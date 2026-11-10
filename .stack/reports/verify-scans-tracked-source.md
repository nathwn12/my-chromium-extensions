# Report verify-scans-tracked-source

## Outcome

The no-Playwright guard now walks the tree with no catch at all: `readdirSync`/`statSync` failures propagate, are recorded at the scan boundary, and fail the new predicate `the Playwright scan reads every source file` by path. File selection no longer keys on `.js`/`.ts`: every file a commit would carry is read unless its extension is one of the named assets (png, ico, jpg, jpeg, gif, webp, woff, woff2, ttf, zip, pdf) or it lives under the named exclusions (node_modules, .git, .stack), and `--prove-red` plants a quoted specifier in an `.html` inside the real tree, watches the real scan fail by naming it, then removes it.

One design call the brief did not spell out: "scans every text-like file" is implemented as **the commit surface**, not the disk. Two git-ignored stale artifacts under `packages/` (`audio-normalizer/package-lock.json`, `slowed-reverb/package-lock.json`) still name the banned package; they are covered by an existing ignore rule (`.gitignore: packages/*/package-lock.json`) and earlier ignore rules, and they are not repo source. Git answers the question (`ls-files -z --cached --others --exclude-standard`), so no path is exempted by name and the guard still catches a newly written, unignored file — that is exactly how the `--prove-red` fixture is caught. This matches the seam name and `.stack/goal.md` ("scans the tracked source surface").

## Evidence

At the head handed back (`a052c90`, working tree clean for this file):

```
$ node scripts/verify-integration.mjs
scan: 200 tracked source files read from 259 on disk (6 .html); 0 unreadable
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
PASS: the Playwright scan reads every source file
PASS: no source or CI step imports Playwright

verify-integration: 16/16 wiring points hold
exit=0
```

```
$ node scripts/verify-integration.mjs --prove-red
prove-red: a planted .html specifier -> red by name (.prove-red-scan-iOh4aR/planted.html)
prove-red: the planted .html fixture was removed, tree unchanged
prove-red: workspaces cover packages/* -> red as expected
prove-red: root test script runs the web-discord-rpc workspace -> red as expected
prove-red: package test script runs every test under test/ -> red as expected
prove-red: package test/ holds at least one test file -> red as expected
prove-red: README names the package with its version -> red as expected
prove-red: README lists every package once -> red as expected
prove-red: README lists each package at its manifest version -> red as expected
prove-red: CI defines a web-discord-rpc job that runs tests -> red as expected
prove-red: CI web job runs the native host selftest and both e2e scripts -> red as expected
prove-red: release zips the package and attaches the zip -> red as expected
prove-red: every file in the release zip step exists -> red as expected
prove-red: release zip contains every local file the manifest names -> red as expected
prove-red: no package.json declares Playwright -> red as expected
prove-red: the lockfile resolves no Playwright package -> red as expected
prove-red: the Playwright scan reads every source file -> red as expected
prove-red: no source or CI step imports Playwright -> red as expected
prove-red: 16/16 checks can go red
exit=0
$ git status --short
 M .stack/digest.md
 M .stack/goal.md
 M .stack/ledger.md
?? .stack/briefs/site-disable-cancels-queue.md
?? .stack/briefs/verify-scans-tracked-source.md
?? .stack/reports/verify-scans-tracked-source.md
```

`--prove-red` created no leftover: the fixture directory is gone (`git status --short` above shows only `.stack/` entries, none of them mine).

Unreadable file, exercised end to end on a real filesystem (temp git root via `WDR_VERIFY_ROOT`, a file held with a `FileShare.None` handle):

```
scan: 2 tracked source files read from 2 on disk (0 .html); 1 unreadable
...
FAIL: the Playwright scan reads every source file
  the Playwright scan reads every source file: unreadable: locked.txt (EBUSY)
...
verify-integration: 15 wiring point(s) broken (root: C:\Users\nathan\AppData\Local\Temp\opencode\wdr-scan-red)
EXIT=1
```

## Unverified

- The `readdirSync` failure path was not exercised on a real unreadable **directory** (no Windows ACL fixture); only the `statSync`/`readFileSync` paths were forced red with `EBUSY`. All three throw from inside `walk()` or the read loop and are recorded by the same boundary, so the risk is the message shape, not a pass.
- The guard now needs `git` on PATH. That was not exercised where git is absent; a missing git records `git ls-files: <error>` as a scan failure and turns the check red rather than silently scanning nothing.
- `npm test`, lint and typecheck were not run here: the seam's Check is the two verifier commands, and root `lint`/`typecheck` only cover `packages/slowed-reverb` and `packages/audio-normalizer`.
- Pre-existing, unchanged and outside `Out`: `collectTests()` still swallows `readdirSync`/`statSync` failures. It is the test-file predicate, not the Playwright guard, so I left it and report it here.

## Scope

- `scripts/verify-integration.mjs` — the only edited file, inside `Owns`/`Files`.
- `.stack/reports/verify-scans-tracked-source.md` — the report this brief requires.
- No other path touched; the `--prove-red` fixture is created and deleted inside the run.

## Lesson

A guard that says "every source path" has to answer "which path is source" explicitly. Here the disk and the repo disagree: `packages/*/package-lock.json` are ignored leftovers that still name the banned package, so a naive whole-disk walk would have gone red on files no commit carries, and the tempting fix — exempting those two paths — is exactly the silent skip the audit condemned. Let git decide the commit surface and let the strict walk decide what exists; print both counts (`200 read from 259 on disk`) so a future narrowing is visible in the output instead of hidden in a regex.
