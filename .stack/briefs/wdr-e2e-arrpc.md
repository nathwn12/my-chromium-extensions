# Seam wdr-e2e-arrpc: deterministic arRPC end-to-end proof

**Owner of this seam:** one `tester` employee. **Written by:** the lead. **State:** briefed.

## Why now

The arRPC WebSocket path is the web fallback; it needs a repeatable proof that does not depend on a running server.

## Out

A deterministic script starts a fake arRPC WebSocket on 6471, spawns the real host with WDR_ARRPC_PORTS=6471, drives both sources, and proves two connections with type 3 and type 2 plus a clear.

## Check

```text
node packages/web-discord-rpc/scripts/e2e-arrpc.mjs
```

It passes only when the command exits 0 and the output shows the new behaviour.
A check that cannot go red is not a check.

## Owns

- `packages/web-discord-rpc/scripts/e2e-arrpc.mjs`
- `packages/web-discord-rpc/test/integration/arrpc-e2e.test.mjs`

## Files (exact, exclusive)

- `packages/web-discord-rpc/scripts/e2e-arrpc.mjs`
- `packages/web-discord-rpc/test/integration/arrpc-e2e.test.mjs`

No other seam may touch these. No other file is yours.

## Do not touch

- Anything outside Owns and Files.

## Read first

- The files in Owns, and nothing else until they are understood.

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

Write `.stack/reports/wdr-e2e-arrpc.md` with these five headings, all mandatory:

```text
## Outcome     what shipped, two or three sentences
## Evidence    the command and the real output at the head you hand back
## Unverified  every claim you did not check, and why; "none" is a claim
## Scope       paths touched, each inside Owns, or why not
## Lesson      one paragraph the next employee should know
```

Then return one paragraph: outcome, commits, check result, concerns.
