# Seam remove-playwright: remove Playwright fully and keep Gladius as the only browser tester

**Owner of this seam:** one `employee` employee. **Written by:** the lead. **State:** briefed.

## Why now

Playwright is banned; leaving the dependency or a live-browser QA script lets it return and breaks a clean install.

## Out

No playwright, playwright-core or @playwright/test dependency, import, lockfile entry, node_modules package or Playwright-only QA script remains; a verifier guard fails if any returns, and the repo checks stay green.

## Check

```text
node scripts/verify-integration.mjs && npm test && npm run typecheck && npm run lint
```

It passes only when the command exits 0 and the output shows the new behaviour.
A check that cannot go red is not a check.

## Owns

- `package.json`
- `package-lock.json`
- `README.md`
- `scripts/verify-integration.mjs`
- `packages/audio-normalizer/package.json`
- `packages/slowed-reverb/package.json`
- `.github/workflows/ci.yml`
- `packages/audio-normalizer/qa/**`
- `packages/slowed-reverb/qa/**`

## Files (exact, exclusive)

- `package.json`
- `package-lock.json`
- `README.md`
- `scripts/verify-integration.mjs`
- `packages/audio-normalizer/package.json`
- `packages/slowed-reverb/package.json`
- `.github/workflows/ci.yml`
- `packages/audio-normalizer/qa/extension-qa.cjs`
- `packages/audio-normalizer/qa/generate-icons.cjs`
- `packages/audio-normalizer/qa/proof-live-persistence.cjs`
- `packages/audio-normalizer/qa/responsive-normalizer-qa.cjs`
- `packages/audio-normalizer/qa/worklet-equivalence-qa.cjs`
- `packages/slowed-reverb/qa/bughunt-bypass-mute.js`
- `packages/slowed-reverb/qa/bughunt-core.js`
- `packages/slowed-reverb/qa/bughunt-edge.js`
- `packages/slowed-reverb/qa/mute-test-quick.js`
- `packages/slowed-reverb/qa/mute-test.js`
- `packages/slowed-reverb/qa/playwright.config.js`
- `packages/slowed-reverb/qa/qa-mute-check.js`

No other seam may touch these. No other file is yours.

## Do not touch

- `packages/web-discord-rpc/**`
- `packages/crunchy-presence/**`
- `packages/audio-normalizer/background.js`
- `packages/audio-normalizer/page-hook.js`
- `packages/audio-normalizer/content-script.js`
- `packages/audio-normalizer/shared.js`
- `packages/audio-normalizer/tests/**`
- `packages/slowed-reverb/background.js`
- `packages/slowed-reverb/page-hook.js`
- `packages/slowed-reverb/content-script.js`
- `packages/slowed-reverb/shared.js`
- `packages/slowed-reverb/test/**`

## Read first

- `package.json`
- `package-lock.json`
- `README.md`
- `scripts/verify-integration.mjs`
- `packages/audio-normalizer/package.json`
- `packages/slowed-reverb/package.json`
- `.github/workflows/ci.yml`
- `packages/audio-normalizer/qa/feed-transition-qa.cjs`
- `packages/audio-normalizer/qa/program-boundary-qa.cjs`
- `packages/audio-normalizer/qa/loudness-verify.cjs`
- `packages/audio-normalizer/qa/worklet-silent-analysis.cjs`

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

Write `.stack/reports/remove-playwright.md` with these five headings, all mandatory:

```text
## Outcome     what shipped, two or three sentences
## Evidence    the command and the real output at the head you hand back
## Unverified  every claim you did not check, and why; "none" is a claim
## Scope       paths touched, each inside Owns, or why not
## Lesson      one paragraph the next employee should know
```

Then return one paragraph: outcome, commits, check result, concerns.
