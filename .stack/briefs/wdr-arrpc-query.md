# Seam wdr-arrpc-query: arRPC clients must pass client_id in the WebSocket query

**Owner of this seam:** one `backend` employee. **Written by:** the lead. **State:** briefed.

## Why now

Live bridge output showed application_id:'' because the query is missing; Vencord cannot resolve the app or assets without it.

## Out

Both web-discord-rpc and crunchy-presence arRPC clients open ws://127.0.0.1:<port>/?v=1&client_id=<id>, so arRPC stamps SET_ACTIVITY with the real application_id; the stale host test expects arrpc-closed.

## Check

```text
node --test packages/web-discord-rpc/test/native/arrpc.test.mjs packages/web-discord-rpc/test/native/host.test.mjs packages/crunchy-presence/test/native/arrpc.test.mjs
```

It passes only when the command exits 0 and the output shows the new behaviour.
A check that cannot go red is not a check.

## Owns

- `packages/web-discord-rpc/native/arrpc.mjs`
- `packages/web-discord-rpc/test/native/arrpc.test.mjs`
- `packages/web-discord-rpc/test/native/host.test.mjs`
- `packages/crunchy-presence/native/arrpc.mjs`
- `packages/crunchy-presence/test/native/arrpc.test.mjs`

## Files (exact, exclusive)

- `packages/web-discord-rpc/native/arrpc.mjs`
- `packages/web-discord-rpc/test/native/arrpc.test.mjs`
- `packages/web-discord-rpc/test/native/host.test.mjs`
- `packages/crunchy-presence/native/arrpc.mjs`
- `packages/crunchy-presence/test/native/arrpc.test.mjs`

No other seam may touch these. No other file is yours.

## Do not touch

- `packages/web-discord-rpc/native/host.mjs`
- `packages/web-discord-rpc/native/ipc.mjs`
- `packages/web-discord-rpc/config.js`
- `packages/web-discord-rpc/background.js`
- `packages/crunchy-presence/native/host.mjs`
- `packages/crunchy-presence/bridge-status.js`

## Read first

- `.stack/contracts.md`
- `packages/web-discord-rpc/native/arrpc.mjs`
- `packages/web-discord-rpc/test/native/arrpc.test.mjs`
- `packages/web-discord-rpc/test/native/host.test.mjs`
- `packages/crunchy-presence/native/arrpc.mjs`
- `packages/crunchy-presence/test/native/arrpc.test.mjs`

## Tier

cheap. The plan text is complete; this is transcription plus a check.

The archetype names the seat, and `routing.json` pins its model at install. The tier says how much judgement the brief expects, not which model runs: an expert seam is designed by the lead before it reaches you.

## Rules that bind this seam

1. Name the unknown before writing code. If this brief is wrong, say so in one message and stop; do not reinterpret it.
2. The smallest change that closes Out. No speculative flexibility.
3. Every changed line traces to Out. Orphans you created, you delete. Pre-existing dead code, you report.
4. Paste the command and its output in the report. A claim without a command is `Unverified`.
5. Never merge, never push a shared branch, never dispatch another agent. Two failures of the same command: stop and report.

## Report

Write `.stack/reports/wdr-arrpc-query.md` with these five headings, all mandatory:

```text
## Outcome     what shipped, two or three sentences
## Evidence    the command and the real output at the head you hand back
## Unverified  every claim you did not check, and why; "none" is a claim
## Scope       paths touched, each inside Owns, or why not
## Lesson      one paragraph the next employee should know
```

Then return one paragraph: outcome, commits, check result, concerns.
