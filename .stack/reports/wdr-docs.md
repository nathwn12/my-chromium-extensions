## Outcome

Finished the unfinished docs seam: kept the existing web README/CHANGELOG/docs and `test/docs.test.mjs`, added the missing arRPC mock-user ID to the web architecture doc, and amended the crunchy architecture, README, AGENTS, and changelog so IPC-primary with arRPC fallback and no third transport is stated the same everywhere. The docs-test contract now passes 9/9.

## Evidence

`node --test packages/web-discord-rpc/test/docs.test.mjs` (exit 0):

```text
✔ desktop-first setup names the desktop pipe before arRPC (1.6011ms)
✔ arRPC/Vencord fallback names the client_id query and the mock user (0.3793ms)
✔ two stacked activities keep their types and name overrides (0.3737ms)
✔ app-name override names the built-in id and the 17-20 digit rule (0.3737ms)
✔ privacy says local-only and no page modification (0.4686ms)
✔ troubleshooting maps absence to waiting, not error (0.4223ms)
✔ crunchy transport rule is amended: IPC primary, arRPC fallback, no third transport (0.879ms)
✔ changelogs speak to the reader with dates (0.3753ms)
✔ install doc quotes the real host name and extension id (1.5795ms)
ℹ tests 9
ℹ suites 0
ℹ pass 9
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 126.3102
```

Source checks behind the amended claims (all read from the artifact, 2026-11-10):

```text
packages/web-discord-rpc/native/arrpc.mjs: ARRPC_USER_ID = "1045800378228281345", ARRPC_USERNAME = "arrpc", ports 6463-6472, URL ws://127.0.0.1:<port>/?v=1&client_id=<id>, no Origin header
packages/crunchy-presence/native/arrpc.mjs: ARRPC_MOCK_USER_ID = '1045800378228281345', ports 6463-6472, URL ws://127.0.0.1:${port}/?v=1&client_id=${clientId}
packages/crunchy-presence/native/ipc.mjs: DISCORD_PIPES = \\.\pipe\discord-ipc-0..-9, opcodes 0/1/2/3/4, 1 MiB native cap, 8 MiB Discord cap
packages/crunchy-presence/native/host.mjs: missing transport means "auto" (IPC first, arRPC fallback); forced transports never fall back; status carries transport discord-ipc | arrpc; arrpc-closed reason emitted
packages/crunchy-presence/bridge-status.js: REASON includes arrpc-closed; /arrpc/i classifies to ARRPC_CLOSED before ENOENT/ECONNREFUSED reads as discord-closed
```

## Unverified

- Live Vencord forwarding (`socketId` → `LOCAL_ACTIVITY_UPDATE`, two connections stacking two activities) and the empty-`application_id` failure without the `client_id` query were proved live on 2026-11-10 and recorded in `.stack/contracts.md`; this seam re-observed neither and marks both `UNVERIFIED here` in the web README/RESEARCH and the crunchy README transport section.
- The 2026-11-02 Discord/Chrome doc quotes carried from crunchy `docs/RESEARCH.md` (activity types, external image URLs, manifest key) were not re-fetched; they are marked `UNVERIFIED here` in web `docs/RESEARCH.md`.
- The live YouTube page probe (Big Buck Buck Bunny / Despacito fields, `og:image` beating MediaSession art) is recorded in `.stack/contracts.md` and the `RULES.dom` selectors were verified in `extract-youtube.js`, but no browser probe ran in this seam; marked `UNVERIFIED here`.
- `docs/INSTALL.md` real outputs (`extension-key --print` → `mnmmfbjinpokfnendlbhbbdmfjidgikf`, `--selftest` 10/10 PASS tail, suite tail `tests 173, pass 173, fail 0`, `--check` JSON shape) quote the 2026-11-10 run recorded by the previous pass; this turn re-ran only the docs contract, not the installer/selftest/full suite.

## Scope

Touched, all inside Owns/Files:

- `packages/web-discord-rpc/docs/ARCHITECTURE.md` (added mock-user id `1045800378228281345` + `arrpc` username to the arRPC frame paragraph)
- `packages/crunchy-presence/docs/ARCHITECTURE.md` (data flow, components, hello/transport contract, arrpc-closed reason, arRPC framing, recovery rows)
- `packages/crunchy-presence/README.md` (intro + privacy now name the arRPC loopback fallback)
- `packages/crunchy-presence/AGENTS.md` (local-only rule now carves out the loopback arRPC WebSocket)
- `packages/crunchy-presence/CHANGELOG.md` (one reader-worded `[Unreleased]` bullet naming the fallback)
- Adopted as-is from the previous pass (verified, not reworded): `packages/web-discord-rpc/README.md`, `packages/web-discord-rpc/CHANGELOG.md`, `packages/web-discord-rpc/docs/RESEARCH.md`, `packages/web-discord-rpc/docs/INSTALL.md`, `packages/web-discord-rpc/test/docs.test.mjs`

Not touched: `packages/crunchy-presence/docs/RESEARCH.md` (no stale transport claim; left alone per smallest-change). Nothing outside Owns was read beyond the native sources needed to verify claims, and nothing outside Owns was edited.

## Lesson

A docs contract that names files and values turns "finish the docs" into a punch list: the three red assertions pointed at exactly the stale paragraphs (web ARCH mock user, crunchy ARCH transport, crunchy changelog fallback), and each fix was a one-line trace to `arrpc.mjs`/`host.mjs`/`bridge-status.js`. The recurring trap is the privacy one-liner — every new transport silently contradicts "no network requests", so the fallback seam must grep that sentence in README, AGENTS, and ARCHITECTURE together.
