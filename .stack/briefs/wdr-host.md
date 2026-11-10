# Seam wdr-host: web-discord-rpc native arRPC host

**Owner of this seam:** one `backend` employee. **Written by:** the lead. **State:** briefed.

## Why now

This is the only path from the extension to arRPC; a silent origin, port or nonce mistake is invisible until Discord shows nothing.

## Out

A Node native-messaging host opens one arRPC WebSocket per source, validates READY, sends SET_ACTIVITY, acks by nonce, reconnects with backoff, and exposes a passing selftest.

## Check

```text
node --test packages/web-discord-rpc/test/native/framing.test.mjs packages/web-discord-rpc/test/native/arrpc.test.mjs packages/web-discord-rpc/test/native/host.test.mjs && node packages/web-discord-rpc/native/host.mjs --selftest
```

It passes only when the command exits 0 and the output shows the new behaviour.
A check that cannot go red is not a check.

## Owns

- `packages/web-discord-rpc/native/**`
- `packages/web-discord-rpc/test/native/**`

## Files (exact, exclusive)

- `packages/web-discord-rpc/native/native-framing.mjs`
- `packages/web-discord-rpc/native/arrpc.mjs`
- `packages/web-discord-rpc/native/host.mjs`
- `packages/web-discord-rpc/test/native/framing.test.mjs`
- `packages/web-discord-rpc/test/native/arrpc.test.mjs`
- `packages/web-discord-rpc/test/native/host.test.mjs`

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

Write `.stack/reports/wdr-host.md` with these five headings, all mandatory:

```text
## Outcome     what shipped, two or three sentences
## Evidence    the command and the real output at the head you hand back
## Unverified  every claim you did not check, and why; "none" is a claim
## Scope       paths touched, each inside Owns, or why not
## Lesson      one paragraph the next employee should know
```

Then return one paragraph: outcome, commits, check result, concerns.
