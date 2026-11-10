# wdr-docs-truth: report

## Outcome

Two sentences in `packages/web-discord-rpc/docs/ARCHITECTURE.md` now match shipped code. The eligibility paragraph states the per-host rule (`RULES.eligibility.requiresMediaId` is `["youtube"]`: YouTube needs the watch media id, YouTube Music is eligible on any `https://music.youtube.com/...` page once a title resolves, with `mediaId` null). The per-source merge bullet states the real push rule (`SENDABLE_BRIDGE_STATES` = connected/connecting/waiting; `idle` and `error` silent; each `status connected` resets every limiter and replays). No other sentence, code, test, README or script was touched.

## Evidence

Head handed back: `76838c7`.

The named check at that head:

```text
$ node --test packages/web-discord-rpc/test/docs.test.mjs && node scripts/verify-integration.mjs
✔ desktop-first setup names the desktop pipe before arRPC (0.7308ms)
✔ every doc calls the extension YouTube Presence and defaults to the desktop IPC transport (0.3022ms)
✔ docs promise YouTube Music first and one toggle per site (0.1536ms)
✔ arRPC/Vencord fallback names the client_id query and the mock user (0.1065ms)
✔ two stacked activities keep their types and name overrides (0.1965ms)
✔ app-name override names the built-in id and the 17-20 digit rule (0.1433ms)
✔ privacy says local-only and no page modification (0.1448ms)
✔ troubleshooting maps absence to waiting, not error (0.1515ms)
✔ crunchy transport rule is amended: IPC primary, arRPC fallback, no third transport (0.5091ms)
✔ changelogs speak to the reader with dates (0.2397ms)
✔ install doc quotes the real host name and extension id (0.0934ms)
ℹ tests 11
ℹ pass 11
ℹ fail 0
scan: 200 tracked source files read from 257 on disk (6 .html); 0 unreadable
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

The named check cannot go red on these two sentences: `docs.test.mjs` has no assertion over the eligibility paragraph or the push bullet, and `verify-integration.mjs` has no doc predicate (`grep -n "ARCHITECTURE\|eligib\|requiresMediaId\|SENDABLE\|connected" scripts/verify-integration.mjs` → no matches). So the seam was proved with a scratch predicate in `C:\Users\nathan\AppData\Local\Temp\opencode\wdr-docs-red.mjs` — five must-match phrases, two must-not-match stale phrases — run against the HEAD copy of the file and against the working tree:

```text
=== RED (HEAD copy) ===
FAIL  eligibility names the per-host media-id rule
FAIL  eligibility says Music needs only a resolved title
FAIL  eligibility says the music mediaId is null
FAIL  push names connecting and waiting
FAIL  push says connected resets the limiter
FAIL  stale: universal media-id requirement
FAIL  stale: connected-only send
exit=1
=== GREEN (working tree) ===
ok    eligibility names the per-host media-id rule
ok    eligibility says Music needs only a resolved title
ok    eligibility says the music mediaId is null
ok    push names connecting and waiting
ok    push says connected resets the limiter
ok    stale: universal media-id requirement
ok    stale: connected-only send
exit=0
```

The shipped rules the prose now repeats, read directly from the code:

```text
extract-youtube.js:33    requiresMediaId: ["youtube"]
extract-youtube.js:466   if (requiresMediaId && !mediaId) return null;
extract-youtube.js:494   if (!requiresMediaId && !title) return null;
extract-youtube.js:506   mediaId: mediaId,          // null when the URL carried none

background.js:65-69      const SENDABLE_BRIDGE_STATES = new Set([CONNECTED, CONNECTING, WAITING]);
background.js:633        if (!port || !SENDABLE_BRIDGE_STATES.has(bridgeState)) return;
background.js:451-452    for (const limiter of limiters.values()) limiter.reset();
                         for (const source of SOURCES) push(source, true);
```

Diff: 1 file, 2 insertions, 2 deletions (`git diff --stat` before commit).

## Unverified

- Nothing about the two edited sentences is unverified; both were read out of the shipped code above.
- Did not run the browser e2e scripts (`scripts/e2e-*.mjs`) or the native host selftest: this seam changes prose only, and the brief's check does not include them.
- Did not verify the *other* places the same two facts appear. A third stale claim remains: `ARCHITECTURE.md` Limitations row "Unknown pages | A page with no media id reports nothing, so the activity clears rather than guessing" (line 167) is now false for YouTube Music. It is outside `Out` and the brief said to change only the two named sentences, so it was left alone and reported here instead.

## Scope

- `packages/web-discord-rpc/docs/ARCHITECTURE.md` — inside `Owns`; the only file changed.
- No test, README, script, `extract-youtube.js` or `background.js` change.
- Scratch helper at `C:\Users\nathan\AppData\Local\Temp\opencode\wdr-docs-red.mjs` is outside the repo and not committed.
- Committed as `76838c7`, one commit, message plain, `.stack/` files left uncommitted as they were.

## Lesson

The docs contract in `test/docs.test.mjs` pins facts about transports, ids and toggles but not about eligibility or bridge send states, so a prose regression in those two rules ships green — the brief's check is a regression guard, not proof, and an employee must build the red/green pair itself (a two-line scratch predicate over the HEAD copy versus the working tree costs one run). Also worth knowing before touching this file: `ARCHITECTURE.md` repeats some facts more than once (the eligibility rule appears again as the "Unknown pages" Limitations row), so a fix that stops at the named sentence leaves a contradiction behind; grep the whole doc for the fact before declaring the paragraph true.
