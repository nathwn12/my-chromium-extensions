# wdr-ipc report

## Outcome

Added `native/ipc.mjs`: one Discord desktop pipe client per source (`opcode|length|json` framing, handshake `{v:1,client_id}`, first READY accepted, nonce-matched `SET_ACTIVITY`, PING→PONG, a rolling rate window whose clear bypasses it, and every failure returned as a value). `native/host.mjs` now selects a transport per `hello`: `auto` (default) tries Discord IPC first and falls back to arRPC once per source, `ipc` and `arrpc` never cross; the first success becomes the preference for the other source, and the status frame reports `discord-ipc`, `arrpc`, or `mixed`. Each source still owns its own client, so two sources mean two pipes and two handshakes, and a real named pipe proves that end to end in `scripts/e2e-ipc.mjs`. The CLI also reads `WDR_ARRPC_PORTS` (comma) and `WDR_DISCORD_PIPES` (semicolon) so integration runs never touch a real listener.

## Evidence

Check, run from the repo root at the head handed back (all three commands chained with `&&`, as the brief specifies):

```text
node --test packages/web-discord-rpc/test/native/ipc.test.mjs packages/web-discord-rpc/test/native/transport.test.mjs && node packages/web-discord-rpc/native/host.mjs --selftest && node packages/web-discord-rpc/scripts/e2e-ipc.mjs
```

Exit codes captured individually: `TEST_EXIT=0 SELFTEST_EXIT=0 E2E_EXIT=0`.

Test half (29 tests, verbatim summary):

```text
ℹ tests 29
ℹ suites 0
ℹ pass 29
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 412.551
```

Selftest half (verbatim):

```text
PASS  selftest: framing reassembles a frame split mid-prefix and mid-body
PASS  selftest: client accepts arRPC READY and acks SET_ACTIVITY by nonce
PASS  selftest: client rejects a non-arRPC READY and tries the next port
PASS  selftest: host acks an activity after one SET_ACTIVITY
PASS  selftest: host waits, then resends the last activity after a reconnect
PASS  selftest: discord ipc handshake acks SET_ACTIVITY and learns the app name
PASS  selftest: host auto prefers discord ipc and stacks two sources on two pipes
PASS  selftest: host auto falls back to arrpc when no discord pipe answers
PASS  selftest: host forced ipc never falls back and acks transport-unavailable
PASS  selftest: a hello with an unknown transport is rejected
selftest: PASS (10/10)
```

Named-pipe half (verbatim):

```text
PASS  e2e-ipc: both sources ack over Discord IPC
PASS  e2e-ipc: status reports connected on discord-ipc with a null reason and both sources
PASS  e2e-ipc: a real named pipe saw two connections and two handshakes
PASS  e2e-ipc: each source's activity reached Discord on its own pipe
PASS  e2e-ipc: every SET_ACTIVITY names the host's pid
PASS  e2e-ipc: the host exits 0 when stdin closes
PASS  e2e-ipc: stdout stayed decodable
e2e-ipc: PASS (7/7)
```

The pipe is `\\.\pipe\wdr-e2e-<pid>-<base36>`, never a `discord-ipc-*` name, and the host is spawned with `WDR_DISCORD_PIPES` pointed at it.

Live probe of the real pipe arRPC owns on this machine (connect only, no SET_ACTIVITY, so no presence was changed):

```text
Test-Path \\.\pipe\discord-ipc-0
True
{"ok":true,"pipePath":"\\\\.\\pipe\\discord-ipc-0","user":"arrpc"}
PROBE_EXIT=0
```

Red first. This seam had no tests of its own, so both layers were red-proved by mutating the new code and reverting:

1. `ipc.mjs` handshake sent `client_id: ""`:

```text
  actual: ''
  expected: '123456789012345678'
    at .../test/native/ipc.test.mjs:189:10
FAIL  e2e-ipc: a real named pipe saw two connections and two handshakes  ({"connections":2,"handshakes":2,"clientIds":["",""]})
e2e-ipc: FAIL (6/7)
E2E_MUTATED_EXIT=1
```

2. `host.mjs` auto plan reduced to IPC only (no fallback):

```text
ℹ tests 14
ℹ pass 12
ℹ fail 2
  actual: [ 'ipc.create:youtube-music', 'ipc.connect:youtube-music' ]
  expected: [ 'ipc.create:youtube-music', 'ipc.connect:youtube-music', 'ipc.close:youtube-music',
               'arrpc.create:youtube-music', 'arrpc.connect:youtube-music', 'arrpc.setActivity:youtube-music' ]
FAIL  selftest: host auto falls back to arrpc when no discord pipe answers
selftest: FAIL (9/10)
SELFTEST_MUTATED_EXIT=1
```

Both mutations were reverted; the green run above is the reverted head.

Pre-existing suite unchanged: `npm test --workspace=web-discord-rpc` → `ℹ tests 30 / ℹ pass 30 / ℹ fail 0`, exit 0.

## Unverified

- **Discord's UI was not observed.** The e2e proves two connections, two handshakes, two `SET_ACTIVITY` frames with distinct payloads and the host's pid. That two activities *render* stacked in the Discord desktop member list is inferred from `contracts.md`'s socketId rule, not seen.
- **No `SET_ACTIVITY` went through the live pipe.** The probe above handshook against the arRPC-owned `discord-ipc-0` and closed; a real desktop client's reply to an activity frame is proven only against the fake pipe.
- **`WDR_ARRPC_PORTS` was not exercised against a listening arRPC server.** The override is proven to reach the probe (spawned host reports `no arRPC server answered on ports 6471`); an actual arRPC session on an injected port belongs to the arRPC e2e script, which is outside my files.
- **The client does not self-reconnect.** `contracts.md` says the IPC client "keeps the last activity and republishes it after a reconnect"; the host does that for both transports through one backoff path, and the client keeps no activity of its own, so a reconnect shows exactly one `SET_ACTIVITY` (proven in `transport.test.mjs` and the existing `host.test.mjs` resend test) rather than two.
- **Non-Windows is skipped, not tested.** `scripts/e2e-ipc.mjs` prints `SKIP` and exits 0 off `win32`; unix-socket paths (`DISCORD_PIPES` overriding via env) are untested here.
- **Discord's real rate limit was not measured.** The client enforces the contract's 5-per-20 s window and coalesces; the server's behaviour above that budget is not probed.
- **One landed assertion is now stale by instruction.** `packages/web-discord-rpc/test/native/host.test.mjs:186` expects `waiting.reason === "host-missing"` for a failed arRPC connect; the lead's later instruction (a failed arRPC connect reports `arrpc-closed`; `host-missing` belongs to Chrome failing to launch the host) supersedes it. That file is not in my Files, so it was not edited. It is the only failing assertion in the package (`node --test test/native` → 62/63); the fix is that one expected string.

## Scope

Paths touched, each inside Files:

- `packages/web-discord-rpc/native/ipc.mjs` (new)
- `packages/web-discord-rpc/native/host.mjs` (modified: transport selection, status transport/reason, env overrides, selftest)
- `packages/web-discord-rpc/test/native/ipc.test.mjs` (new)
- `packages/web-discord-rpc/test/native/transport.test.mjs` (new)
- `packages/web-discord-rpc/scripts/e2e-ipc.mjs` (new)
- `packages/web-discord-rpc/test/integration/ipc-e2e.test.mjs` (new)
- `.stack/reports/wdr-ipc.md` (this report)

No file outside Files was edited. `test/native/host.test.mjs` is untouched and stale (named above). `config.js`, `bridge-status.js` and `background.js` are the concurrent `wdr-transport` seam's; I read them for the wire contract only.

Response shapes I changed, and every caller the contract names: the `status` frame's `transport` gains `discord-ipc`/`mixed`, its `reason` gains `discord-closed` (and a failed arRPC connect now says `arrpc-closed`), a successful connect carries `reason: null`, and a failed selected connect acks `transport-unavailable` (the forced-`arrpc` path keeps `arrpc-unavailable` so the landed host test stays meaningful). The worker consumes these through `bridgeStatusOf`/`classifyBridgeFailure` in `bridge-status.js`, which the `wdr-transport` seam owns; `host.test.mjs:186` is the one caller-side expectation this breaks.

## Lesson

The transport that answers the handshake is not necessarily the one you named: on this machine `\\.\pipe\discord-ipc-0` is owned by arRPC when no desktop client is running, and it answers READY with user `arrpc`. Validating the READY user (as the arRPC WebSocket path must) would have rejected the primary desktop path on a machine where everything is working. Accept the first READY on a pipe, and put the identity check only where it is meaningful. Second: keep exactly one reconnect loop. The host already owned backoff and last-activity resend for arRPC; letting the IPC client reconnect as well would have sent every activity twice and burned the rate budget, so the client's `connect()` is deliberately idempotent and the host resends. Third: a `status` frame's `reason` is UI switch input, not a log line - `reason:"connected"` renders wrong copy, and `host-missing` sends the user to the installer for an arRPC that is simply not running.
