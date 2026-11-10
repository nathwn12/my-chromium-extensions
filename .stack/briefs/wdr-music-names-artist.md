# Seam wdr-music-names-artist: Music card and status name the artist

**Owner of this seam:** one `employee` employee. **Written by:** the lead. **State:** briefed.

## Why now

Owner's live card is correct except the status line and header read YouTube Music; Discord renders those from activity.name, which is currently the static source label.

## Out

After reload and play, the Discord status line and card header read the track's artist (e.g. 24KGoldn) instead of YouTube Music, the track stays in details, the album stays in state, and the package reads 1.0.2 everywhere.

## Check

```text
npm test && node scripts/verify-integration.mjs && node packages/web-discord-rpc/scripts/e2e-ipc.mjs
```

It passes only when the command exits 0 and the output shows the new behaviour.
A check that cannot go red is not a check.

## Owns

- `packages/web-discord-rpc/activity.js`
- `packages/web-discord-rpc/README.md`
- `packages/web-discord-rpc/docs/ARCHITECTURE.md`
- `packages/web-discord-rpc/manifest.json`
- `packages/web-discord-rpc/package.json`
- `packages/web-discord-rpc/CHANGELOG.md`
- `README.md`

## Files (exact, exclusive)

- `packages/web-discord-rpc/activity.js`
- `packages/web-discord-rpc/test/extension/activity.test.mjs`
- `packages/web-discord-rpc/test/extension/background.test.mjs`
- `packages/web-discord-rpc/README.md`
- `packages/web-discord-rpc/docs/ARCHITECTURE.md`
- `packages/web-discord-rpc/manifest.json`
- `packages/web-discord-rpc/package.json`
- `packages/web-discord-rpc/CHANGELOG.md`
- `README.md`

No other seam may touch these. No other file is yours.

## Do not touch

- `packages/web-discord-rpc/background.js`
- `packages/web-discord-rpc/bridge-status.js`
- `packages/web-discord-rpc/extract-youtube.js`
- `packages/web-discord-rpc/native/**`
- `packages/web-discord-rpc/content.js`
- `scripts/**`

## Read first

- `packages/web-discord-rpc/activity.js`
- `packages/web-discord-rpc/test/extension/activity.test.mjs`
- `packages/web-discord-rpc/README.md`

## Tier

standard. Multi-file coordination, ordinary care.

The archetype names the seat, and `routing.json` pins its model at install. The tier says how much judgement the brief expects, not which model runs: an expert seam is designed by the lead before it reaches you.

## Rules that bind this seam

1. Name the unknown before writing code. If this brief is wrong, say so in one message and stop; do not reinterpret it.
2. The smallest change that closes Out. No speculative flexibility.
3. Every changed line traces to Out. Orphans you created, you delete. Pre-existing dead code, you report.
4. Paste the command and its output in the report. A claim without a command is `Unverified`.
5. Never merge, never push a shared branch, never dispatch another agent. Two failures of the same command: stop and report.

## Report

Write `.stack/reports/wdr-music-names-artist.md` with these five headings, all mandatory:

```text
## Outcome     what shipped, two or three sentences
## Evidence    the command and the real output at the head you hand back
## Unverified  every claim you did not check, and why; "none" is a claim
## Scope       paths touched, each inside Owns, or why not
## Lesson      one paragraph the next employee should know
```

Then return one paragraph: outcome, commits, check result, concerns.

## Known gap (lead decision, proved by the owner's live card)

The owner's live card is otherwise correct: header "Listening to YouTube Music", details track title, state "artist - album", status line "YouTube Music". Discord renders the header and the status line from `activity.name`, which `buildActivity` sets to the static source label. Title and album are already on the card, so the artist is the only thing missing from the status.

Required shape in `activity.js` (`buildActivity`, YouTube Music only; YouTube is untouched):

1. When `channel` (already clamped, so 2-128 chars) is present: `name` is the artist, and `state` is the album when one resolved, else the `YouTube Music` label. Never repeat the artist on both lines.
2. When no artist resolved: keep today's exact shape (`name` is `YouTube Music`; `state` is `YouTube Music - album` with an album, else `YouTube Music`).
3. `details`, `assets` (including `large_text`), buttons, timestamps, and every YouTube-source behaviour are unchanged.

Red first: change `test/extension/activity.test.mjs` so the Music card expects the artist as `name` and the album as `state`, plus a no-artist case expecting today's shape, and watch both fail before touching `activity.js`. Then update the pinning assertions in `test/extension/background.test.mjs` (the music `name`/`state` checks near the WATCHING/LISTENING test and the persisted-activities test) the same way.

Docs truth (same seam, exact sentences): package `README.md` table row, the `state` description paragraph, and the card-title sentence; `ARCHITECTURE.md` `name`/`state` rows. Then version `1.0.2`: `manifest.json`, `package.json`, root `README.md` version cell (verify-integration pins it to the manifest), and a `## [1.0.2]` `CHANGELOG.md` entry in the existing style dated like the repo's other entries. Commit all nine files in one commit with a plain message; report Outcome / Evidence (red then green) / Unverified / Scope / Lesson. Unverified must name the live card after a real reload, which only the owner can observe.
