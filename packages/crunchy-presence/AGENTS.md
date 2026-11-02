# Repository rules

This repository is a local-only tool: one MV3 extension, one Node native messaging host, no service. A change that breaks a rule here is rejected even when it works.

## Shape

- **No build step.** `extension\` loads unpacked exactly as committed; `native\` and `scripts\` run from source. Do not add bundlers, transpilers, or generated artifacts.
- **No npm dependencies.** `package.json` has no `dependencies` or `devDependencies`, and no lockfile is committed. Use the Node standard library.
- **Plain ES modules.** `.mjs` in `native\` and `scripts\`, and `"type": "module"` for `.js`. The content scripts are the exception: Chrome cannot load them as modules, so `extract.js` exposes `globalThis.CrunchyrollExtract` and `content.js` is an IIFE.
- **The worker is an ES module with same-folder imports only.** `background.js` runs with `"type": "module"` and imports `config.js`; its imports stay plain modules in the same folder, never a package or a build step.
- **MV3 only.** `manifest_version: 3`, a service worker, and the permissions already declared. Do not add a permission without a documented need.
- **Native messaging is the only Discord transport.** No gateway WebSocket, no `discord-rpc` dependency, no HTTP. The native host writes to `\\.\pipe\discord-ipc-N` and nothing else.
- **Local only.** No account, no server, no telemetry, no network request from the extension or the host. Artwork URLs are passed to Discord, which fetches them.

## Contracts

- Message envelopes and activity validation live in `native\protocol.mjs`. The extension and the host must agree with it: change it once, then update `docs\ARCHITECTURE.md`.
- `type` is always `3` (WATCHING). `details` and `state` cap at 128 characters, buttons at 2, timestamps are epoch milliseconds.
- Selectors, regexes and caps live in `RULES` in `extension\extract.js`. Add a selector there, not inline in the extractor body.
- The extension ID is derived from the `key` in `extension\manifest.json`. Never regenerate or remove it: the installed native host's `allowed_origins` names that ID.
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
- `CHANGELOG.md` gets one bullet under `## [Unreleased]`. A code change does not move a version, cut a dated heading, or edit `version` in `extension\manifest.json`.
- Update `docs\ARCHITECTURE.md` in the same change when a message shape, selector layer, or limit changes. Documentation that contradicts the code is a defect.
- Keep `README.md` free of absolute paths, machine names and unverified claims.

## Never

- Never publish this package. It is `"private": true` and installs by unpacked load only.
- Never add a second Discord transport, a background updater, or an analytics hook.
- Never store a Discord token. An Application ID is public and is the only credential involved.
- Never inspect or capture the DRM media stream; read element state only.
