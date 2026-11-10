# wdr-host report

## Outcome

Shipped the Node native-messaging host for web-discord-rpc: strict Chrome stdio framing (`native-framing.mjs`), a per-source arRPC WebSocket client that probes 6463-6472, accepts only the arRPC READY user, sends SET_ACTIVITY and matches the reply by nonce (`arrpc.mjs`), and the stdio host that keeps one client and one last activity per source, acks every activity by id, reports `status waiting` (never an error) when arRPC is absent, and reconnects with doubling backoff while resending the last activity (`host.mjs`). `--selftest` exercises framing, READY validation, nonce matching, the ack path, and the waiting→reconnect→resend path in-process. No file outside the brief's six was touched; no commit was made.

## Evidence

Command, run from the repo root at the head handed back:

```text
node --test packages/web-discord-rpc/test/native/framing.test.mjs packages/web-discord-rpc/test/native/arrpc.test.mjs packages/web-discord-rpc/test/native/host.test.mjs && node packages/web-discord-rpc/native/host.mjs --selftest
```

Output (34 `✔` test lines elided; the summary and selftest block are verbatim):

```text
ℹ tests 34
ℹ suites 0
ℹ pass 34
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 101.5539
PASS  selftest: framing reassembles a frame split mid-prefix and mid-body
PASS  selftest: client accepts arRPC READY and acks SET_ACTIVITY by nonce
PASS  selftest: client rejects a non-arRPC READY and tries the next port
PASS  selftest: host acks an activity after one SET_ACTIVITY
PASS  selftest: host waits, then resends the last activity after a reconnect
selftest: PASS (5/5)
```

Exit status: `EXIT=0`.

Red first. The first run of the check failed 3 of 33 tests, all with the same cause:

```text
✖ a failed connect acks arrpc-unavailable and reports waiting, not error
  AssertionError [ERR_ASSERTION]: a reconnect is armed
  0 !== 1
ℹ pass 30
ℹ fail 3
```

Cause proved: `deliver()` returned the `arrpc-unavailable` ack without calling `scheduleReconnect()`, so the host reported waiting but would never attach when arRPC started later. Fixed in `host.mjs` by arming the same backoff path used for an unexpected close.

The check can go red on both halves. The test half above is the first receipt. For the selftest half, a deliberate mutation (`assert.equal(connected.port, 6463)` → `6462`) produced:

```text
FAIL  selftest: client accepts arRPC READY and acks SET_ACTIVITY by nonce  (6463 !== 6462)
selftest: FAIL (4/5)
MUTATED_EXIT=1
```

and was reverted to the passing run above (`RESTORED_EXIT=0`).

The raw stdio path was probed separately, because the selftest drives `createHost` in-process. A parent process spawned `node native/host.mjs`, wrote a framed `hello` and `ping`, and closed stdin:

```text
{ "code": 0, "messages": [ { "t": "pong" } ], "stderr": "" }
EXIT=0
```

The package's pre-existing suite still passes: `npm test` in `packages/web-discord-rpc` → 27/27, `EXIT=0`.

## Unverified

- **No live arRPC 3.7.0 socket was used.** The READY shape (`cmd:"DISPATCH", evt:"READY", data.user`) and the SET_ACTIVITY reply shape (same `nonce`, `evt:null`) were taken from arRPC's published `src/server.js`/`src/transports/websocket.js` and from `contracts.md`, then exercised against a fake WebSocket. The port probe, no-Origin construction, nonce matching, close and timeout paths are proven; a live handshake is not.
- **The `rejected` branch is defensive.** arRPC's WebSocket transport has no SET_ACTIVITY rejection path today; only a fake `evt:"ERROR"` reply exercised the mapping. The host also maps an unexpected internal throw to `rejected` with a `host-error` ack.
- **Per-source status vocabulary.** `contracts.md` fixes `connected|waiting|error` for the overall `state` but leaves each `sources.*` value as `<state>`. I used `idle|waiting|connected|error`; a later frontend seam must agree on `idle` or the map should be reduced to the three contract words.
- **The 1 MiB cap is applied in both directions.** Chrome's documented browser→host limit is larger; a 1 MiB ceiling on inbound frames is deliberate (extension messages are tiny) and is not tested against Chrome itself.
- **`install-host.mjs` was not re-run.** It writes HKCU registry keys, which is outside this seam's files; its existing test already pins `native/host.mjs` as the target.

## Scope

Paths touched, all inside Owns/Files:

- `packages/web-discord-rpc/native/native-framing.mjs` (new)
- `packages/web-discord-rpc/native/arrpc.mjs` (new)
- `packages/web-discord-rpc/native/host.mjs` (new)
- `packages/web-discord-rpc/test/native/framing.test.mjs` (new)
- `packages/web-discord-rpc/test/native/arrpc.test.mjs` (new)
- `packages/web-discord-rpc/test/native/host.test.mjs` (new)
- `.stack/reports/wdr-host.md` (this report)

No other file was edited. `host.mjs` imports `../config.js` for `DEFAULT_CLIENT_ID`, `SOURCE_META`, and `resolveClientId`; that file is read-only and unchanged. Other modified paths in `git status` belong to concurrent seams.

## Lesson

The next employee should know that the three silent-failure axes here are all in the handshake, not the activity payload: a port can be open without being arRPC (validate the READY user before accepting it), a reply must be matched by nonce or a stale ack resolves the wrong request, and "waiting" is only honest if the retry timer is actually armed — the red test existed because the first implementation acked `arrpc-unavailable` and then did nothing, which looks identical to a working host until Discord shows no presence. Also: every per-source async path must catch, including the reconnect path, or one throw rejects the source's promise chain and every later activity silently loses its ack; that is why `deliver` and `reconnect` both catch and both arm backoff.
