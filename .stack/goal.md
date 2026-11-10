# Goal

## Out

`packages/web-discord-rpc` loads unpacked and publishes YouTube as WATCHING and YouTube Music as LISTENING to Discord Web through arRPC + Vencord as two simultaneous activities; `packages/crunchy-presence` can carry its existing Crunchyroll activity over arRPC as well as native Discord IPC, without regressing its current behaviour.

## Check

```
npm test
node packages/web-discord-rpc/native/host.mjs --selftest
node packages/crunchy-presence/native/host.mjs --selftest
node packages/web-discord-rpc/scripts/e2e-arrpc.mjs
```

All four can go red. The first three are deterministic. The fourth starts a local arRPC-compatible WebSocket pair, drives the native host through Chrome framing, and proves two distinct socketIds carry type 3 and type 2 activities to the bridge.

## Constraints

- MV3, unpacked load only; no store publish, no npm publish, no telemetry.
- No new runtime dependencies. Node 26 built-ins only in the native hosts; `ws` may be a devDependency for tests.
- One writer per file. Every source change is a seam with a brief.
- Localhost only: arRPC on `127.0.0.1:6463-6472`, bridge on `1337`.
- Existing crunchy-presence behaviour and tests must stay green.
- The extension name is `web-discord-rpc`; package path `packages/web-discord-rpc`.
- New extension covers YouTube and YouTube Music only. Crunchyroll stays in crunchy-presence.

## Budget

One session, at most ten live seams, no paid services, no owner credentials. Stop at green check plus auditor PASS, or on an owner gate.

## Assumption

- Node 26 ships a client `WebSocket` that sends no `Origin`, which arRPC accepts (proven live 2026-11-10: two connections produced socketIds 0 and 1 with types 3 and 2).
- Vencord's `WebRichPresence (arRPC)` forwards `socketId` to Discord's `LOCAL_ACTIVITY_UPDATE`, whose reducer keys by socketId (verified in the public Discord web bundle 2026-11-10).
- arRPC 3.7.0 keeps the activity `type` and broadcasts one message per socket.
- The built-in Discord application ID already used by crunchy-presence is valid and can be shared; `activity.name` overrides the displayed app label.
