# Report wdr-stuck-waiting

## Outcome

The options page no longer sticks at Bridge Waiting / "Waiting for Discord to respond." when Discord is running. Three defects fixed in `packages/web-discord-rpc`:

1. **Deadlock (the stuck).** `background.js push()` handed desired activities to the host only while `CONNECTED`, but the host connects a source only when an activity arrives and arms its retry only once `lastActivity` is set — after `hello` the host published nothing, so a fresh boot stayed `CONNECTING` forever. `push()` now sends through the per-source limiter while `CONNECTING` or `WAITING` too (`SENDABLE_BRIDGE_STATES`); `idle`/`error`/unknown still deny, `lastSent` dedupe and the 4-per-20s budget are untouched, and ordering is safe because the hello is posted synchronously first on the ordered port.
2. **Mislabel.** The wire already names `discord-closed` (README, ARCHITECTURE, docs.test), but `bridge-status.js REASON` had no such member, so the worker dropped the host's hint and fell back to HUNG: a quit Discord read as a silent one. Added `REASON.DISCORD_CLOSED` with the not-running copy, plus a pattern for pipe-absent details (`no Discord IPC pipe answered`, `ENOENT … discord-ipc`, `transport-unavailable`). Handshake/reply timeouts stay HUNG (Discord running but silent).
3. **Silent hello.** `handleHello` published nothing, so with zero tabs the worker kept a stale stored snapshot. It now ends with `publish(null, null, "connecting")`; no copy changed.

Six old assertions that pinned the deadlock's silence were updated (counts 1→2, 2→4, one `.slice(0,2)` order check), each with a comment saying why. No commit was made by the worker (step ceiling); the lead verified, reported, and is landing.

## Evidence

Red first (new tests, 6 failures before the fix): a boot with no host status followed by one tab report posted zero activities; `classifyBridgeFailure("no Discord IPC pipe answered on 10 path(s)")` and the `{reason:"discord-closed"}` hint both fell to `hung`; a lone hello produced no status frame.

Green, re-run by the lead at this tree (exit 0 throughout):

```text
node --test background.test.mjs bridge-status.test.mjs host.test.mjs → 69 pass, 0 fail
npm test → 103 + 196 + 12 + 225 pass, 0 fail
node scripts/verify-integration.mjs → 16/16
node packages/web-discord-rpc/native/host.mjs --selftest → PASS 10/10
node packages/crunchy-presence/native/host.mjs --selftest → exit 0
node packages/web-discord-rpc/scripts/e2e-arrpc.mjs → PASS 8/8
node packages/web-discord-rpc/scripts/e2e-ipc.mjs → PASS 7/7
```

Live-wire probe (throwaway script outside the repo, deliberately absent pipe): frames were `status connecting (discord-ipc)` → `ack transport-unavailable` → `status waiting reason discord-closed`; the worker read `waiting / discord-closed / "Discord is not running — presence paused, resumes automatically."`, non-error. Real-pipe probes against the owner's DiscordCanary earlier proved the pipe, READY handshake, and SET_ACTIVITY all answer with the built-in ID.

## Unverified

A real Chrome boot against the live DiscordCanary showing the track in the Discord profile was not run: the worker published nothing to the live pipe on purpose, and the lead did not open a browser either. The chain to that card is covered by unit + e2e + live-handshake evidence, not by an observed card.

## Scope

Exactly the six brief Files, nothing else: `background.js`, `bridge-status.js`, `native/host.mjs`, and the three matching test files. `.stack/ledger.md` + `.stack/digest.md` edits in the tree are the lead's own bookkeeping, excluded from the source commit.

## Lesson

Pin who speaks first after hello: every activity test fired a fake `connected` before reporting, so the suite proved a flow the production pair could never open. One ordering test with a silent host would have caught the deadlock at creation.

## Concerns for the record

- A fresh boot now sends each desired payload twice (once while connecting, once on the connected replay). Deliberate: SET_ACTIVITY is idempotent, and the second send is the replay path the old code already had.
- The options page renders the new hello `connecting` frame with the pre-existing CONNECTING copy until the first connect result arrives. Pre-existing wording, left alone.
- `"Discord IPC connection closed"` still classifies as `arrpc-closed`. Same friendly copy, not user-visible; left alone.
