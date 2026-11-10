# Seam wdr-docs: web-discord-rpc and crunchy web documentation

**Owner of this seam:** one `docs` employee. **Written by:** the lead. **State:** briefed.

## Why now

The code now contradicts crunchy AGENTS.md and both READMEs; documentation that contradicts the code is a defect.

## Out

Dated, command-accurate docs cover desktop-first setup, arRPC/Vencord fallback, two stacked activities, app-name override, privacy, troubleshooting, and the amended crunchy transport rule.

## Check

```text
node --test packages/web-discord-rpc/test/docs.test.mjs
```

It passes only when the command exits 0 and the output shows the new behaviour.
A check that cannot go red is not a check.

## Owns

- `packages/web-discord-rpc/README.md`
- `packages/web-discord-rpc/CHANGELOG.md`
- `packages/web-discord-rpc/docs/**`
- `packages/web-discord-rpc/test/docs.test.mjs`
- `packages/crunchy-presence/README.md`
- `packages/crunchy-presence/AGENTS.md`
- `packages/crunchy-presence/CHANGELOG.md`
- `packages/crunchy-presence/docs/**`

## Files (exact, exclusive)

- `packages/web-discord-rpc/README.md`
- `packages/web-discord-rpc/CHANGELOG.md`
- `packages/web-discord-rpc/docs/ARCHITECTURE.md`
- `packages/web-discord-rpc/docs/RESEARCH.md`
- `packages/web-discord-rpc/docs/INSTALL.md`
- `packages/web-discord-rpc/test/docs.test.mjs`
- `packages/crunchy-presence/README.md`
- `packages/crunchy-presence/AGENTS.md`
- `packages/crunchy-presence/CHANGELOG.md`
- `packages/crunchy-presence/docs/ARCHITECTURE.md`
- `packages/crunchy-presence/docs/RESEARCH.md`

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

Write `.stack/reports/wdr-docs.md` with these five headings, all mandatory:

```text
## Outcome     what shipped, two or three sentences
## Evidence    the command and the real output at the head you hand back
## Unverified  every claim you did not check, and why; "none" is a claim
## Scope       paths touched, each inside Owns, or why not
## Lesson      one paragraph the next employee should know
```

Then return one paragraph: outcome, commits, check result, concerns.
