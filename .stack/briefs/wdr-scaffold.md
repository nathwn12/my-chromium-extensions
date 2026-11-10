# Seam wdr-scaffold: web-discord-rpc package scaffold and native-host installer

**Owner of this seam:** one `devops` employee. **Written by:** the lead. **State:** briefed.

## Why now

Every other web-discord-rpc seam imports this config and registers a native host against this manifest key.

## Out

packages/web-discord-rpc exists with a stable-key MV3 manifest, shared config module, icon set, and install/verify/uninstall native-host scripts, all covered by unit tests.

## Check

```text
node --test packages/web-discord-rpc/test/extension/config.test.mjs packages/web-discord-rpc/test/extension/manifest.test.mjs packages/web-discord-rpc/test/scripts/install-host.test.mjs packages/web-discord-rpc/test/scripts/extension-key.test.mjs
```

It passes only when the command exits 0 and the output shows the new behaviour.
A check that cannot go red is not a check.

## Owns

- `packages/web-discord-rpc/manifest.json`
- `packages/web-discord-rpc/package.json`
- `packages/web-discord-rpc/config.js`
- `packages/web-discord-rpc/scripts/**`
- `packages/web-discord-rpc/icons/**`
- `packages/web-discord-rpc/test/extension/config.test.mjs`
- `packages/web-discord-rpc/test/extension/manifest.test.mjs`
- `packages/web-discord-rpc/test/scripts/**`

## Files (exact, exclusive)

- `packages/web-discord-rpc/manifest.json`
- `packages/web-discord-rpc/package.json`
- `packages/web-discord-rpc/config.js`
- `packages/web-discord-rpc/scripts/install-host.mjs`
- `packages/web-discord-rpc/scripts/uninstall-host.mjs`
- `packages/web-discord-rpc/scripts/extension-key.mjs`
- `packages/web-discord-rpc/icons/icon16.png`
- `packages/web-discord-rpc/icons/icon24.png`
- `packages/web-discord-rpc/icons/icon32.png`
- `packages/web-discord-rpc/icons/icon48.png`
- `packages/web-discord-rpc/icons/icon128.png`
- `packages/web-discord-rpc/test/extension/config.test.mjs`
- `packages/web-discord-rpc/test/extension/manifest.test.mjs`
- `packages/web-discord-rpc/test/scripts/install-host.test.mjs`
- `packages/web-discord-rpc/test/scripts/extension-key.test.mjs`

No other seam may touch these. No other file is yours.

## Do not touch

- `packages/web-discord-rpc/native/**`
- `packages/web-discord-rpc/background.js`
- `packages/web-discord-rpc/activity.js`
- `packages/web-discord-rpc/content.js`
- `packages/web-discord-rpc/extract-youtube.js`
- `packages/web-discord-rpc/popup.*`
- `packages/web-discord-rpc/options.*`
- `packages/web-discord-rpc/bridge-status.js`
- `packages/crunchy-presence/**`

## Read first

- `.stack/contracts.md`
- `packages/crunchy-presence/scripts/install-host.mjs`
- `packages/crunchy-presence/scripts/extension-key.mjs`
- `packages/crunchy-presence/manifest.json`
- `packages/crunchy-presence/config.js`

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

Write `.stack/reports/wdr-scaffold.md` with these five headings, all mandatory:

```text
## Outcome     what shipped, two or three sentences
## Evidence    the command and the real output at the head you hand back
## Unverified  every claim you did not check, and why; "none" is a claim
## Scope       paths touched, each inside Owns, or why not
## Lesson      one paragraph the next employee should know
```

Then return one paragraph: outcome, commits, check result, concerns.
