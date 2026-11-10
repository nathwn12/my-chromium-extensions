# Seam wdr-docs-guard: unknown-page doc claim is true and docs drift can go red

**Owner of this seam:** one `employee` employee. **Written by:** the lead. **State:** briefed.

## Why now

The unknown-page row still says a page with no media id reports nothing, false for YouTube Music, and the suite has no assertion that these three doc claims stay true.

## Out

ARCHITECTURE states unknown pages truthfully (a YouTube page with no media id reports nothing; a music page reports once a title resolves), and docs.test fails when any of the three corrected claims regresses, so the next drift is caught by the suite instead of an audit.

## Check

```text
node --test packages/web-discord-rpc/test/docs.test.mjs && node scripts/verify-integration.mjs
```

It passes only when the command exits 0 and the output shows the new behaviour.
A check that cannot go red is not a check.

## Owns

- `packages/web-discord-rpc/docs/ARCHITECTURE.md`
- `packages/web-discord-rpc/test/docs.test.mjs`

## Files (exact, exclusive)

- `packages/web-discord-rpc/docs/ARCHITECTURE.md`
- `packages/web-discord-rpc/test/docs.test.mjs`

No other seam may touch these. No other file is yours.

## Do not touch

- `packages/web-discord-rpc/extract-youtube.js`
- `packages/web-discord-rpc/background.js`
- `packages/web-discord-rpc/test/extension/**`
- `README.md`
- `scripts/**`

## Read first

- `packages/web-discord-rpc/docs/ARCHITECTURE.md`
- `packages/web-discord-rpc/test/docs.test.mjs`

## Tier

cheap. The plan text is complete; this is transcription plus a check.

The archetype names the seat, and `routing.json` pins its model at install. The tier says how much judgement the brief expects, not which model runs: an expert seam is designed by the lead before it reaches you.

## Rules that bind this seam

1. Name the unknown before writing code. If this brief is wrong, say so in one message and stop; do not reinterpret it.
2. The smallest change that closes Out. No speculative flexibility.
3. Every changed line traces to Out. Orphans you created, you delete. Pre-existing dead code, you report.
4. Paste the command and its output in the report. A claim without a command is `Unverified`.
5. Never merge, never push a shared branch, never dispatch another agent. Two failures of the same command: stop and report.

## Report

Write `.stack/reports/wdr-docs-guard.md` with these five headings, all mandatory:

```text
## Outcome     what shipped, two or three sentences
## Evidence    the command and the real output at the head you hand back
## Unverified  every claim you did not check, and why; "none" is a claim
## Scope       paths touched, each inside Owns, or why not
## Lesson      one paragraph the next employee should know
```

Then return one paragraph: outcome, commits, check result, concerns.

## Known gap (worker-reported, verified by the lead)

`docs/ARCHITECTURE.md` line 167 (the Limits table) still says: "Unknown pages | A page with no media id reports nothing, so the activity clears rather than guessing." False for YouTube Music since `1193457`: a music page with no media id reports once a title resolves. Required replacement, same row: a YouTube page with no media id reports nothing; a music page reports only once a title resolves; otherwise the activity clears rather than guessing.

Then close the guard gap the worker named: `test/docs.test.mjs` asserts nothing about these claims, so all three corrections can silently regress. Add one test that reads `docs/ARCHITECTURE.md` (the pattern already used in that file for README checks; use `readFileSync` with the same path style) and asserts, as exact substrings:

- present: "YouTube Music is eligible on any `https://music.youtube.com/...` page once a title resolves"
- present: "`connected`, `connecting` or `waiting` (`SENDABLE_BRIDGE_STATES`)"
- absent: "A page with no media id reports nothing"
- absent: "only when the bridge is `connected`"

Write the test first and watch it fail on the current doc (the two absent assertions are the red reasons), then edit the doc and watch it pass. Keep the assertions on one line of prose each, no fragile whole-paragraph matches beyond these substrings. Commit both files; report Outcome / Evidence (red then green) / Unverified / Scope / Lesson.