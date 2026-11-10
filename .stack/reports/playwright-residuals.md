# Report playwright-residuals

**Seat:** employee (opencode-go/deepseek-v4.1-flash) · **Tier:** standard · **Head handed back:** `f997812`

## Outcome

The last Playwright importer, `packages/crunchy-presence/scripts/e2e-live.mjs`, is deleted; it was the only file in the tree that imported the package, and no `package.json` script or CI job called it. `scripts/verify-integration.mjs` now scans every source path with no exemption, spells the banned names in pieces so the guard passes its own rule, and its `--prove-red` fixture plants an import at the exact path the old `SCAN_SKIP` hid. The audio-normalizer and slowed-reverb AGENTS text, slowed-reverb eslint ignores and `.gitignore` no longer name Playwright or the QA scripts that commit `061d738` deleted, and the silent-worklet harness no longer names it either. Residual Playwright prose in three files outside `Owns` is listed under Scope and left untouched.

## Evidence

Check, exactly as the brief names it, run on the tree that became `f997812` (no file changed between the run and the commit):

```text
$ node scripts/verify-integration.mjs && npm test && npm run lint && npm run typecheck
verify-integration: 13/13 wiring points hold
npm notice run audio-normalizer@5.4.3 test        (tests 103, pass 103, fail 0)
npm notice run crunchy-presence@1.1.0 test        (tests 196, pass 196, fail 0)
npm notice run slowed-reverb@1.1.0 test           (tests 12, pass 12, fail 0)
npm notice run web-discord-rpc@1.0.0 test         (tests 202, pass 202, fail 0)
npm notice run eslint .                           (no output: 0 errors, 0 warnings)
npm notice run tsc --noEmit                       (no output)
CHECK-EXIT=0
```

Full 1140-line log: `C:\Users\nathan\.local\share\opencode\shell\646b076820d27ea2afbabf3f763dd86cb7a1f15f\sh_1c7545d1d001nXq2AFRFaOTFAm.out`. The per-workspace `ℹ tests / pass / fail` lines are folded into the parenthetical counts above; every other line of each command's output is verbatim.

Green verifier, full output:

```text
$ node scripts/verify-integration.mjs
PASS: workspaces cover packages/*
PASS: root test script runs the web-discord-rpc workspace
PASS: package test script runs every test under test/
PASS: package test/ holds at least one test file
PASS: README names the package with its version
PASS: CI defines a web-discord-rpc job that runs tests
PASS: CI web job runs the native host selftest and both e2e scripts
PASS: release zips the package and attaches the zip
PASS: every file in the release zip step exists
PASS: release zip contains every local file the manifest names
PASS: no package.json declares Playwright
PASS: the lockfile resolves no Playwright package
PASS: no source or CI step imports Playwright

verify-integration: 13/13 wiring points hold
EXIT=0
```

The scan is red on a planted import — the failing case watched, at a path the old skip hid:

```text
$ Set-Content -NoNewline -Path packages\crunchy-presence\scripts\planted-guard-fixture.mjs -Value "import { chromium } from 'playwright-core';`n"
$ node scripts/verify-integration.mjs
PASS: no package.json declares Playwright
PASS: the lockfile resolves no Playwright package
FAIL: no source or CI step imports Playwright
  no source or CI step imports Playwright: imports Playwright: packages/crunchy-presence/scripts/planted-guard-fixture.mjs

verify-integration: 1 wiring point(s) broken (root: Q:\PROJECTS\PERSONAL\my-chromium-extensions)
EXIT=1
$ Remove-Item packages\crunchy-presence\scripts\planted-guard-fixture.mjs
$ node scripts/verify-integration.mjs
verify-integration: 13/13 wiring points hold
EXIT=0
```

The built-in provered, with the new fixture inside it:

```text
$ node scripts/verify-integration.mjs --prove-red
prove-red: workspaces cover packages/* -> red as expected
prove-red: root test script runs the web-discord-rpc workspace -> red as expected
prove-red: package test script runs every test under test/ -> red as expected
prove-red: package test/ holds at least one test file -> red as expected
prove-red: README names the package with its version -> red as expected
prove-red: CI defines a web-discord-rpc job that runs tests -> red as expected
prove-red: CI web job runs the native host selftest and both e2e scripts -> red as expected
prove-red: release zips the package and attaches the zip -> red as expected
prove-red: every file in the release zip step exists -> red as expected
prove-red: release zip contains every local file the manifest names -> red as expected
prove-red: no package.json declares Playwright -> red as expected
prove-red: the lockfile resolves no Playwright package -> red as expected
prove-red: no source or CI step imports Playwright -> red as expected
prove-red: 13/13 checks can go red
PROVE-RED-EXIT=0
```

No import and no manifest or lockfile entry remains (each command exits 1, i.e. zero matches):

```text
$ git grep -n -F "from 'playwright" -- .            # ESM-IMPORT-EXIT=1
$ git grep -n -F "require('playwright" -- .         # CJS-IMPORT-EXIT=1
$ git grep -n -F '@playwright/test' -- . | Select-String -NotMatch '^\.stack'   # PKG-REF-EXIT=1
$ git grep -n -i playwright -- packages/*/package.json package-lock.json        # MANIFEST-EXIT=1
```

Commit:

```text
$ git show --stat --format='%h %s' f997812
f997812 the last Playwright import is gone and the guard scans the whole tree
 packages/audio-normalizer/AGENTS.md                |   4 -
 packages/audio-normalizer/qa/worklet-silent-analysis.cjs |   6 +-
 packages/crunchy-presence/scripts/e2e-live.mjs     | 136 ---------------------
 packages/slowed-reverb/.gitignore                  |   3 -
 packages/slowed-reverb/AGENTS.md                   |   8 --
 packages/slowed-reverb/eslint.config.mjs           |   3 -
 scripts/verify-integration.mjs                     |  27 ++--
 7 files changed, 19 insertions(+), 168 deletions(-)
```

## Unverified

- **GitHub CI was not run.** `node scripts/verify-integration.mjs` is the integration job and it passes locally on Node 26; `npm test`, `npm run lint` and `npm run typecheck`, which make up the other CI steps, also passed locally. The two audio QA steps (`qa/feed-transition-qa.cjs`, `qa/program-boundary-qa.cjs`) are **not** in this seam's `Check` and I did not run them; they are untouched pure-Node scripts. No job referenced `e2e-live.mjs`; that is checked by reading `.github/workflows/ci.yml`, not by a CI run.
- **`qa/worklet-silent-analysis.cjs` was not re-executed.** The three edits are inside string literals (a comment, the JSON `safety` string, one transcript `push`); nothing executable changed. It renders tens of seconds of 48 kHz audio per variant; I did not spend that time to prove a literal.
- **`packages/audio-normalizer/AGENTS.md` still says the tracked QA exceptions keep "exactly these three" tracked.** `qa/worklet-silent-analysis.cjs`, seven `proof-f*.cjs`, `hook-guard-silent.cjs` and `reference-meter.cjs` are tracked too. Pre-existing inaccuracy, outside `Out`; not fixed.
- **The AGENTS edit-tool warning about `.js` auto-reformat.** Its stated scope is `.js`; I edited a `.cjs`. `git diff --stat` on that file is 3 insertions / 3 deletions, so no reformat noise, but I did not test whether the quirk reaches `.cjs` in general.

## Scope

All seven paths are inside `Owns` and are exactly the seven in `Files`:

- `packages/crunchy-presence/scripts/e2e-live.mjs` (deleted)
- `scripts/verify-integration.mjs`
- `packages/audio-normalizer/AGENTS.md`
- `packages/slowed-reverb/AGENTS.md`
- `packages/audio-normalizer/qa/worklet-silent-analysis.cjs`
- `packages/slowed-reverb/eslint.config.mjs`
- `packages/slowed-reverb/.gitignore`

One transient file, `packages/crunchy-presence/scripts/planted-guard-fixture.mjs`, was written and deleted inside a single command as the red proof; it is not in the commit and `git status --porcelain` is clean outside the lead's `.stack/` files.

**Outside `Owns`, not touched, but they still name Playwright** — `Out` cannot be read as fully closed until these are decided:

- `README.md:46` — "no Playwright dependency is installed here" (root README, not in `Owns`; the sentence is currently *true*, but it is still a mention).
- `packages/audio-normalizer/qa/feed-transition-qa.cjs:6` — comment "no browser, no Chromium, no Playwright, no audio device".
- `packages/audio-normalizer/qa/loudness-verify.cjs:6` and `:3640` — same comment and the JSON `safety` string.
- `packages/audio-normalizer/qa/loudness-verify.json:4` — the committed output of `:3640`.

Every one of those is prose asserting the absence of Playwright, not an import; the import ban and the dependency ban are fully green. Tell me to widen the seam and I will scrub them in one pass.

## Lesson

A "no X in the tree" guard that exempts paths is only as strong as its exemption list, and the exemption here hid the one real importer for a whole release while the guard printed PASS. Two things made it trustworthy: the guard's own text is assembled from pieces so it can be scanned by its own rule, and `--prove-red` now plants the violation at the path the skip used to cover, so re-adding a skip makes the provered step red instead of silently green. If you extend the ban, extend that fixture — the fixture is the check, the incident list is not.
