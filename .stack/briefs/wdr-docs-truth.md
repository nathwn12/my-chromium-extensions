# Seam wdr-docs-truth: architecture doc matches the shipped eligibility and push rules

**Owner of this seam:** one `employee` employee. **Written by:** the lead. **State:** briefed.

## Why now

Two sentences in ARCHITECTURE.md contradict shipped code: the eligibility paragraph still requires a watch media id for every host, and the push line still says only connected sends.

## Out

ARCHITECTURE.md states the real eligibility rule (a media id is required for YouTube only; YouTube Music is eligible on any host page once a title resolves) and the real push rule (activities are handed over while connecting or waiting, not only when connected), with no other sentence changed.

## Check

```text
node --test packages/web-discord-rpc/test/docs.test.mjs && node scripts/verify-integration.mjs
```

It passes only when the command exits 0 and the output shows the new behaviour.
A check that cannot go red is not a check.

## Owns

- `packages/web-discord-rpc/docs/ARCHITECTURE.md`

## Files (exact, exclusive)

- `packages/web-discord-rpc/docs/ARCHITECTURE.md`

No other seam may touch these. No other file is yours.

## Do not touch

- `packages/web-discord-rpc/extract-youtube.js`
- `packages/web-discord-rpc/background.js`
- `packages/web-discord-rpc/test/**`
- `README.md`
- `scripts/**`

## Read first

- `packages/web-discord-rpc/docs/ARCHITECTURE.md`
- `packages/web-discord-rpc/extract-youtube.js`
- `packages/web-discord-rpc/background.js`

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

Write `.stack/reports/wdr-docs-truth.md` with these five headings, all mandatory:

```text
## Outcome     what shipped, two or three sentences
## Evidence    the command and the real output at the head you hand back
## Unverified  every claim you did not check, and why; "none" is a claim
## Scope       paths touched, each inside Owns, or why not
## Lesson      one paragraph the next employee should know
```

Then return one paragraph: outcome, commits, check result, concerns.

## Known gap (two sentences contradict shipped code)

1. `docs/ARCHITECTURE.md` eligibility paragraph (around line 131) still says: "the URL must be `https:` on a YouTube host **and** carry a watch media id (`?v=` 11-char id, or `/shorts|embed|live|v/` path). Otherwise `read` returns `null`..." That is now false for YouTube Music after `1193457`: `RULES.eligibility.requiresMediaId` is `["youtube"]`, and a music page with no id is eligible when a title resolves from mediaSession, the player bar, JSON-LD, og:title or document title. Rewrite that paragraph to state both halves: YouTube requires the watch media id; YouTube Music is eligible on any `https://music.youtube.com/...` page once a title resolves (`mediaId` is then null).
2. The same file's per-source list says: "`push` sends through the source limiter only when the bridge is `connected`; otherwise the desired value waits and the next `status connected` replays it." That is false after `396eaa3`: `SENDABLE_BRIDGE_STATES` is `connected | connecting | waiting`, `idle` and `error` stay silent, and the connected status resets each limiter and replays every source. Rewrite that sentence to match.

Change only those two sentences (surrounding bullets stay). Do not edit code, tests, README or any other paragraph. `node --test packages/web-discord-rpc/test/docs.test.mjs` and `node scripts/verify-integration.mjs` must pass; commit the file with a plain message and write the report (Outcome / Evidence / Unverified / Scope / Lesson).