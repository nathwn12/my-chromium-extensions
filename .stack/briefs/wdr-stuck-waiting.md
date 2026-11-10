# Seam wdr-stuck-waiting: worker sends desired activities before connected

**Owner of this seam:** one `employee` employee. **Written by:** the lead. **State:** briefed.

## Why now

Proved live: pipe connects, handshake READY, SET_ACTIVITY ok against DiscordCanary, yet the options page never leaves Waiting - the worker/host handshake is deadlocked and the absence copy is a mislabel.

## Out

A fresh boot with a YouTube tab reaches Bridge Connected and publishes to Discord desktop over IPC without touching Transport: the worker hands the host its desired activities while connecting, the host announces itself on hello, and a missing desktop pipe reads Discord is not running instead of Waiting for Discord to respond.

## Check

```text
node --test packages/web-discord-rpc/test/extension/background.test.mjs packages/web-discord-rpc/test/extension/bridge-status.test.mjs packages/web-discord-rpc/test/native/host.test.mjs && npm test && node scripts/verify-integration.mjs && node packages/web-discord-rpc/native/host.mjs --selftest && node packages/web-discord-rpc/scripts/e2e-ipc.mjs
```

It passes only when the command exits 0 and the output shows the new behaviour.
A check that cannot go red is not a check.

## Owns

- `packages/web-discord-rpc/background.js`
- `packages/web-discord-rpc/bridge-status.js`
- `packages/web-discord-rpc/native/host.mjs`

## Files (exact, exclusive)

- `packages/web-discord-rpc/background.js`
- `packages/web-discord-rpc/bridge-status.js`
- `packages/web-discord-rpc/native/host.mjs`
- `packages/web-discord-rpc/test/extension/background.test.mjs`
- `packages/web-discord-rpc/test/extension/bridge-status.test.mjs`
- `packages/web-discord-rpc/test/native/host.test.mjs`

No other seam may touch these. No other file is yours.

## Do not touch

- `packages/crunchy-presence/**`
- `packages/audio-normalizer/**`
- `packages/slowed-reverb/**`
- `README.md`
- `.github/**`
- `scripts/**`

## Read first

- `packages/web-discord-rpc/background.js`
- `packages/web-discord-rpc/bridge-status.js`
- `packages/web-discord-rpc/native/host.mjs`
- `.stack/goal.md`

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

Write `.stack/reports/wdr-stuck-waiting.md` with these five headings, all mandatory:

```text
## Outcome     what shipped, two or three sentences
## Evidence    the command and the real output at the head you hand back
## Unverified  every claim you did not check, and why; "none" is a claim
## Scope       paths touched, each inside Owns, or why not
## Lesson      one paragraph the next employee should know
```

Then return one paragraph: outcome, commits, check result, concerns.

## Known gap (proved live this turn, not a guess)

Pipe `\\.\pipe\discord-ipc-0` accepts connections, answers READY to a handshake with the built-in ID, and acks SET_ACTIVITY (probed with throwaway Node scripts against the owner'"'"'s running DiscordCanary). The extension still sits at Bridge Waiting / "Waiting for Discord to respond." with Transport used "Discord desktop app". Three defects combine:

1. **Deadlock (the stuck).** `background.js push()` returns early unless `bridgeState === CONNECTED`, but the host only connects a source inside `deliver()` (on activity) and only arms its reconnect when `lastActivity` is set. After `hello` the host publishes nothing, so the worker can never become CONNECTED first: a fresh boot with tabs reporting stays CONNECTING forever, showing the hung copy by default. Every existing activity test calls `connect(port)` (fires status connected) before `sendState`, so no test pins the real-world order. Required shape: let `push()` deliver through the limiter while the bridge is CONNECTING or WAITING as well as CONNECTED (keep denying IDLE/ERROR and unknown states, keep the `lastSent` dedupe and the limiter budget so a waiting bridge is not spammed); ordering is safe because the hello is posted synchronously before any activity on the same ordered port. Red first: boot with the fake chrome, do NOT fire status connected, `sendState` one tab, assert the port got `hello` then one `activity` (today: zero activities).
2. **Mislabel.** The wire already names `discord-closed` (README, ARCHITECTURE, docs.test line 91, transport tests), but `bridge-status.js REASON` has no such member, so `classifyBridgeFailure` drops the host'"'"'s hint and falls back to HUNG: a quit/absent Discord reads "Waiting for Discord to respond." instead of "Discord is not running". Required shape: add `DISCORD_CLOSED = "discord-closed"` with the same friendly copy as ARRPC_CLOSED, and a pattern mapping a pipe-absent detail (`no Discord IPC pipe answered`, `ENOENT ... discord-ipc`) to it; keep genuine handshake/reply timeouts mapping to HUNG (Discord is running but silent). Red first: `classifyBridgeFailure("no Discord IPC pipe answered on 10 path(s)")` and the same text with `{reason:"discord-closed"}` must both yield kind `discord-closed` with the not-running copy.
3. **Silent hello.** `handleHello` publishes nothing, so with zero tabs the worker sits on a stale stored snapshot and can never show a live transport. Required shape: after the reset loop, `publish(null, null, "connecting")` so the worker learns the host is alive plus its transport; do not change any copy in `presentStatus`. Red first: `handle` a valid hello alone and assert one status frame with `state "connecting"`.

Keep the host'"'"'s forced-preference rule (a forced `ipc` never builds arRPC) and do not touch copy for CONNECTED/WAITING/ERROR paths. Watch the existing tests that assert exact frame sequences after hello+activity (host.test lines ~93, ~321): an extra status frame must not break them - use `find`, adjust only if the assertion was pinning silence.