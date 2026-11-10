# Seam wdr-surfaces-artist: popup and options show the Music artist

**Owner of this seam:** one `employee` employee. **Written by:** the lead. **State:** briefed.

## Why now

Promoting the artist to activity.name left the popup/options detail reading only activity.state, which now carries the album, so the extension's own surfaces lost the artist.

## Out

The popup and options rows for a playing Music track show the artist and the album (artist — album), not the album alone, while YouTube rows keep showing just the channel.

## Check

```text
node --test packages/web-discord-rpc/test/extension/ui.test.mjs && npm test
```

It passes only when the command exits 0 and the output shows the new behaviour.
A check that cannot go red is not a check.

## Owns

- `packages/web-discord-rpc/popup.js`
- `packages/web-discord-rpc/options.js`
- `packages/web-discord-rpc/test/extension/ui.test.mjs`

## Files (exact, exclusive)

- `packages/web-discord-rpc/popup.js`
- `packages/web-discord-rpc/options.js`
- `packages/web-discord-rpc/test/extension/ui.test.mjs`

No other seam may touch these. No other file is yours.

## Do not touch

- `packages/web-discord-rpc/activity.js`
- `packages/web-discord-rpc/background.js`
- `packages/web-discord-rpc/manifest.json`
- `packages/web-discord-rpc/package.json`
- `README.md`
- `package-lock.json`
- `scripts/**`

## Read first

- `packages/web-discord-rpc/popup.js`
- `packages/web-discord-rpc/options.js`
- `packages/web-discord-rpc/test/extension/ui.test.mjs`
- `packages/web-discord-rpc/activity.js`

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

Write `.stack/reports/wdr-surfaces-artist.md` with these five headings, all mandatory:

```text
## Outcome     what shipped, two or three sentences
## Evidence    the command and the real output at the head you hand back
## Unverified  every claim you did not check, and why; "none" is a claim
## Scope       paths touched, each inside Owns, or why not
## Lesson      one paragraph the next employee should know
```

Then return one paragraph: outcome, commits, check result, concerns.

## Known gap (lead decision, not a reinterpretation)

`activity.js` (1.0.2) now sends the track artist in `activity.name` on Music, with the album in `activity.state`. `popup.js` and `options.js` each own a `describeActivity(activity)` that returns `{title: details, detail: state}`; on Music the detail is now only the album, so the artist vanished from the extension's own rows.

Required shape in BOTH `describeActivity` copies (keep them textually identical):

1. `title` stays `activity.details` (or the existing fallbacks).
2. `detail` becomes the artist plus the state when the activity name is an artist: a name that is a non-empty string and is NOT `YouTube` / `YouTube Music` (the two static source labels) and differs from the state. Join with the same em dash the activity uses: `artist — album`; if state is empty, just `artist`; if the name is a source label or equals the state, keep today's `detail = state`.
3. Nothing else in either file changes: no copy, no ids, no layout, no branch for disabled sites.

Red first in `test/extension/ui.test.mjs`: add a status fixture whose `youtube-music` activity is `{ name: "An Artist", type: 2, details: "A Song", state: "An Album" }` (model it on the existing `CONNECTED` fixture at the top of the file) and assert the popup music row reads `A Song` / `An Artist — An Album` while the YouTube row still reads its channel only. Watch the detail assertion fail before editing the two surfaces; then make it pass. If the existing rendered assertions already cover the YouTube case, leave them untouched.

Commit exactly the three files with a plain message, and report Outcome / Evidence (red then green) / Unverified / Scope / Lesson. Do not bump the version; a separate release seam does that once both follow-ups land.
