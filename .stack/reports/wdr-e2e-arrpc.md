## Outcome

`packages/web-discord-rpc/scripts/e2e-arrpc.mjs` now starts a real RFC 6455 WebSocket server on `127.0.0.1:6471` playing arRPC, spawns the real native host with `WDR_ARRPC_PORTS=6471`, drives a `hello` (`transport: "auto"`), a WATCHING (type 3) and a LISTENING (type 2) activity from the two sources, then a clear. It proves two WebSocket connections, one per source, each publishing its own Discord type, and the clear arriving as a null activity on the connection that published it: 8 checks, all PASS.

`packages/web-discord-rpc/test/integration/arrpc-e2e.test.mjs` runs that script and asserts its exit code and its PASS lines, so the package suite carries the same proof. No production file was touched: the arRPC path was already correct, this seam is the guard that says so. Nothing from Out was left out.

The host is spawned with `WDR_DISCORD_PIPES` pointed at an absent pipe as well as `WDR_ARRPC_PORTS`, because `auto` probes Discord IPC first; without it the run would publish the fixture activities to a real Discord desktop on the machine and the outcome would depend on whether Discord is running. The dead pipe makes the fallback deterministic in both directions: it fails fast with `ENOENT` and never reaches a real Discord.

## Evidence

Red first — the seam did not exist, so the check could not pass:

```text
> node packages/web-discord-rpc/scripts/e2e-arrpc.mjs
Error: Cannot find module 'Q:\PROJECTS\PERSONAL\my-chromium-extensions\packages\web-discord-rpc\scripts\e2e-arrpc.mjs'
    code: 'MODULE_NOT_FOUND'
exit=1
```

Green — the brief's Check, run twice back to back on the tree being handed back:

```text
> node packages/web-discord-rpc/scripts/e2e-arrpc.mjs
PASS  e2e-arrpc: both sources and the clear ack over arRPC
PASS  e2e-arrpc: status reports connected on arrpc with a null reason and both sources
PASS  e2e-arrpc: a real WebSocket server saw two connections, one per source, on the built-in client id
PASS  e2e-arrpc: each source reached arRPC as its own Discord type (3 and 2) on its own connection
PASS  e2e-arrpc: the clear reached arRPC as a null activity on the connection that published it
PASS  e2e-arrpc: all three SET_ACTIVITYs name the host's pid
PASS  e2e-arrpc: the host exits 0 when stdin closes
PASS  e2e-arrpc: stdout stayed decodable
e2e-arrpc: PASS (8/8)
exit1=0
=== run 2 (same tree, immediately) ===
... identical 8 PASS lines ...
e2e-arrpc: PASS (8/8)
exit2=0
```

The harness:

```text
> node --test packages/web-discord-rpc/test/integration/arrpc-e2e.test.mjs
✔ e2e-arrpc drives the native host over a real WebSocket (211.0667ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
exit3=0
```

Can it go red for the bug, not merely pass after the fix? Three mutations in a scratch copy under `%TEMP%\opencode\wdr-mut` (never in the worktree), each run against the copy's own script:

```text
=== mutation A: the client never accepts an arRPC READY (arrpc.mjs isArRpcUser -> false) ===
FAIL  e2e-arrpc: both sources and the clear ack over arRPC  ([{"t":"ack",...,"ok":false,"error":"transport-unavailable"},...])
FAIL  e2e-arrpc: status reports connected on arrpc with a null reason and both sources  (null)
FAIL  e2e-arrpc: a real WebSocket server saw two connections, one per source, on the built-in client id  ({"connections":3,...})
FAIL  e2e-arrpc: each source reached arRPC as its own Discord type (3 and 2) on its own connection  ([])
FAIL  e2e-arrpc: the clear reached arRPC as a null activity on the connection that published it  ({"cleared":null,"sent":[]})
FAIL  e2e-arrpc: all three SET_ACTIVITYs name the host's pid  ([])
e2e-arrpc: FAIL (2/8)
exit=1

=== mutation B: a null activity is acked but never sent ===
PASS  ... (four checks unchanged)
FAIL  e2e-arrpc: the clear reached arRPC as a null activity on the connection that published it  ({"cleared":null,"sent":[{"type":3,...},{"type":2,...}]})
FAIL  e2e-arrpc: all three SET_ACTIVITYs name the host's pid  ([25984,25984])
e2e-arrpc: FAIL (6/8)
exit=1

=== mutation C: every activity is published as type 3 ===
FAIL  e2e-arrpc: each source reached arRPC as its own Discord type (3 and 2) on its own connection  ([{"type":3,"details":"Big Buck Bunny","socket":1},{"type":3,"details":"Album Track","socket":2}])
e2e-arrpc: FAIL (7/8)
exit=1
```

Each mutation reddens only the checks that name the behaviour it broke: the clear check stays green when only the type is wrong, and the type check stays green when only the clear is dropped.

The harness goes red too, against mutation C in the copy:

```text
> node --test <mut>\test\integration\arrpc-e2e.test.mjs
✖ e2e-arrpc drives the native host over a real WebSocket
  AssertionError [ERR_ASSERTION]: e2e-arrpc exited 1
  FAIL  e2e-arrpc: each source reached arRPC as its own Discord type (3 and 2) on its own connection
  e2e-arrpc: FAIL (7/8)
ℹ pass 0
ℹ fail 1
```

Rest of the package, on the same tree:

```text
> node packages/web-discord-rpc/native/host.mjs --selftest
selftest: PASS (10/10)
selftest exit=0
```

```text
> node --test packages/web-discord-rpc/test
ℹ tests 183   ℹ pass 180   ℹ fail 3
  (both e2e suites PASS: "e2e-arrpc drives the native host over a real WebSocket",
   "e2e-ipc drives the native host over a real named pipe")
```

The 3 failures are all in `packages/web-discord-rpc/test/docs.test.mjs`, an untracked file from another seam that asserts documentation text (`ARCHITECTURE names the arRPC mock user`, `crunchy ARCHITECTURE names arRPC`, `crunchy CHANGELOG names the fallback`). That file is not mine and no docs file was touched by this seam; the failures are the docs seam's to close.

## Unverified

- **Linux / CI.** The script was run on Windows only (this machine, Node v26.13.0). CI runs `ubuntu-26.04`, where the arRPC path is plain loopback TCP and the absent-pipe override resolves to a nonexistent path (`ENOENT`), so I expect it to pass unchanged — but I did not run it there, and that expectation is not evidence.
- **Port 6471 free on the runner.** The brief pins 6471. If something else holds it, `startArRpcServer` rejects with `cannot listen on 127.0.0.1:6471: ...` and the script exits 1 — a hard, readable failure rather than a flake, but it does depend on the port being free.
- **A real Discord desktop was never involved.** By construction (`WDR_DISCORD_PIPES` at an absent pipe) the run proves the fallback, not behaviour against a live Discord client; that is `scripts/e2e-ipc.mjs`'s surface.
- **Fragmentation.** The fixture decoder does not reassemble WebSocket continuation frames (marked `shortcut:` in the file). Node's client sends each `SET_ACTIVITY` as one text frame; a driver that made the client fragment would decode wrong, so this fixture cannot outgrow its current payload sizes without upgrading the decoder.
- **Socket index ordering.** The check that the clear lands on "the connection that published it" compares socket indices, and the type-3/type-2 pair is compared as a set rather than in arrival order, because the two source queues run in parallel. That is deliberate, not a loose assertion: the pid, count and per-type content assertions are exact.

## Scope

Paths touched, both inside `Owns`:

- `packages/web-discord-rpc/scripts/e2e-arrpc.mjs` — new, 387 lines.
- `packages/web-discord-rpc/test/integration/arrpc-e2e.test.mjs` — new, 40 lines.
- `.stack/reports/wdr-e2e-arrpc.md` — this report.

No production file, test, fixture, manifest, package script or CI file was edited: the seam was missing proof, not missing behaviour. Mutation probing happened in a scratch copy at `%TEMP%\opencode\wdr-mut`, outside the worktree and outside the commit. Commit: `cefe549` on `main`, two files, explicit paths only (other seams' untracked files were left alone). Not pushed, not merged, no other agent dispatched.

Pre-existing, reported not deleted: `test/docs.test.mjs` fails 3 of its own assertions against current docs (see Evidence). `packages/web-discord-rpc/package.json`'s `test` script lists four explicit test files, so neither this nor the existing `ipc-e2e.test.mjs` runs under `npm test`; that is a packaging decision for the lead, not something this seam may change.

## Lesson

The interesting part of an arRPC end-to-end run is not the WebSocket, it is the `transport: "auto"` probe: it tries Discord IPC **first**, so a naive fixture publishes your test activities into whatever Discord desktop the machine happens to be running and passes or fails depending on the developer's luck. Pin both ends — `WDR_ARRPC_PORTS` at your fake server and `WDR_DISCORD_PIPES` at a path that cannot exist — and the fallback becomes deterministic. Then remember that two sources are two independent queues: assert the pair as a set and pin the clear to its own connection by socket index, or the test will pass today and fail the day the scheduler interleaves differently. And the fixture must take its mock-user identity from `native/arrpc.mjs` rather than a literal, or the day the real constant changes the fake server keeps saying READY while the client refuses it, and only a mutation probe tells you which side broke.
