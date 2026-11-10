# Report wdr-music-names-artist

## Outcome

YouTube Music now names the activity after the track artist, so Discord renders "Listening to <artist>" as the card header and "<artist>" on the status line; the track stays in `details` and the album moves to `state`, which stops the artist repeating. Without a resolved artist the previous shape is kept (`YouTube Music`, with `YouTube Music — album` or the label as state). YouTube is untouched. Docs corrected, package bumped to 1.0.2 across manifest, `package.json`, changelog and the root README table.

Two employees stalled at their step ceiling after the code and tests were green; the lead finished the docs, version, commit and this report under a logged `RULING`. Code authored by the employee; prose and version by the lead.

## Evidence

Red first, before `activity.js` changed (employee run): `npm test` exited 1 with exactly the intended pins red — `a YouTube Music track becomes a LISTENING card` (actual `name: 'YouTube Music', state: 'An Artist — An Album'`), `the album is optional and the artist names the card`, `one tab per source produces two simultaneous activities`, `the status payload carries both activities and is persisted for the popup`.

Green at `a0d858d`, re-run by the lead:

```text
npm test                → 103 + 196 + 12 + 228 pass, 0 fail, exit 0
node scripts/verify-integration.mjs → 16/16 wiring points hold, exit 0
node packages/web-discord-rpc/scripts/e2e-ipc.mjs → PASS 7/7, exit 0
```

## Unverified

The live card after a real extension reload was not observed; only the owner can see their Discord profile. Wire-level behaviour is covered by the activity tests and the e2e IPC run.

## Scope

Nine paths, each inside the brief's Files: `activity.js`, the two test files, package `README.md`, `docs/ARCHITECTURE.md`, `manifest.json`, `package.json`, `CHANGELOG.md`, root `README.md`. `.stack/ledger.md` and the brief/report are lead bookkeeping, outside the source commit.

## Lesson

When a card field is wrong, check which payload field the client renders it from before renaming anything: Discord draws both the header and the member-list status from `activity.name`, not from `details`. Also: a seam whose code is green is not done - docs, version and the report are the half that stalls at a step ceiling, so put them in the same brief only when the budget covers them, or split them out.
