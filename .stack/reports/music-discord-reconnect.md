# music-discord-reconnect

## Outcome

`packages/web-discord-rpc/test/native/host.test.mjs` now proves that a YouTube Music card
published over the Discord IPC transport is resent after the pipe disconnects and the host's
armed reconnect succeeds: one fake IPC client, `connect()` called twice, `setActivity` called
with the retained activity twice, and the final `status` frame reporting
`transport: "discord-ipc"`, `sources["youtube-music"]: "connected"`, with no timer left armed.

The same file also had to be aligned to the Music-only source table already sitting in the
working tree (`config.js` currently exports `SOURCE_META = { "youtube-music": … }`), because 13
of its 15 pre-existing tests failed on `unknown-source` before any edit of mine. That alignment
is confined to `source:` literals and the assertions that named the removed `youtube` source;
one test that could only exist with two sources ("one transport per source") became "one
transport is reused across activities", which is the same claim for the single surviving source,
and the connecting-announcement snapshot now derives its source roster from `SOURCE_META`, so it
holds whether or not `youtube` comes back. No production file was touched.

## Evidence

Check, at the head handed back (exit 0):

```text
$ node --test packages/web-discord-rpc/test/native/host.test.mjs
✔ ping answers pong without creating a transport (1.1477ms)
✔ a valid hello announces the host as connecting with the transport it will use (0.3184ms)
✔ hello sets the application id and an activity is acked after SET_ACTIVITY (0.4714ms)
✔ one transport is reused across activities (0.2089ms)
✔ a null activity clears presence and is still acked (0.6178ms)
✔ an unknown source or a non-object activity is refused without a transport (0.1425ms)
✔ a failed connect acks arrpc-unavailable and reports waiting, not error (0.2799ms)
✔ a reconnect resends the last activity and reports connected (3.5652ms)
✔ a YouTube Music activity is resent after a Discord IPC disconnect and reconnect (0.6998ms)
✔ an unexpected socket close reports waiting and reconnects with backoff that doubles (0.5039ms)
✔ a hung reply reports an error and reconnects (0.2709ms)
✔ hello with a new application id rebuilds the transport and resends the last activity (0.4425ms)
✔ a malformed hello is rejected with status error, not silently accepted (0.1853ms)
✔ activity before hello publishes under the built-in application id (0.1178ms)
✔ a transport factory that throws is acked and does not poison the source queue (0.186ms)
✔ close clears timers and transports, and later messages do nothing (0.0984ms)
ℹ tests 16
ℹ suites 0
ℹ pass 16
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 80.6213
EXIT=0
```

The red that forced the alignment, before my first edit (same command, same tree):

```text
ℹ tests 15
ℹ pass 2
ℹ fail 13
  actual: { t: 'ack', source: 'youtube', id: 'act-1', ok: false, error: 'unknown-source' }
  actual: { t: 'ack', source: 'youtube', id: 'clear', ok: false, error: 'unknown-source' }
  actual: [ [ 'a', false, 'unknown-source' ], [ 'b', false, 'unknown-source' ] ]
$ node -e "import('./packages/web-discord-rpc/config.js').then(m=>console.log(Object.keys(m.SOURCE_META)))"
[ 'youtube-music' ]
```

The new test can go red. On a throwaway copy at
`C:\Users\nathan\AppData\Local\Temp\opencode\wdr-red` (the repo was not modified), I inserted
`if (entry.lastActivity !== undefined) return;` at the top of `reconnect()` in
`native/host.mjs`, so the reconnect succeeds and never resends:

```text
$ node --test --test-name-pattern "resent after a Discord IPC" .../wdr-red/test/native/host.test.mjs
mutated: reconnect connects, never resends
ℹ tests 1
ℹ pass 0
ℹ fail 1
  AssertionError [ERR_ASSERTION]: the retained activity is sent again
  actual: [ { name: 'Muse', type: 2, details: 'New Born', state: 'Origin of Symmetry' } ],
```

The copy was deleted afterwards. `git diff --stat` for my file: 155 changed lines, all inside
`packages/web-discord-rpc/test/native/host.test.mjs`.

The commit also stands on its own, without the neighbour seam's uncommitted `config.js`. A
detached worktree at the commit, run the same way:

```text
$ git worktree add --detach .../wdr-head HEAD   # HEAD is the commit handed back
$ node --test packages/web-discord-rpc/test/native/host.test.mjs
ℹ tests 16
ℹ pass 16
ℹ fail 0
EXIT=0
$ git worktree remove --force .../wdr-head
```

## Unverified

- That the lead wants `host.test.mjs` aligned to a Music-only `SOURCE_META`. The change is
  measured, not assumed: the check could not exit 0 while `youtube` was a literal in this file
  and `config.js` no longer knew that source. The roster assertion is now derived from
  `SOURCE_META`, and the file is green both at the commit alone (old two-source `config.js`) and
  in the current working tree (Music-only `config.js`), so a revert of that neighbour edit does
  not strand this commit. What I could not make independent: if `youtube-music` itself is ever
  renamed or removed from `SOURCE_META`, every `source:` literal here goes red — correct, since
  the host would have no source left to publish for.
- That the concurrent Music-only seam is finished. `config.js`, `activity.js`, `background.js`
  and `extract-youtube.js` were already modified in the working tree when I started; I read
  only `config.js`'s `SOURCE_META` and `DEFAULT_CLIENT_ID`, and committed none of them.
- Real pipe behaviour. The test drives `createIpcClient` with a fake; the actual
  `DiscordIpcClient` close/reconnect path is covered only by `--selftest` and
  `test/integration/ipc-e2e.test.mjs`, which I did not run (not the brief's Check).

## Scope

- `packages/web-discord-rpc/test/native/host.test.mjs` — inside Owns. Added the
  `makeFakeIpcClients` helper and the reconnect test; renamed the source literal from `youtube`
  to `youtube-music`, collapsed the two-source assertions that the Music-only source table makes
  unsatisfiable, and derived the connecting-announcement roster from `SOURCE_META`.
- `.stack/reports/music-discord-reconnect.md` — outside Owns, but mandated by the brief's
  Report section; the only other path written.
- Not touched: `packages/web-discord-rpc/native/**`, `test/extension/**`, `config.js`,
  `activity.js`, `.stack/digest.md`, `.stack/ledger.md`. No commit includes another seam's work.

## Lesson

Run the brief's Check before writing a line. This file arrived 13/15 red because a neighbour
seam had already made `config.js` Music-only and the source literal `youtube` was dead, while
the brief described only an addition. In an exclusive-ownership file that red is yours to fix,
even when the cause is someone else's diff: align first, watch the suite go green, and only then
add the new case — otherwise you cannot tell your own regression from the inherited one. Prove
the new case can fail on a copy outside the repo; that keeps `native/**` untouched while still
showing the check is not a tautology.
