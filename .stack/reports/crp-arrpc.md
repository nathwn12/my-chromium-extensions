# crp-arrpc — crunchy-presence arRPC transport

Seat: backend (opencode-go/deepseek-v4.1-flash), tier expert. Brief: `.stack/briefs/crp-arrpc.md`.

## Outcome

> Superseded in direction by the addendum below (owner priority: desktop IPC is primary, arRPC is the web fallback). The mechanism described here is current; the order is not.

Crunchy's native host now chooses a transport per `hello`: `transport: "auto" | "arrpc" | "ipc"`, absent meaning `auto`. `auto` tries arRPC (WebSocket, ports 6463–6472) and falls back to today's Discord IPC pipe once per hello; an explicit `arrpc` never falls back and reports the absence as `waiting / arrpc-closed`. Every status frame now names the chosen `transport`, the rest of the envelope shapes are unchanged, `type: 3` validation is untouched, and `node native/host.mjs --selftest` proves all four transport paths. No commit was made: other seams are uncommitted in the same worktree.

## Evidence

Red first, before any implementation (`native/arrpc.mjs` absent, `transport` unknown to the protocol and the host):

```text
$ node --test packages/crunchy-presence/test/native/arrpc.test.mjs packages/crunchy-presence/test/native/transport.test.mjs packages/crunchy-presence/test/native/protocol.test.mjs packages/crunchy-presence/test/native/ipc.test.mjs
Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'Q:\PROJECTS\PERSONAL\my-chromium-extensions\packages\crunchy-presence\native\arrpc.mjs'
✖ packages\crunchy-presence\test\native\arrpc.test.mjs (64.9748ms)
... 12 individual transport/protocol assertions failed ...
ℹ tests 28
ℹ pass 16
ℹ fail 12
exit=1
```

The brief's check, run exactly as written:

```text
$ node --test packages/crunchy-presence/test/native/arrpc.test.mjs packages/crunchy-presence/test/native/transport.test.mjs packages/crunchy-presence/test/native/protocol.test.mjs packages/crunchy-presence/test/native/ipc.test.mjs && node packages/crunchy-presence/native/host.mjs --selftest
✔ arRPC listens on the documented 6463-6472 range (1.4883ms)
✔ connect resolves on the arRPC READY and reports the port it used (0.7917ms)
✔ a READY from a non-arRPC listener is refused and the next port is tried (0.368ms)
✔ no listener rejects with an arrpc diagnostic and never fatal (0.883ms)
✔ a listener that never sends READY times out instead of hanging the hello (40.7442ms)
✔ setActivity sends the contract frame and matches the reply by nonce (0.9714ms)
✔ every SET_ACTIVITY carries a distinct nonce (0.4318ms)
✔ a SET_ACTIVITY rejection is surfaced, not swallowed (0.3005ms)
✔ setActivity before connect is a typed failure, not a throw (0.1948ms)
✔ a dropped connection reports waiting and republishes the last activity (5.2724ms)
✔ close stops the client and leaves no reconnect timer behind (32.3967ms)
✔ handshake reaches READY and SET_ACTIVITY is echoed back (9.5178ms)
✔ SET_ACTIVITY ERROR is surfaced, not swallowed (2.6164ms)
✔ activity null clears presence and acks (2.0695ms)
✔ frames reassemble when split at every byte boundary (1.2411ms)
✔ a byte-at-a-time stream decodes three frames exactly once (0.5038ms)
✔ pipe drop reconnects with backoff and republishes the last activity (14.2377ms)
✔ rate guard holds 2 frames per window and coalesces to the newest (7.0161ms)
✔ no Discord pipe is a transient failure, never fatal (0.9845ms)
✔ host reports no-pipe as waiting, then connects later and republishes (12.2685ms)
✔ Discord quitting while connected reports waiting, not connected (0.8852ms)
✔ every SET_ACTIVITY carries a distinct nonce (1.2263ms)
✔ hello.clientId accepts 17, 19 and 20 digit ids (2.554ms)
✔ hello.clientId rejects 16 and 21 digits and non-numeric ids with a reason (0.3841ms)
✔ hello.transport accepts auto, arrpc and ipc, and missing means auto (0.2637ms)
✔ hello.transport rejects an unknown transport with a reason (0.1919ms)
✔ a status frame carries the chosen transport only when it is one of the two (0.2868ms)
✔ waiting reasons include arrpc-closed and still fall back to discord-closed (0.1366ms)
✔ auto prefers arRPC and reports it on the wire (2.8252ms)
✔ auto falls back to Discord IPC when arRPC is absent (0.6781ms)
✔ transport arrpc never falls back and reports the absence as waiting (1.506ms)
✔ transport ipc keeps today's path and never touches arRPC (0.4885ms)
✔ a host wired with only an IPC client keeps the IPC path for auto (0.4087ms)
✔ a hello with an unknown transport is rejected before any client is built (0.8142ms)
✔ an explicit arrpc preference on an IPC-only host waits and never builds IPC (0.3007ms)
✔ a second hello with the same preference reuses the connected transport (0.3743ms)
✔ switching transport rebuilds the client (0.4312ms)
✔ an activity is carried to whichever transport was chosen (0.4893ms)
✔ the native status frame still decodes when transport is carried inside it (0.0976ms)
ℹ tests 39
ℹ suites 0
ℹ pass 39
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 166.5619
exit=0
```

The selftest half of that chain printed `"ok": true` and these new checks (each `"ok": true`):

```json
{ "name": "hello-transport-ipc",              "detail": "{\"t\":\"status\",\"state\":\"connected\",\"transport\":\"discord-ipc\",\"appName\":\"Discord\",\"user\":\"selftest\"}" }
{ "name": "transport-auto-prefers-arrpc",     "detail": "{\"t\":\"status\",\"state\":\"connected\",\"transport\":\"arrpc\",\"appName\":\"Discord\",\"user\":\"arrpc\"}" }
{ "name": "transport-auto-falls-back-to-ipc", "detail": "{\"t\":\"status\",\"state\":\"connected\",\"transport\":\"discord-ipc\",\"appName\":\"Discord\",\"user\":\"selftest\"}" }
{ "name": "transport-arrpc-never-falls-back", "detail": "{\"t\":\"status\",\"state\":\"waiting\",\"transport\":\"arrpc\",\"reason\":\"arrpc-closed\",\"detail\":\"arrpc is not listening on 127.0.0.1\"}" }
{ "name": "transport-ipc-skips-arrpc",        "detail": "{\"t\":\"status\",\"state\":\"connected\",\"transport\":\"discord-ipc\",\"appName\":\"Discord\",\"user\":\"selftest\"}" }
```

The frozen tests, with a live arRPC on this machine (ports 6463 and 1337 were listening during every run):

```text
$ node --test packages/crunchy-presence/test/
ℹ tests 194
ℹ suites 0
ℹ pass 194
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 672.2627
exit=0
```

```text
$ git diff --stat -- packages/crunchy-presence
 packages/crunchy-presence/bridge-status.js         |   6 +
 packages/crunchy-presence/native/host.mjs          | 214 ++++++++++++++++++++-
 packages/crunchy-presence/native/protocol.mjs      |  14 ++
 .../crunchy-presence/test/native/protocol.test.mjs |  53 ++++-
 4 files changed, 279 insertions(+), 8 deletions(-)
plus new: native/arrpc.mjs, test/native/arrpc.test.mjs, test/native/transport.test.mjs
```

Three of the first green attempt's failures were real and each bought a correction:

1. `this.WebSocketImpl is not a constructor` — the test harness passed an arrow factory where production hands a class (`globalThis.WebSocket`). The harness now supplies a class; `arrpc.mjs` still calls `new WebSocketImpl(url)`.
2. `host reports no-pipe as waiting` got `connected` — the frozen tests narrow the host with `host.makeClient = ...` *after* construction, so a constructor-time `injectedIpc` flag missed it and `auto` hijacked a live arRPC. The rule is now measured per hello (`arrpcWired()` identity check) and the frozen test passes again.
3. `an absent transport acks honestly` got `ok: true` — the fake arRPC client acked success while not ready. The fakes now model real readiness (`arrpc not connected`), matching `DiscordPipeClient`.

## Unverified

- **No live end-to-end run against real arRPC or Discord Web.** Every socket in `arrpc.test.mjs`/`transport.test.mjs` is a fake per the contracts' test conventions; arRPC really is listening on 6463 here, but I never sent it a frame. The port range, the READY mock user id (`1045800378228281345`), "no `Origin` is sent", and the vencord `socketId` keying are taken from `.stack/contracts.md`, not re-probed.
- **The real `SET_ACTIVITY` reply body was never observed.** If arRPC omits `data.name`, `appName` falls back to `'Discord'` (asserted by the fake); whether Discord Web then shows the right application label is unproven.
- **No extension path exercised.** `background.js` posts `{t:"hello", clientId}` today, so every user reaches `auto`; no setting, popup, or options surface was run, and nobody has confirmed the additive `transport` field is ignored by every consumer (the code reads it nowhere, which I checked by grep only).
- **`auto` is sticky.** After one fallback the host stays on IPC for that connection and does not re-probe arRPC when it appears later; that is my design decision from the contract's "auto tries arRPC first, then Discord IPC", not a fact about what users want. A browser restart, or a new hello on a new port, is what re-evaluates it.
- **The arRPC rate path has no bucket.** `DiscordPipeClient` keeps a 5-per-20 s backstop; `ArRpcClient` sends every activity it is handed. I relied on the extension's coalescing. Not load-tested.
- **`arrpcWired()` is exercised through fakes only.** The production branch (`new Host()`, both default factories, live arRPC) is the one path no test drives.
- **AGENTS.md, docs and CHANGELOG still contradict this change** (see Scope). Until a seam updates them, the package documentation is a defect by its own rule.

## Scope

Touched exactly the seven paths in Files:

- `packages/crunchy-presence/native/arrpc.mjs` (new) — `ArRpcClient`, `ARRPC_PORTS`, `ARRPC_MOCK_USER_ID`.
- `packages/crunchy-presence/native/host.mjs` — `preference`/`transport`, `arrpcWired()`, `createClient()`, `connectClient()` (auto-only fallback), `transport` on every status frame, four new selftest checks.
- `packages/crunchy-presence/native/protocol.mjs` — `hello.transport` validation, `arrpc-closed` in `WAITING_REASONS`, optional `transport` on status frames.
- `packages/crunchy-presence/bridge-status.js` — `REASON.ARRPC_CLOSED`, its copy, and an `arrpc` pattern ordered before the `ECONNREFUSED`→`discord-closed` pattern.
- `packages/crunchy-presence/test/native/arrpc.test.mjs` (new) — 11 tests, fake WebSocket, no port binding.
- `packages/crunchy-presence/test/native/transport.test.mjs` (new) — 11 tests over injected transports.
- `packages/crunchy-presence/test/native/protocol.test.mjs` — 4 tests appended.

Outside Files, this report is the only file written. `packages/crunchy-presence/AGENTS.md` still says "Native messaging is the only Discord transport. No gateway WebSocket, no `discord-rpc` dependency, no HTTP" and "Never add a second Discord transport"; `docs/ARCHITECTURE.md` does not describe transport selection; `CHANGELOG.md` has no bullet. All three are a different owner's files, so **the lead needs a follow-up seam** for them. Nothing else in the worktree was touched: the other modified paths (`packages/web-discord-rpc/**`, other `.stack/reports/`, `.stack/contracts.md`, `.stack/ledger.md`, `.stack/digest.md`) belong to concurrent seams. No commit, no merge, no push.

## Lesson

The next employee should know that this machine has a live arRPC on 6463, so any `auto`-prefers-arRPC change is instantly visible to the frozen tests — and the frozen tests narrow the host by assigning `host.makeClient` *after* construction, which silently defeats any wiring decision made in the constructor. Measure "which transports does this host have" at the moment you choose one, not when you build the object, and never let a default factory probe the network on behalf of a caller who handed you a fake. Second: a fake transport that acks success while not ready hides exactly the bug the ack exists to prevent; model readiness in the fake or the test proves nothing. Third, and cheapest to forget: this package's own AGENTS.md forbids a second Discord transport, and the code now contradicts it — a green check is not a clean land while the package's documentation says the change is illegal.

---

## Addendum 2026-11-10 — owner priority flipped: desktop IPC primary, arRPC the web fallback

`auto` now resolves Discord IPC first, the desktop path, and reaches arRPC only when that pipe is unavailable. `ipc` and `arrpc` stay forced. The change is confined to `Host.createClient` / `Host.connectClient`: `createClient` builds the IPC client for both `ipc` and the primary leg of `auto`, and `connectClient` makes one arRPC attempt inside the `auto` catch — swapping `this.client` only after the fallback connects, so a failed fallback leaves the primary client in place for the retry timer. When both are absent the IPC failure is the one reported (`discord-closed`), because that is the sentence a desktop user needs; the arRPC failure stays in stderr.

Behaviour matrix now proven by the suite and the selftest:

| preference | Discord IPC up | IPC down, arRPC up | both down |
| --- | --- | --- | --- |
| `auto` (or no `transport`) | IPC, `transport: "discord-ipc"` | arRPC, `transport: "arrpc"` | `waiting / discord-closed`, transport `discord-ipc` |
| `ipc` | IPC | `waiting / discord-closed`, arRPC never built | same |
| `arrpc` | arRPC | `waiting / arrpc-closed`, IPC never built | same |

### Evidence

```text
$ node --test packages/crunchy-presence/test/native/arrpc.test.mjs packages/crunchy-presence/test/native/transport.test.mjs packages/crunchy-presence/test/native/protocol.test.mjs packages/crunchy-presence/test/native/ipc.test.mjs && node packages/crunchy-presence/native/host.mjs --selftest
ℹ tests 41
ℹ suites 0
ℹ pass 41
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
exit=0
```

The selftest half printed `"ok": true`; the transport checks, all `"ok": true`, are now:

```json
{ "name": "transport-auto-prefers-ipc", "detail": "{\"t\":\"status\",\"state\":\"connected\",\"transport\":\"discord-ipc\",\"appName\":\"Discord\",\"user\":\"selftest\"}" }
{ "name": "transport-auto-falls-back-to-arrpc", "detail": "{\"t\":\"status\",\"state\":\"connected\",\"transport\":\"arrpc\",\"appName\":\"Discord\",\"user\":\"arrpc\"}" }
{ "name": "transport-arrpc-never-falls-back", "detail": "{\"t\":\"status\",\"state\":\"waiting\",\"transport\":\"arrpc\",\"reason\":\"arrpc-closed\",\"detail\":\"arrpc is not listening on 127.0.0.1\"}" }
{ "name": "transport-ipc-skips-arrpc", "detail": "{\"t\":\"status\",\"state\":\"connected\",\"transport\":\"discord-ipc\",\"appName\":\"Discord\",\"user\":\"selftest\"}" }
{ "name": "transport-ipc-never-falls-back", "detail": "{\"t\":\"status\",\"state\":\"waiting\",\"transport\":\"discord-ipc\",\"reason\":\"discord-closed\",\"detail\":\"connect ENOENT \\\\\\\\.\\\\pipe\\\\discord-ipc-0\"}" }
{ "name": "transport-auto-reports-the-primary-absence", "detail": "{\"t\":\"status\",\"state\":\"waiting\",\"transport\":\"discord-ipc\",\"reason\":\"discord-closed\",\"detail\":\"connect ENOENT \\\\\\\\.\\\\pipe\\\\discord-ipc-0\"}" }
```

The frozen suite, with real arRPC still listening on 6463:

```text
$ node --test packages/crunchy-presence/test/
ℹ tests 196
ℹ suites 0
ℹ pass 196
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 712.2705
exit=0
```

Transport tests whose meaning changed: `auto prefers arRPC…` became `auto uses Discord IPC when it is available and never builds arRPC`; `auto falls back to Discord IPC when arRPC is absent` became `auto falls back to arRPC only when Discord IPC is unavailable`; `a second hello…` now counts one `ipc.connect` and no `arrpc.create`; and two tests were added — `forced ipc never falls back to arRPC when Discord is absent` and `auto with neither transport reports the primary absence, not an arRPC one`. The four-file total went 39 → 41; the package total 194 → 196.

### Still unverified after the flip

- **No live end-to-end run.** Every socket in `arrpc.test.mjs`/`transport.test.mjs` is fake; the real arRPC on 6463 was never sent a frame, and no real Discord pipe was exercised. The fallback is proven against injected clients only.
- **`auto` is still sticky.** Once a hello lands on the arRPC fallback, later hellos with the same preference reuse that client instead of re-probing the primary IPC path; a browser restart or a new host process re-evaluates it. Re-probing on every hello would churn the arRPC session on each reconnect, so I left it — but a desktop Discord that starts after the fallback is not picked up until the host restarts.
- **A failed fallback keeps the primary client.** After both transports fail, `this.client` is still the failed IPC client and `scheduleConnectRetry` retries IPC only; arRPC is retried on the next hello. No timer-driven test covers that path.
- The AGENTS.md / `docs/ARCHITECTURE.md` / `CHANGELOG.md` conflict stands unchanged: `packages/crunchy-presence/AGENTS.md` still forbids a second Discord transport, and it is outside this seam's Files.

