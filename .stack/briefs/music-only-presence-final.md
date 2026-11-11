# Seam music-only-presence-final: Music-only presence end to end

**Owner of this seam:** one `employee` employee. **Written by:** the lead. **State:** briefed.

## Why now

The first scope was under-bounded: the package check covers native transport and e2e fixtures that still encode two sources. Preserve partial work in a stash and re-cut one coherent Music-only seam covering every required caller and test.

## Out

Ship YouTube Music only to Discord desktop over IPC, with one accessible persistent on/off control, retained state across page refreshes and Discord restarts, duplicate metadata collapsed, and product-facing docs/tests aligned; no YouTube video activity or alternate user-facing configuration remains. Discord member-list status must show artist while the expanded header says Listening to YouTube Music: investigate status_display_type and test its outgoing IPC payload; do not claim actual Discord rendering without observing it. Investigate reported missing elapsed/end time end-to-end from YouTube Music playback extraction through IPC timestamps, write regression tests that reproduce the real failure, and fix without inventing duration. Increment version once from 1.0.3 to 1.0.4 across manifest, package, lockfile, README and changelog.

## Check

```text
npm test --workspace=packages/web-discord-rpc
```

It passes only when the command exits 0 and the output shows the new behaviour.
A check that cannot go red is not a check.

## Owns

- `packages/web-discord-rpc/config.js`
- `packages/web-discord-rpc/activity.js`
- `packages/web-discord-rpc/background.js`
- `packages/web-discord-rpc/content.js`
- `packages/web-discord-rpc/extract-youtube.js`
- `packages/web-discord-rpc/manifest.json`
- `packages/web-discord-rpc/popup.html`
- `packages/web-discord-rpc/popup.css`
- `packages/web-discord-rpc/popup.js`
- `packages/web-discord-rpc/options.html`
- `packages/web-discord-rpc/options.css`
- `packages/web-discord-rpc/options.js`
- `packages/web-discord-rpc/package.json`
- `packages/web-discord-rpc/README.md`
- `packages/web-discord-rpc/CHANGELOG.md`
- `packages/web-discord-rpc/test/extension/**`
- `packages/web-discord-rpc/test/extension/helpers/fake-page.mjs`
- `packages/web-discord-rpc/test/docs.test.mjs`
- `packages/web-discord-rpc/test/native/host.test.mjs`
- `packages/web-discord-rpc/test/native/transport.test.mjs`
- `packages/web-discord-rpc/test/integration/**`
- `packages/web-discord-rpc/scripts/e2e-arrpc.mjs`
- `packages/web-discord-rpc/scripts/e2e-ipc.mjs`
- `packages/web-discord-rpc/docs/ARCHITECTURE.md`
- `packages/web-discord-rpc/docs/RESEARCH.md`
- `packages/web-discord-rpc/docs/INSTALL.md`
- `README.md`
- `package-lock.json`

## Files (exact, exclusive)

- `packages/web-discord-rpc/config.js`
- `packages/web-discord-rpc/activity.js`
- `packages/web-discord-rpc/background.js`
- `packages/web-discord-rpc/content.js`
- `packages/web-discord-rpc/extract-youtube.js`
- `packages/web-discord-rpc/manifest.json`
- `packages/web-discord-rpc/popup.html`
- `packages/web-discord-rpc/popup.css`
- `packages/web-discord-rpc/popup.js`
- `packages/web-discord-rpc/options.html`
- `packages/web-discord-rpc/options.css`
- `packages/web-discord-rpc/options.js`
- `packages/web-discord-rpc/package.json`
- `packages/web-discord-rpc/README.md`
- `packages/web-discord-rpc/CHANGELOG.md`
- `packages/web-discord-rpc/test/extension/ui.test.mjs`
- `packages/web-discord-rpc/test/extension/manifest.test.mjs`
- `packages/web-discord-rpc/test/extension/extract-youtube.test.mjs`
- `packages/web-discord-rpc/test/extension/content.test.mjs`
- `packages/web-discord-rpc/test/extension/helpers/fake-page.mjs`
- `packages/web-discord-rpc/test/extension/config.test.mjs`
- `packages/web-discord-rpc/test/extension/bridge-status.test.mjs`
- `packages/web-discord-rpc/test/extension/background.test.mjs`
- `packages/web-discord-rpc/test/extension/activity.test.mjs`
- `packages/web-discord-rpc/test/docs.test.mjs`
- `packages/web-discord-rpc/test/native/host.test.mjs`
- `packages/web-discord-rpc/test/native/transport.test.mjs`
- `packages/web-discord-rpc/test/integration/arrpc-e2e.test.mjs`
- `packages/web-discord-rpc/test/integration/ipc-e2e.test.mjs`
- `packages/web-discord-rpc/scripts/e2e-arrpc.mjs`
- `packages/web-discord-rpc/scripts/e2e-ipc.mjs`
- `packages/web-discord-rpc/docs/ARCHITECTURE.md`
- `packages/web-discord-rpc/docs/RESEARCH.md`
- `packages/web-discord-rpc/docs/INSTALL.md`
- `README.md`
- `package-lock.json`

No other seam may touch these. No other file is yours.

## Do not touch

- `packages/web-discord-rpc/native/**`
- `packages/web-discord-rpc/scripts/install-host.mjs`
- `packages/web-discord-rpc/scripts/uninstall-host.mjs`
- `packages/web-discord-rpc/package-lock.json`

## Read first

- `Q:/PROJECTS/PERSONAL/oc-collections/packages/oc-stacked/roles/employee.md`
- `Q:/PROJECTS/PERSONAL/oc-collections/packages/oc-stacked/skills/stacked-employee/SKILL.md`

## Tier

expert. Design judgement is the work. The lead keeps the design and hands you the decision, not the discovery.

The archetype names the seat, and `routing.json` pins its model at install. The tier says how much judgement the brief expects, not which model runs: an expert seam is designed by the lead before it reaches you.

## Rules that bind this seam

1. Name the unknown before writing code. If this brief is wrong, say so in one message and stop; do not reinterpret it.
2. The smallest change that closes Out. No speculative flexibility.
3. Every changed line traces to Out. Orphans you created, you delete. Pre-existing dead code, you report.
4. Paste the command and its output in the report. A claim without a command is `Unverified`.
5. Never merge, never push a shared branch, never dispatch another agent. Two failures of the same command: stop and report.

## Report

Write `.stack/reports/music-only-presence-final.md` with these five headings, all mandatory:

```text
## Outcome     what shipped, two or three sentences
## Evidence    the command and the real output at the head you hand back
## Unverified  every claim you did not check, and why; "none" is a claim
## Scope       paths touched, each inside Owns, or why not
## Lesson      one paragraph the next employee should know
```

Then return one paragraph: outcome, commits, check result, concerns.
