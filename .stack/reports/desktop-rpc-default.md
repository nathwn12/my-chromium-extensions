# desktop-rpc-default report

## Outcome

Commit `c5bfab7` makes the extension desktop-only by default: `config.js` now exports `DEFAULT_TRANSPORT = "ipc"` and `resolveTransport` returns it for absent/unknown values; `auto` and `arrpc` remain selectable and are marked deferred. The display name is Discord RPC in the manifest, popup, options and docs; the package path, host name, storage keys and pinned extension ID are unchanged. The options list is ordered default-first (`ipc`, `auto`, `arrpc`).

## Evidence

At `c5bfab7`, exit 0:

```text
node --test packages/web-discord-rpc/test -> 205 pass, 0 fail
node packages/web-discord-rpc/native/host.mjs --selftest -> PASS (10/10)
node scripts/verify-integration.mjs -> 13/13 wiring points hold
```

Red first: 9 failures were observed before implementation, including the README old name, the boot desktop preference, the manifest identity and the options order.

## Unverified

- Root `README.md` still says "Three Chromium extensions" and carries stale versions (crunchy 1.0.1, slowed 1.0.3); a follow-up docs seam owns that.
- `scripts/install-host.mjs` and `native/host.mjs` still say "Web Discord RPC" in descriptive text; the generated host manifest description is stale.
- `background.js` initialises `transportPreference = TRANSPORT_AUTO` on the storage-read-throw edge; the normal path resolves `ipc`.
- No push.

## Scope

15 files, all inside the brief's Files: config, manifest, package description, popup/options markup, README, CHANGELOG, docs, and the config/background/ui/manifest/docs tests.

## Lesson

Changing a default means changing every fallback that can produce the old value. The normal path is `ipc`; an exception path that still says `auto` is the next turn's bug.
