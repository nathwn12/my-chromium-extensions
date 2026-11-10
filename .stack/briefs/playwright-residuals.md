# Seam playwright-residuals: remove the last Playwright import and stale Playwright docs

**Owner of this seam:** one `employee` employee. **Written by:** the lead. **State:** briefed.

## Why now

The no-Playwright claim is false while e2e-live imports it and AGENTS tells users to install browsers with Playwright.

## Out

No tracked source or CI imports Playwright; the crunchy e2e-live script is gone, the verifier scans every source path without a skip, and the AGENTS/QA/eslint/gitignore text no longer names Playwright or deleted QA scripts.

## Check

```text
node scripts/verify-integration.mjs && npm test && npm run lint && npm run typecheck
```

It passes only when the command exits 0 and the output shows the new behaviour.
A check that cannot go red is not a check.

## Owns

- `packages/crunchy-presence/scripts/e2e-live.mjs`
- `scripts/verify-integration.mjs`
- `packages/audio-normalizer/AGENTS.md`
- `packages/slowed-reverb/AGENTS.md`
- `packages/audio-normalizer/qa/worklet-silent-analysis.cjs`
- `packages/slowed-reverb/eslint.config.mjs`
- `packages/slowed-reverb/.gitignore`

## Files (exact, exclusive)

- `packages/crunchy-presence/scripts/e2e-live.mjs`
- `scripts/verify-integration.mjs`
- `packages/audio-normalizer/AGENTS.md`
- `packages/slowed-reverb/AGENTS.md`
- `packages/audio-normalizer/qa/worklet-silent-analysis.cjs`
- `packages/slowed-reverb/eslint.config.mjs`
- `packages/slowed-reverb/.gitignore`

No other seam may touch these. No other file is yours.

## Do not touch

- `packages/web-discord-rpc/**`
- `packages/crunchy-presence/native/**`
- `packages/crunchy-presence/background.js`
- `packages/audio-normalizer/background.js`
- `packages/audio-normalizer/tests/**`
- `packages/slowed-reverb/test/**`

## Read first

- `packages/crunchy-presence/scripts/e2e-live.mjs`
- `scripts/verify-integration.mjs`
- `packages/audio-normalizer/AGENTS.md`
- `packages/slowed-reverb/AGENTS.md`
- `packages/slowed-reverb/eslint.config.mjs`
- `packages/slowed-reverb/.gitignore`

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

Write `.stack/reports/playwright-residuals.md` with these five headings, all mandatory:

```text
## Outcome     what shipped, two or three sentences
## Evidence    the command and the real output at the head you hand back
## Unverified  every claim you did not check, and why; "none" is a claim
## Scope       paths touched, each inside Owns, or why not
## Lesson      one paragraph the next employee should know
```

Then return one paragraph: outcome, commits, check result, concerns.
