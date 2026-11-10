# Install

Desktop-first install for Discord RPC. Dated 2026-11-11 (install and selftest receipts below are from 2026-11-10). Run from the repository root.

## What you need

- Windows 10 or 11.
- Chrome 120 or newer.
- Node 22 or newer (`node --version`).
- The Discord desktop app, signed in (the default `ipc` path). arRPC or Vencord with the arRPC plugin covers the deferred Discord Web path only.

## 1. Install the native host

```
node packages/web-discord-rpc/scripts/install-host.mjs
```

What it does: writes `%LOCALAPPDATA%\web-discord-rpc\host.cmd` and `host-manifest.json`, registers host name `com.nathwn12.web_discord_rpc` under Chrome, Edge, and Brave `NativeMessagingHosts` keys, and prints one PASS/FAIL line per check plus the extension ID.

Verify without writing:

```
node packages/web-discord-rpc/scripts/install-host.mjs --check
```

On a machine with the host installed every line says PASS. On a fresh machine the same command reports the missing files and registry keys (exit non-zero); the JSON shape for a missing install looks like this (hypothetical — the host is installed on this machine, see below):

```json
{"ok":false,"extensionId":"mnmmfbjinpokfnendlbhbbdmfjidgikf","checks":[{"name":"host.cmd","ok":false,"detail":"missing ...\\host.cmd"}]}
```

Add `--json` for the machine-readable form. The real check on 2026-11-10 against this machine passed 5/5 (`host.cmd`, manifest, Chrome/Edge/Brave registry), because the host was installed here (lead ruling recorded in `.stack/ledger.md`):

```text
PASS  host.cmd  C:\Users\nathan\AppData\Local\web-discord-rpc\host.cmd
PASS  host-manifest.json  chrome-extension://mnmmfbjinpokfnendlbhbbdmfjidgikf/
PASS  Chrome registry  HKCU\Software\Google\Chrome\NativeMessagingHosts\com.nathwn12.web_discord_rpc
PASS  Edge registry  HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.nathwn12.web_discord_rpc
PASS  Brave registry  HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.nathwn12.web_discord_rpc
```

## 2. Pin the extension ID

```
node packages/web-discord-rpc/scripts/extension-key.mjs --print
```

Real output on 2026-11-10:

```text
mnmmfbjinpokfnendlbhbbdmfjidgikf
```

The host manifest's `allowed_origins` names exactly `chrome-extension://mnmmfbjinpokfnendlbhbbdmfjidgikf/`. If the printed ID differs, the key in `manifest.json` changed and the host must be reinstalled.

## 3. Load the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked** → select `packages/web-discord-rpc`.

## 4. Start Discord desktop first, then open YouTube

1. Sign in to the Discord desktop app.
2. Keep the default `transport: "ipc"`: the host probes `\\.\pipe\discord-ipc-0` through `-9` and nothing else.
3. Select `auto` only if you want the deferred arRPC fallback after the pipes: it probes `127.0.0.1:6463-6472` when no pipe answers (start arRPC, or Vencord with `WebRichPresence (arRPC)`, for that path). Note the pipe itself may be owned by arRPC when the desktop app is absent — the live probe on 2026-11-10 found `\\.\pipe\discord-ipc-0` answering with `user: "arrpc"` — so IPC can carry Discord Web traffic without the WebSocket fallback.

Live receipt (lead probe 2026-11-10, connect only, no presence changed): `{"ok":true,"pipePath":"\\\\.\\pipe\\discord-ipc-0","user":"arrpc"}`. The probe order and the `client_id` query are verified in `native/host.mjs`, `native/ipc.mjs`, and `native/arrpc.mjs` and by the selftest below.

## 5. Prove the host without Discord

```
node packages/web-discord-rpc/native/host.mjs --selftest
```

Real output on 2026-11-10:

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

## 6. Run the suite

```
node --test packages/web-discord-rpc/test/
```

Real tail on 2026-11-10: `tests 173, pass 173, fail 0`.

## Remove

```
node packages/web-discord-rpc/scripts/uninstall-host.mjs
```

Then remove the extension from `chrome://extensions`.
