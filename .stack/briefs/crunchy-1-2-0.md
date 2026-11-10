# Seam crunchy-1-2-0: crunchy-presence 1.2.0 release and desktop-first web-deferred docs

**Owner of this seam:** one `employee` employee. **Written by:** the lead. **State:** briefed.

## Why now

The arRPC transport is a new minor feature; the current 1.1.0 manifest and empty Unreleased section would ship it under the wrong version.

## Out

Crunchy Presence is version 1.2.0 in manifest and package, the Unreleased arRPC bullet is promoted to a dated 1.2.0 entry, and its README/architecture say Discord IPC is primary with arRPC as an optional web fallback.

## Check

```text
node --test packages/crunchy-presence/test/ && node packages/crunchy-presence/native/host.mjs --selftest
```

It passes only when the command exits 0 and the output shows the new behaviour.
A check that cannot go red is not a check.

## Owns

- `packages/crunchy-presence/manifest.json`
- `packages/crunchy-presence/package.json`
- `packages/crunchy-presence/CHANGELOG.md`
- `packages/crunchy-presence/README.md`
- `packages/crunchy-presence/docs/ARCHITECTURE.md`

## Files (exact, exclusive)

- `packages/crunchy-presence/manifest.json`
- `packages/crunchy-presence/package.json`
- `packages/crunchy-presence/CHANGELOG.md`
- `packages/crunchy-presence/README.md`
- `packages/crunchy-presence/docs/ARCHITECTURE.md`

No other seam may touch these. No other file is yours.

## Do not touch

- `packages/web-discord-rpc/**`
- `README.md`
- `packages/audio-normalizer/**`
- `packages/slowed-reverb/**`
- `packages/crunchy-presence/native/**`
- `packages/crunchy-presence/background.js`
- `packages/crunchy-presence/scripts/**`

## Read first

- `packages/crunchy-presence/manifest.json`
- `packages/crunchy-presence/package.json`
- `packages/crunchy-presence/CHANGELOG.md`
- `packages/crunchy-presence/README.md`
- `packages/crunchy-presence/docs/ARCHITECTURE.md`
- `scripts/release.mjs`

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

Write `.stack/reports/crunchy-1-2-0.md` with these five headings, all mandatory:

```text
## Outcome     what shipped, two or three sentences
## Evidence    the command and the real output at the head you hand back
## Unverified  every claim you did not check, and why; "none" is a claim
## Scope       paths touched, each inside Owns, or why not
## Lesson      one paragraph the next employee should know
```

Then return one paragraph: outcome, commits, check result, concerns.
