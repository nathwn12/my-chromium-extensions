# Seam native-selftest-music-only: Native selftest follows Music-only roster

**Owner of this seam:** one `morph` employee. **Written by:** the lead. **State:** briefed.

## Why now

Audit FAIL at 54fb974: embedded selftest still exercises the removed youtube source; the finished brief forbade this exact file, so it needs its own seam. npm test must stay green (constraint, not the named check).

## Out

All five stale selftest cases inside native/host.mjs --selftest are updated to the Music-only source roster so the configured web-selftest gate exits 0, with transport/reconnect coverage retained.

## Check

```text
node packages/web-discord-rpc/native/host.mjs --selftest
```

It passes only when the command exits 0 and the output shows the new behaviour.
A check that cannot go red is not a check.

## Owns

- `packages/web-discord-rpc/native/host.mjs`

## Files (exact, exclusive)

- `packages/web-discord-rpc/native/host.mjs`

No other seam may touch these. No other file is yours.

## Do not touch

- `packages/web-discord-rpc/config.js`
- `packages/web-discord-rpc/activity.js`
- `packages/web-discord-rpc/background.js`
- `packages/web-discord-rpc/test/**`

## Read first

- `Q:/PROJECTS/PERSONAL/oc-collections/packages/oc-stacked/roles/employee.md`
- `Q:/PROJECTS/PERSONAL/oc-collections/packages/oc-stacked/skills/stacked-employee/SKILL.md`

## Tier

standard. Multi-file coordination, ordinary care.

Your archetype names the seat, and `routing.json` pins the model tiers at install. The tier says how much judgement the brief expects, not which model runs: an expert seam is designed by the lead before it reaches you.

## Rules that bind this seam

1. Name the unknown before writing code. If this brief is wrong, say so in one message and stop; do not reinterpret it.
2. The smallest change that closes Out. No speculative flexibility.
3. Every changed line traces to Out. Orphans you created, you delete. Pre-existing dead code, you report.
4. Paste the command and its output in the report. A claim without a command is `Unverified`.
5. Never merge, never push a shared branch, never dispatch another agent. Two failures of the same command: stop and report.

## Report

Write `.stack/reports/native-selftest-music-only.md` with these five headings, all mandatory:

```text
## Outcome     what shipped, two or three sentences
## Evidence    the command and the real output at the head you hand back
## Unverified  every claim you did not check, and why; "none" is a claim
## Scope       paths touched, each inside Owns, or why not
## Lesson      one paragraph the next employee should know
```

Then return one paragraph: outcome, commits, check result, concerns.
