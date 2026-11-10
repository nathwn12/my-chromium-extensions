# remove-playwright report

## Outcome

Removed `playwright-core` (root), `playwright` (audio-normalizer) and `@playwright/test` (slowed-reverb) from every manifest and the lockfile, regenerated `node_modules` without them, deleted twelve Playwright-only QA scripts, and added three verifier predicates that name any Playwright manifest dependency, lockfile entry, source import or CI step. The lockfile also gained the missing `packages/web-discord-rpc` workspace entry, which had made every CI `npm ci` red before this change.

## Evidence

At `061d738` (exit 0 for each):

```text
npm ci                         -> 87 packages, no playwright in node_modules
node scripts/verify-integration.mjs -> 13/13 predicates hold
node scripts/verify-integration.mjs --prove-red -> 13/13 can go red
npm test                       -> 103 + 196 + 12 + 202 pass, 0 fail
npm run typecheck              -> exit 0
npm run lint                   -> exit 0
```

The guard was watched red before cleanup: it named the three manifests, the lockfile and the twelve scripts; it was red again on a planted `require('playwright')` fixture, then green after removal.

## Unverified

- `packages/crunchy-presence/scripts/e2e-live.mjs` still imports `playwright-core`; the verifier currently skips that one path via `SCAN_SKIP`. That skip must be removed and the script deleted or rewritten.
- Stale docs naming deleted scripts remain in `packages/audio-normalizer/AGENTS.md`, `packages/slowed-reverb/AGENTS.md`, `packages/audio-normalizer/qa/worklet-silent-analysis.cjs`, `packages/slowed-reverb/eslint.config.mjs` and `packages/slowed-reverb/.gitignore`.
- No push was attempted.

## Scope

Root `package.json`, `package-lock.json`, `README.md`, `scripts/verify-integration.mjs`, `.github/workflows/ci.yml`, the two package manifests, and twelve QA deletions; all inside the brief's Owns. Nothing else was touched.

## Lesson

A dependency removal is not done when the package manager stops listing it; it is done when a search over tracked source and CI can no longer find it. The verifier had to grow from a dependency check into a source/CI scan before the claim was true.
