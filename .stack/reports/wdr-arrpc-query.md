# Report — wdr-arrpc-query

## Outcome

Both arRPC clients (`web-discord-rpc/native/arrpc.mjs`, `crunchy-presence/native/arrpc.mjs`) now open the probe socket as `ws://127.0.0.1:<port>/?v=1&client_id=<clientId>` instead of the bare origin, so arRPC has an application id to stamp on `SET_ACTIVITY`. The stale `host.test.mjs` expectation (`host-missing`) now matches what `native/host.mjs` has actually reported since the transport split (`arrpc-closed`), and the crunchy fixture that read the probe port off the URL suffix was corrected to read `new URL(url).port`. One commit, `ea96742`, touching exactly the five Owns paths.

## Evidence

Red first — the two URL assertions, with the source still unchanged, both failed for the right reason (the URL had no query):

```text
node --test packages/web-discord-rpc/test/native/arrpc.test.mjs \
  packages/web-discord-rpc/test/native/host.test.mjs \
  packages/crunchy-presence/test/native/arrpc.test.mjs
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
    actual:   'ws://127.0.0.1:6463',
    expected: 'ws://127.0.0.1:6463/?v=1&client_id=123456789012345678'
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
    actual:   'ws://127.0.0.1:6463',
    expected: 'ws://127.0.0.1:6463/?v=1&client_id=1566530911514923188'
EXIT=1
```

Baseline before any edit showed the stale host assertion exactly as the brief predicted:

```text
✖ a failed connect acks arrpc-unavailable and reports waiting, not error
  + actual - expected
  + 'arrpc-closed'
  - 'host-missing'
ℹ tests 37 / pass 36 / fail 1 (exit 1)
```

Green, at the head handed back (`ea96742`):

```text
$ git rev-parse --short HEAD
ea96742

$ node --test packages/web-discord-rpc/test/native/arrpc.test.mjs packages/web-discord-rpc/test/native/host.test.mjs packages/crunchy-presence/test/native/arrpc.test.mjs
ℹ tests 37
ℹ suites 0
ℹ pass 37
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 215.5001
EXIT=0
```

Regression sweep beyond the brief's check (read-only runs):

```text
$ node --test packages/web-discord-rpc/test/     → tests 173, pass 173, fail 0 (exit 0)
$ node --test packages/crunchy-presence/test/    → tests 196, pass 196, fail 0 (exit 0)
$ node packages/web-discord-rpc/native/host.mjs --selftest   → selftest: PASS (10/10)
$ node packages/crunchy-presence/native/host.mjs --selftest  → exit 0, "ok": true (all checks),
  including transport-auto-falls-back-to-arrpc and transport-arrpc-never-falls-back
```

## Unverified

- **The live bridge against a real arRPC 3.7.0.** I did not start an arRPC listener or re-probe the bridge, so "arRPC stamps the real `application_id`" is the contract's claim, not a measurement I took here. The brief's Check is the three test files, and that is what I ran.
- **That arRPC 3.7.0 accepts `/?v=1&client_id=` as a path.** The brief names this exact form; I did not read arRPC's URL parsing source. Any consumer that matches the probe URL by string suffix would need the same `new URL(url).port` fix I made in the crunchy fixture — I grepped `ws://127.0.0.1` and `client_id` across `packages/` and found no other such matcher.
- **`packages/crunchy-presence/CHANGELOG.md` and `docs/ARCHITECTURE.md`.** That package's `AGENTS.md` asks for an `## [Unreleased]` bullet on a code change and a docs update when a message shape changes. Neither file is in this seam's `Files`, so I did not touch them. No doc in either package mentions the arRPC URL or `6463` (grep over `*.md` returned no matches), so nothing in the docs is currently contradicted.

## Scope

Five paths touched, all inside `Owns`:

- `packages/web-discord-rpc/native/arrpc.mjs` — probe URL gains `/?v=1&client_id=${this.#clientId}`.
- `packages/web-discord-rpc/test/native/arrpc.test.mjs` — the port-probe test asserts the new URL.
- `packages/web-discord-rpc/test/native/host.test.mjs` — stale reason expectation `host-missing` → `arrpc-closed`.
- `packages/crunchy-presence/native/arrpc.mjs` — probe URL gains `/?v=1&client_id=${this.clientId}`.
- `packages/crunchy-presence/test/native/arrpc.test.mjs` — New URL assertion; port-matching fixture reads `new URL(url).port` instead of `url.endsWith(':6463')`.

Nothing outside Owns was edited. `git status` after the commit still shows only the lead's pre-existing `.stack/` modifications and untracked brief/report files; my commit contains the five paths above and nothing else. `native/host.mjs` in both packages, `ipc.mjs`, `config.js`, `background.js` and `bridge-status.js` are untouched.

## Lesson

The client id belongs to the *connection*, not the frame: arRPC reads it off the WebSocket URL and stamps `SET_ACTIVITY` with it, so a client that omits the query silently produces `application_id:''` and an unresolvable app while every frame still looks correct — which is why the unit tests (which asserted the frame, not the URL) stayed green over the bug. Two side effects to know: any fixture that identifies a probe target by URL suffix breaks the moment a query string is appended (`new URL(url).port` is the durable form), and this repo's host has reported `arrpc-closed`, not `host-missing`, for an absent arRPC since the transport split, so read `native/host.mjs` before trusting a reason string in a test.
