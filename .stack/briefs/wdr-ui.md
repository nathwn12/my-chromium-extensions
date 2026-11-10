# Seam wdr-ui: web-discord-rpc popup and options

**Owner of this seam:** one `frontend` employee. **Written by:** the lead. **State:** briefed.

## Why now

The manifest already points at popup/options; without them the unpacked extension cannot load cleanly.

## Out

Popup and options load from the manifest, render bridge and both source activities, toggle presence, choose auto|ipc|arrpc, save an application ID, show install commands, and load no remote code.

## Check

```text
node --test packages/web-discord-rpc/test/extension/ui.test.mjs
```

It passes only when the command exits 0 and the output shows the new behaviour.
A check that cannot go red is not a check.

## Owns

- `packages/web-discord-rpc/popup.*`
- `packages/web-discord-rpc/options.*`
- `packages/web-discord-rpc/test/extension/ui.test.mjs`
- `packages/web-discord-rpc/test/ui/**`

## Files (exact, exclusive)

- `packages/web-discord-rpc/popup.html`
- `packages/web-discord-rpc/popup.css`
- `packages/web-discord-rpc/popup.js`
- `packages/web-discord-rpc/options.html`
- `packages/web-discord-rpc/options.css`
- `packages/web-discord-rpc/options.js`
- `packages/web-discord-rpc/test/extension/ui.test.mjs`
- `packages/web-discord-rpc/test/ui/helpers/fake-ui.mjs`

No other seam may touch these. No other file is yours.

## Do not touch

- Anything outside Owns and Files.

## Read first

- The files in Owns, and nothing else until they are understood.

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

Write `.stack/reports/wdr-ui.md` with these five headings, all mandatory:

```text
## Outcome     what shipped, two or three sentences
## Evidence    the command and the real output at the head you hand back
## Unverified  every claim you did not check, and why; "none" is a claim
## Scope       paths touched, each inside Owns, or why not
## Lesson      one paragraph the next employee should know
```

Then return one paragraph: outcome, commits, check result, concerns.
