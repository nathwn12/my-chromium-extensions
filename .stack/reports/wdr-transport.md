# wdr-transport — transport preference, enable toggle, startup clear

## Outcome

The extension half of transport selection now exists: `config.js` owns the preference vocabulary (`auto | ipc | arrpc`, `auto` by default, `resolveTransport` for stored values) and the enable flag (`enabled`, anything but a real `false` means on), `bridge-status.js` drops the lying `TRANSPORT = "arrpc"` constant and instead validates and carries what the host actually chose (`discord-ipc | arrpc | mixed`), and `background.js` sends the stored preference in `hello`, reconnects when it changes, opens no native port at all while presence is off (and clears both sources before closing it), and on start explicitly clears any source the previous session published that no restored tab claims.

The startup clear is deliberately narrow: it reads the persisted `wdrStatus` and only clears sources that had a non-null activity and have no live tab, so a fresh install sends nothing redundant and every existing preview test kept its frame counts.

## Evidence

Red first, before any implementation (the exports did not exist and `hello` still hard-coded `arrpc`):

```text
$ node --test packages/web-discord-rpc/test/extension/background.test.mjs packages/web-discord-rpc/test/extension/bridge-status.test.mjs packages/web-discord-rpc/test/extension/config.test.mjs
SyntaxError: The requested module '../../bridge-status.js' does not provide an export named 'CHOSEN_TRANSPORT'
SyntaxError: The requested module '../../config.js' does not provide an export named 'ENABLED_KEY'
AssertionError: actual: { t: 'hello', clientId: '1566530911514923188', version: 1, transport: 'arrpc' }
                expected: { ... transport: 'auto' }
AssertionError: actual: 'arrpc', expected: 'ipc'            # stored transport never reached hello
AssertionError: actual: undefined, expected: 'ipc'          # status had no transportPreference
AssertionError: only the stale source is cleared; actual: 0, expected: 1
AssertionError: one clear per source; actual: 0, expected: 2
Exit code: 1
```

Green at the head handed back (`b56222a`), the exact command from the brief:

```text
$ node --test packages/web-discord-rpc/test/extension/background.test.mjs packages/web-discord-rpc/test/extension/bridge-status.test.mjs packages/web-discord-rpc/test/extension/config.test.mjs
✔ boot opens one native port with the built-in application id and the auto transport preference
✔ a stored transport reaches hello and a change reconnects with the new preference
✔ an unknown stored transport falls back to auto in hello
✔ the status payload names the stored preference and the transport the host chose
✔ a start clears presence the last session published and has no tab for
✔ a start with nothing published last time sends no clear
✔ a corrupt persisted status is ignored, never thrown
✔ a restored tab wins over a stale published activity for the same source
✔ enabled:false opens no port, and a watchdog tick does not open one either
✔ turning presence off clears both sources, closes the port and stays closed
✔ turning presence back on reconnects and replays the desired state
ℹ tests 51
ℹ pass 51
ℹ fail 0
EXIT=0
```

Whole extension suite, same tree:

```text
$ node --test packages/web-discord-rpc/test/extension
ℹ tests 97
ℹ pass 97
ℹ fail 0
EXIT=0
```

## Unverified

- **No live host, no live Discord.** Every frame is asserted against the fake chrome port in `background.test.mjs`; nobody has run the extension unpacked against `native/host.mjs` and watched Discord show or clear an activity. The startup clear is proven as an `activity: null` frame, not as a pixel disappearing from Discord.
- **The startup clear depends on the persisted `wdrStatus` being the last true state.** If `storage.local` was never written (fresh install, or local storage cleared while Discord still holds an activity), there is nothing to clear from and this seam does nothing — by design, but it means the guarantee is "clear what this extension knows it published", not "clear anything on Discord".
- **The enable toggle has no UI.** `options.html` / `popup.html` are named by `manifest.json` but do not exist and are not in my Files; the toggle is honoured for the keys `transport` and `enabled`, and an options seam still has to write them. No accessible name or focus order is claimed because no control was shipped.
- **A disabled worker sends no clear on boot.** It opens no port, so the host never sees a frame; I rely on the provider clearing a closed socket. Not measured against Discord desktop or arRPC.
- **`host.test.mjs` is red in this worktree** (`SyntaxError: Illegal return statement` inside `packages/web-discord-rpc/native/host.mjs`, a file owned by the concurrent `wdr-ipc` seam and mid-edit). Not mine, not fixed, not touched:
  `$ node --test packages/web-discord-rpc/test/native/host.test.mjs` → `SyntaxError: Illegal return statement` → exit 1. Its in-flight text already accepts `auto|ipc|arrpc` and publishes a chosen transport, which is the contract my hello now relies on.

## Scope

Six paths, all inside Owns and Files, all in commit `b56222a`:

- `packages/web-discord-rpc/config.js` — `TRANSPORTS`/`TRANSPORT_AUTO|IPC|ARRPC`, `TRANSPORT_KEY`, `ENABLED_KEY`, `resolveTransport`, `resolveEnabled`.
- `packages/web-discord-rpc/bridge-status.js` — removed the `TRANSPORT = "arrpc"` constant (it conflated preference with outcome), added `CHOSEN_TRANSPORT(S)` + `chosenTransportOf`, `transport` on `STATUS_DEFAULT` and through `bridgeStatusOf`.
- `packages/web-discord-rpc/background.js` — preference/enable state, `hello` carries the preference, storage-change reconnect (only on a real change), enable toggle with `clearPresence`/`setEnabled`, `ensurePort`/`scheduleReconnect`/`reconnect` gated on it, `stalePresenceOf` + `clearSource` at start, `transportPreference`/`transport` in the status payload.
- the three test files, with new cases for each of the above.

Nothing outside these six paths was edited. The report itself is a `.stack` file and is left uncommitted for the lead, as with the other seam reports. No merge, no push, no dispatch.

## Lesson

Two vocabularies were wearing one name. `transport: "arrpc"` was being used both as "the preference to send" and as "the outcome the host reported", which is why a stored option could never reach `hello` without someone noticing it changed the status too — the moment you add `auto`, a single field can no longer be both. Keep the preference (`auto|ipc|arrpc`, stored) and the outcome (`discord-ipc|arrpc|mixed`, reported) as separate validated fields, and let a pure `bridgeStatusOf` carry the outcome so a status surface never has to guess. And when a brief says "clear stale presence on startup", resist clearing everything: read what the last session actually published and clear only the sources nothing restored, because an unconditional clear costs a frame on every start and rewrites the meaning of every test that counts frames.
