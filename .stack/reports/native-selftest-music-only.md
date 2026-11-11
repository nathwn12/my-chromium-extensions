## Outcome

Updated the embedded host selftests to exercise the Music-only `youtube-music` source, including reconnect and IPC/fallback behavior. The auto-IPC case now covers the single configured source rather than asserting the removed two-source roster.

## Evidence

Initial red reproduction:

```text
node packages/web-discord-rpc/native/host.mjs --selftest
PASS  selftest: framing reassembles a frame split mid-prefix and mid-body
PASS  selftest: client accepts arRPC READY and acks SET_ACTIVITY by nonce
PASS  selftest: client rejects a non-arRPC READY and tries the next port
FAIL  selftest: host acks an activity after one SET_ACTIVITY  (Expected values to be strictly equal:

false !== true
)
FAIL  selftest: host waits, then resends the last activity after a reconnect  (Expected values to be strictly equal:
+ actual - expected

+ 'unknown-source'
- 'arrpc-unavailable'
)
PASS  selftest: discord ipc handshake acks SET_ACTIVITY and learns the app name
FAIL  selftest: host auto prefers discord ipc and stacks two sources on two pipes  (Expected values to be strictly deep-equal:
  [
    [
      'ipc-a',
+     false
-     true
    ],
    [
      'ipc-b',
      true
    ]
)
FAIL  selftest: host auto falls back to arrpc when no discord pipe answers  (Expected values to be strictly equal:

0 !== 1
)
FAIL  selftest: host forced ipc never falls back and acks transport-unavailable  (Expected values to be strictly equal:

+ 'unknown-source'
- 'transport-unavailable'
)
PASS  selftest: a hello with an unknown transport is rejected
selftest: FAIL (5/10)
Exit code: 1
```

Green named check:

```text
node packages/web-discord-rpc/native/host.mjs --selftest
PASS  selftest: framing reassembles a frame split mid-prefix and mid-body
PASS  selftest: client accepts arRPC READY and acks SET_ACTIVITY by nonce
PASS  selftest: client rejects a non-arRPC READY and tries the next port
PASS  selftest: host acks an activity after one SET_ACTIVITY
PASS  selftest: host waits, then resends the last activity after a reconnect
PASS  selftest: discord ipc handshake acks SET_ACTIVITY and learns the app name
PASS  selftest: host auto prefers discord ipc for the Music source
PASS  selftest: host auto falls back to arrpc when no discord pipe answers
PASS  selftest: host forced ipc never falls back and acks transport-unavailable
PASS  selftest: a hello with an unknown transport is rejected
selftest: PASS (10/10)
Exit code: 0
```

Constraint check:

```text
npm test --workspace packages/web-discord-rpc
ℹ tests 212
ℹ suites 0
ℹ pass 212
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 702.4785
Exit code: 0
```

## Unverified

No other packages' test suites were run; the brief's named selftest and the package-level npm test were run.

## Scope

Changed `packages/web-discord-rpc/native/host.mjs` (the sole owned source file) and wrote this required report at `.stack/reports/native-selftest-music-only.md`. No other source path was changed.

## Lesson

The roster change invalidated more than the activity assertions: the embedded two-source IPC test encoded a product capability that no longer exists. Keep transport and reconnect coverage tied to the active source roster, and use package tests to catch stale fixtures beyond the direct failing cases.
