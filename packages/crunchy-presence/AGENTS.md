# Repository rules

This package is a local-only tool: one MV3 extension, one Node native messaging host, no service. A change that breaks a rule here is rejected even when it works.

## Shape

- **No build step.** The package root loads unpacked exactly as committed (`manifest.json` is at the package root — there is no `extension\` folder); `native\` and `scripts\` run from source. Do not add bundlers, transpilers, or generated artifacts.
- **No dependencies.** `package.json` has no `dependencies` or `devDependencies`; the workspace's single lockfile is `bun.lock` at the repo root. Use the Node standard library.
- **Plain ES modules.** `.mjs` in `native\` and `scripts\`, and `"type": "module"` for `.js`. The content scripts are the exception: Chrome cannot load them as modules, so `extract.js` exposes `globalThis.CrunchyrollExtract` and `content.js` is an IIFE.
- **The worker is an ES module with same-folder imports only.** `background.js` runs with `"type": "module"` and imports `config.js`; its imports stay plain modules in the same folder, never a package or a build step.
- **MV3 only.** `manifest_version: 3`, a service worker, and the permissions already declared. Do not add a permission without a documented need.
- **Native messaging is the only extension-to-host transport.** No gateway WebSocket in the extension, no `discord-rpc` dependency, no HTTP. Host-to-Discord is Discord IPC primary with arRPC fallback (owner ruling 2026-11-10); no third transport. The native host writes to `\\.\pipe\discord-ipc-N` first and reaches `127.0.0.1:6463-6472` (arRPC) only when no desktop pipe answers.
- **Local only.** No account, no server, no telemetry, no network request from the extension. The host makes none on the desktop path and only opens a loopback WebSocket to `127.0.0.1` for the arRPC fallback. Artwork URLs are passed to Discord, which fetches them.

## Contracts

- Message envelopes and activity validation live in `native\protocol.mjs`. The extension and the host must agree with it: change it once, then update `docs\ARCHITECTURE.md`.
- `type` is always `3` (WATCHING). `details` and `state` cap at 128 characters, buttons at 2, timestamps are epoch milliseconds.
- Selectors, regexes and caps live in `RULES` in `extract.js`. Add a selector there, not inline in the extractor body.
- The extension ID is derived from the `key` in `manifest.json`. Never regenerate or remove it: the installed native host's `allowed_origins` names that ID.
- `scripts\install-host.mjs` and `scripts\uninstall-host.mjs` own the registry entries. Do not write `HKCU` keys by hand in another script.

## Checks

Every claim in a change description carries the command that produced it. Run at least:

| Command | Proves |
| --- | --- |
| `node --test test/` | extraction, framing, rate guard, manifest shape |
| `node native/host.mjs --selftest` | host round trip against a fake Discord pipe |
| `node scripts/install-host.mjs --check` | host files and registry entries are in place |
| `node scripts/extension-key.mjs --print` | the manifest key still derives one stable extension ID |

A change to protocol validation, framing, extraction or the rate guard needs a test that fails on the old code and passes on the new code. "It works in Chrome" is not a check.

## Changes

- Tests first for behaviour changes. A bug fix names the failing case in `test\` before the fix lands.
- `CHANGELOG.md` gets one bullet under `## [Unreleased]`. A code change does not move a version, cut a dated heading, or edit `version` in `manifest.json`.
- Update `docs\ARCHITECTURE.md` in the same change when a message shape, selector layer, or limit changes. Documentation that contradicts the code is a defect.
- Keep `README.md` free of absolute paths, machine names and unverified claims.

## Never

- Never publish this package. It is `"private": true` and installs by unpacked load only.
- Never add a third Discord transport, a background updater, or an analytics hook. Discord IPC (primary) plus arRPC (fallback) is the closed set.
- Never store a Discord token. An Application ID is public and is the only credential involved.
- Never inspect or capture the DRM media stream; read element state only.
