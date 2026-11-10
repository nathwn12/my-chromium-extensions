# Wave 4 briefs (draft)

## wdr-ui

Out: popup and options load from the manifest, render bridge + both source activities, toggle presence, choose auto|ipc|arrpc, save an application ID, show the install commands, and never load remote code.

Check: `node --test packages/web-discord-rpc/test/extension/ui.test.mjs`

Files:
- packages/web-discord-rpc/popup.html
- packages/web-discord-rpc/popup.css
- packages/web-discord-rpc/popup.js
- packages/web-discord-rpc/options.html
- packages/web-discord-rpc/options.css
- packages/web-discord-rpc/options.js
- packages/web-discord-rpc/test/extension/ui.test.mjs
- packages/web-discord-rpc/test/ui/helpers/fake-ui.mjs

Read: `.stack/contracts.md`, `packages/web-discord-rpc/config.js`, `packages/web-discord-rpc/bridge-status.js`, `packages/web-discord-rpc/background.js`, `packages/crunchy-presence/popup.html`, `packages/crunchy-presence/popup.js`, `packages/crunchy-presence/options.html`, `packages/crunchy-presence/options.js`, `packages/crunchy-presence/options.css`, `packages/crunchy-presence/test/extension/popup.test.mjs`.

Rules: `presentStatus`/`presentSources` from bridge-status; `resolveTransport`/`clientIdToPersist`/`resolveClientId` from config; `wdr-get-status` message; `storage.local` keys `enabled`, `transport`, `clientId`, `wdrStatus`; transport labels `auto` = Automatic (desktop first), `ipc` = Discord desktop, `arrpc` = Discord Web (arRPC). Show the chosen transport separately from the preference. No inline scripts, no remote assets. Accessible names, focus ring, `role="switch"`, `aria-live` status.

## wdr-docs

Out: dated, command-accurate docs for web-discord-rpc and the crunchy web transport, including desktop-first setup, arRPC/Vencord fallback, two stacked activities, app-name override, privacy, troubleshooting, and the amended crunchy AGENTS rule.

Check: `node --test packages/web-discord-rpc/test/docs.test.mjs`

Files:
- packages/web-discord-rpc/README.md
- packages/web-discord-rpc/CHANGELOG.md
- packages/web-discord-rpc/docs/ARCHITECTURE.md
- packages/web-discord-rpc/docs/RESEARCH.md
- packages/web-discord-rpc/docs/INSTALL.md
- packages/web-discord-rpc/test/docs.test.mjs
- packages/crunchy-presence/README.md
- packages/crunchy-presence/AGENTS.md
- packages/crunchy-presence/CHANGELOG.md
- packages/crunchy-presence/docs/ARCHITECTURE.md
- packages/crunchy-presence/docs/RESEARCH.md

Read: `.stack/contracts.md`, `.stack/goal.md`, the code and existing crunchy docs. Include the live evidence rows (arRPC socketIds, Discord bundle reducer, live extractor, live IPC handshake, live crunchy bridge). Mark anything not observed as `UNVERIFIED`. The crunchy AGENTS rule is amended by the owner's explicit instruction of 2026-11-10: native IPC is primary, arRPC is the fallback; no third transport.

## wdr-root

Out: root workspace, README, CI and release include web-discord-rpc; the package test script runs every test under test/; a verifier proves each wiring point.

Check: `node scripts/verify-integration.mjs && npm test --workspace=web-discord-rpc`

Files:
- package.json
- README.md
- .github/workflows/ci.yml
- .github/workflows/release.yml
- scripts/verify-integration.mjs
- packages/web-discord-rpc/package.json

Read: root `package.json`, `README.md`, `.github/workflows/*`, `scripts/run-tests.mjs`, `scripts/release.mjs`, web `package.json`, `.stack/contracts.md`.

Verifier asserts: root test script includes `--workspace=web-discord-rpc`; package test script is `node ../../scripts/run-tests.mjs test`; README has the Web Discord RPC row and arRPC/desktop install; CI has a `web-discord-rpc` job running tests + both selftests + both e2e scripts; release zips `packages/web-discord-rpc`. Exit 1 with named failures.

## wdr-e2e-arrpc

Out: a deterministic integration script starts a fake arRPC WebSocket on 6471, spawns the real native host with `WDR_ARRPC_PORTS=6471`, drives native frames for both sources, and proves two connections with type 3 and type 2 plus a clear.

Check: `node packages/web-discord-rpc/scripts/e2e-arrpc.mjs`

Files:
- packages/web-discord-rpc/scripts/e2e-arrpc.mjs
- packages/web-discord-rpc/test/integration/arrpc-e2e.test.mjs

Read: `.stack/contracts.md`, `native/host.mjs`, `native/arrpc.mjs`, `native/native-framing.mjs`, `test/native/arrpc.test.mjs`. Implement the RFC6455 handshake and text frames with Node `http` + `crypto`; no `ws` dependency. Bind 6471; if busy, print SKIP and exit 0. Also accept `--live` to use the real arRPC on 6463 and a bridge client on 1337, but the default check is the fake.
