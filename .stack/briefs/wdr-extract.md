# Seam wdr-extract: YouTube and YouTube Music extractor plus content reporter

**Owner of this seam:** one `frontend` employee. **Written by:** the lead. **State:** briefed.

## Why now

The background activity builder is only as good as the state this reporter emits; it is the eyes of the extension.

## Out

A never-throwing classic content script reads title, channel or artist, album, artwork, URL, media id and playback state from YouTube and YouTube Music, and reports it to the background on media, SPA-navigation, visibility and pagehide events.

## Check

```text
node --test packages/web-discord-rpc/test/extension/extract-youtube.test.mjs packages/web-discord-rpc/test/extension/content.test.mjs
```

It passes only when the command exits 0 and the output shows the new behaviour.
A check that cannot go red is not a check.

## Owns

- `packages/web-discord-rpc/extract-youtube.js`
- `packages/web-discord-rpc/content.js`
- `packages/web-discord-rpc/test/extension/extract-youtube.test.mjs`
- `packages/web-discord-rpc/test/extension/content.test.mjs`
- `packages/web-discord-rpc/test/extension/helpers/**`

## Files (exact, exclusive)

- `packages/web-discord-rpc/extract-youtube.js`
- `packages/web-discord-rpc/content.js`
- `packages/web-discord-rpc/test/extension/extract-youtube.test.mjs`
- `packages/web-discord-rpc/test/extension/content.test.mjs`
- `packages/web-discord-rpc/test/extension/helpers/fake-page.mjs`

No other seam may touch these. No other file is yours.

## Do not touch

- `packages/web-discord-rpc/manifest.json`
- `packages/web-discord-rpc/config.js`
- `packages/web-discord-rpc/background.js`
- `packages/web-discord-rpc/activity.js`
- `packages/web-discord-rpc/native/**`
- `packages/web-discord-rpc/popup.*`
- `packages/web-discord-rpc/options.*`
- `packages/crunchy-presence/**`

## Read first

- `.stack/contracts.md`
- `packages/crunchy-presence/extract.js`
- `packages/crunchy-presence/content.js`
- `packages/crunchy-presence/test/extension/helpers/fake-dom.mjs`

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

Write `.stack/reports/wdr-extract.md` with these five headings, all mandatory:

```text
## Outcome     what shipped, two or three sentences
## Evidence    the command and the real output at the head you hand back
## Unverified  every claim you did not check, and why; "none" is a claim
## Scope       paths touched, each inside Owns, or why not
## Lesson      one paragraph the next employee should know
```

Then return one paragraph: outcome, commits, check result, concerns.
