# wdr-docs-guard: report

## Outcome

`packages/web-discord-rpc/docs/ARCHITECTURE.md` line 168 (Limits → Unknown pages) now states the per-host rule: a YouTube page with no media id reports nothing, a music page reports only once a title resolves, otherwise the activity clears rather than guessing. `test/docs.test.mjs` gained one test, "unknown pages name the per-host rule and the sendable bridge states", which asserts two exact prose substrings as present and two stale sentences as absent, so all three landed doc corrections (`1193457`, `76838c7`) regress into a red suite instead of an audit. Both files committed as `0b4e53b`; nothing outside Owns was touched.

## Evidence

Head handed back: `0b4e53b`.

Red first, on the unedited doc, test added before the doc edit:

```text
$ node --test packages/web-discord-rpc/test/docs.test.mjs
✖ unknown pages name the per-host rule and the sendable bridge states (0.413ms)
✔ install doc quotes the real host name and extension id (0.0746ms)
ℹ tests 12
ℹ pass 11
ℹ fail 1

✖ failing tests:
test at packages\web-discord-rpc\test\docs.test.mjs:118:1
✖ unknown pages name the per-host rule and the sendable bridge states (0.413ms)
  AssertionError [ERR_ASSERTION]: ARCHITECTURE no longer claims an unknown page reports nothing
      at TestContext.<anonymous> (file:///Q:/PROJECTS/PERSONAL/my-chromium-extensions/packages/web-discord-rpc/test/docs.test.mjs:123:10)
```

The red reason is the doc line, not the test harness: the failing message is the assertion text of the stale-sentence guard.

The positive assertions also bind — controlled mutation of `docs/ARCHITECTURE.md` (replacing the `SENDABLE_BRIDGE_STATES` phrase with the old "only when the bridge is `connected`" wording), then restored from the in-memory original in the same command:

```text
ℹ fail 1
AssertionError [ERR_ASSERTION]: ARCHITECTURE names the sendable bridge states
--- restored ---
 packages/web-discord-rpc/docs/ARCHITECTURE.md | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

The named check at the handed-back head:

```text
$ node --test packages/web-discord-rpc/test/docs.test.mjs && node scripts/verify-integration.mjs
✔ desktop-first setup names the desktop pipe before arRPC (0.7469ms)
✔ every doc calls the extension YouTube Presence and defaults to the desktop IPC transport (0.2953ms)
✔ docs promise YouTube Music first and one toggle per site (0.1505ms)
✔ arRPC/Vencord fallback names the client_id query and the mock user (0.0978ms)
✔ two stacked activities keep their types and name overrides (0.1961ms)
✔ app-name override names the built-in id and the 17-20 digit rule (0.1392ms)
✔ privacy says local-only and no page modification (0.1356ms)
✔ troubleshooting maps absence to waiting, not error (0.1472ms)
✔ crunchy transport rule is amended: IPC primary, arRPC fallback, no third transport (0.9193ms)
✔ changelogs speak to the reader with dates (0.2446ms)
✔ unknown pages name the per-host rule and the sendable bridge states (0.1001ms)
✔ install doc quotes the real host name and extension id (0.0722ms)
ℹ tests 12
ℹ pass 12
ℹ fail 0
scan: 200 tracked source files read from 257 on disk (6 .html); 0 unreadable
PASS: workspaces cover packages/*
...
PASS: no source or CI step imports Playwright

verify-integration: 16/16 wiring points hold
EXIT=0
```

The replacement sentence is true against the code, not just against the doc (read-only grep, the two files themselves untouched):

```text
$ Select-String extract-youtube.js background.js -Pattern 'requiresMediaId|SENDABLE_BRIDGE_STATES'
extract-youtube.js:33: requiresMediaId: ["youtube"]
extract-youtube.js:464: var requiresMediaId = RULES.eligibility.requiresMediaId.indexOf(source) !== -1;
extract-youtube.js:466: if (requiresMediaId && !mediaId) return null;     // YouTube: no media id → nothing
extract-youtube.js:494: if (!requiresMediaId && !title) return null;      // Music: no title → nothing, title → reports
background.js:65: const SENDABLE_BRIDGE_STATES = new Set([
background.js:66-68: BRIDGE.CONNECTED, BRIDGE.CONNECTING, BRIDGE.WAITING
```

## Unverified

- The brief predicted *two* red assertions ("the two absent assertions are the red reasons"). Only one was red: "only when the bridge is `connected`" was already gone from the doc, corrected by `76838c7` (`wdr-docs-truth`). That assertion is kept, and the mutation run above proves it still bites.
- I did not exercise the claims in a running Chrome/YouTube Music tab; I confirmed them by reading `extract-youtube.js` and `background.js` at `0b4e53b`. The guard is a doc-drift tripwire, not an end-to-end test.
- I did not run the wider package test suite (`test/extension/**`) or the e2e scripts; the brief's Check names only `docs.test.mjs` and `verify-integration.mjs`, and both exit 0.

## Scope

- `packages/web-discord-rpc/docs/ARCHITECTURE.md` — one line, the Unknown pages row (in Owns).
- `packages/web-discord-rpc/test/docs.test.mjs` — one new test, 11 lines (in Owns).

Nothing else staged or modified: `git status --porcelain -- packages/web-discord-rpc` is empty after the commit. The untracked `.stack/` briefs and reports and the modified `.stack/ledger.md` were present before this seam and were left alone.

## Lesson

The test file already loads `arch = read("docs/ARCHITECTURE.md")` through the `readFileSync` helper at module scope, so the new test reuses that constant instead of opening the file a second time — same path style, one less I/O, and it stays green under `node --test` because the read happens once at import. When a brief predicts which assertions will be red, check the current doc before trusting the count: two sibling seams had already landed the eligibility and sendable-state wording, so the honest red-then-green was one assertion, not two, and the mutation run was the cheapest way to prove the second guard still has teeth. Keep every assertion on a single line of prose with the exact substring; the moment one spans a paragraph, a harmless rewrap turns the guard into noise.
