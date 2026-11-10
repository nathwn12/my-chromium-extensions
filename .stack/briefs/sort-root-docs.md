# Seam sort-root-docs: root README truth, versions and installer labels

**Owner of this seam:** one `employee` employee. **Written by:** the lead. **State:** briefed.

## Why now

The root README says three extensions, has stale crunchy/slowed versions, and calls Slowed Reverb a YouTube plugin when it is YouTube Music only.

## Out

Root README says four extensions, lists each package at its manifest version with the correct scope and the YouTube Presence name, the installer/host descriptive labels say YouTube Presence, and the verifier catches count or version drift.

## Check

```text
node scripts/verify-integration.mjs && node --test packages/web-discord-rpc/test/native/host.test.mjs packages/web-discord-rpc/test/scripts/install-host.test.mjs
```

It passes only when the command exits 0 and the output shows the new behaviour.
A check that cannot go red is not a check.

## Owns

- `README.md`
- `scripts/verify-integration.mjs`
- `packages/web-discord-rpc/scripts/install-host.mjs`
- `packages/web-discord-rpc/test/scripts/install-host.test.mjs`
- `packages/web-discord-rpc/native/host.mjs`

## Files (exact, exclusive)

- `README.md`
- `scripts/verify-integration.mjs`
- `packages/web-discord-rpc/scripts/install-host.mjs`
- `packages/web-discord-rpc/test/scripts/install-host.test.mjs`
- `packages/web-discord-rpc/native/host.mjs`

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

Write `.stack/reports/sort-root-docs.md` with these five headings, all mandatory:

```text
## Outcome     what shipped, two or three sentences
## Evidence    the command and the real output at the head you hand back
## Unverified  every claim you did not check, and why; "none" is a claim
## Scope       paths touched, each inside Owns, or why not
## Lesson      one paragraph the next employee should know
```

Then return one paragraph: outcome, commits, check result, concerns.
