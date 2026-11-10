# Seam wdr-root: root workspace, CI and release wiring

**Owner of this seam:** one `devops` employee. **Written by:** the lead. **State:** briefed.

## Why now

A package outside the root gate, CI and release zip can rot unnoticed.

## Out

The root workspace, README, CI and release include web-discord-rpc, the package test script runs every test under test/, and one verifier proves each wiring point can go red.

## Check

```text
node scripts/verify-integration.mjs && node --test packages/web-discord-rpc/test/extension/config.test.mjs
```

It passes only when the command exits 0 and the output shows the new behaviour.
A check that cannot go red is not a check.

## Owns

- `package.json`
- `README.md`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `scripts/verify-integration.mjs`
- `packages/web-discord-rpc/package.json`

## Files (exact, exclusive)

- `package.json`
- `README.md`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `scripts/verify-integration.mjs`
- `packages/web-discord-rpc/package.json`

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

Write `.stack/reports/wdr-root.md` with these five headings, all mandatory:

```text
## Outcome     what shipped, two or three sentences
## Evidence    the command and the real output at the head you hand back
## Unverified  every claim you did not check, and why; "none" is a claim
## Scope       paths touched, each inside Owns, or why not
## Lesson      one paragraph the next employee should know
```

Then return one paragraph: outcome, commits, check result, concerns.
