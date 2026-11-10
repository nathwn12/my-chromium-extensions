## Outcome

Created `packages/web-discord-rpc` as a stable-key MV3 scaffold: `manifest.json` (name Web Discord RPC, version 1.0.0, extension id `mnmmfbjinpokfnendlbhbbdmfjidgikf`), `config.js` implementing the contracts identity (`HOST_NAME`, `DEFAULT_CLIENT_ID`, `SOURCE_META`, `sourceForUrl`, `resolveClientId`, `clientIdToPersist`), `scripts/install-host.mjs` + `scripts/uninstall-host.mjs` + `scripts/extension-key.mjs` adapted from crunchy-presence to the `com.nathwn12.web_discord_rpc` host and `%LOCALAPPDATA%\web-discord-rpc` dir, five real PNG icons (16/24/32/48/128), and four unit-test files. Background, activity, content, popup, options, and native files are intentionally absent; they belong to later seams, and the manifest already declares their slots so no manifest edit is needed later.

## Evidence

Command (exit 0):

```text
node --test packages/web-discord-rpc/test/extension/config.test.mjs packages/web-discord-rpc/test/extension/manifest.test.mjs packages/web-discord-rpc/test/scripts/install-host.test.mjs packages/web-discord-rpc/test/scripts/extension-key.test.mjs
```

Output at the handed-back head:

```text
✔ the built-in application ID is a real ID the native host accepts (1.476ms)
✔ HOST_NAME is the native messaging host the installer registers (0.0977ms)
✔ source constants and metadata cover YouTube and YouTube Music only (0.5067ms)
✔ sourceForUrl maps YouTube hosts and rejects everything else (0.1645ms)
✔ resolveClientId falls back to the built-in for missing or malformed values (0.1418ms)
✔ resolveClientId keeps a valid stored override, trimmed (0.0919ms)
✔ clientIdToPersist saves an override, clears for empty/built-in, rejects junk (0.1182ms)
✔ manifest is MV3 with the expected identity (0.7341ms)
✔ manifest requires Chrome 120, expressed as a major version (0.1047ms)
✔ manifest key decodes to the stable extension ID the native host allows (0.7657ms)
✔ permissions stay minimal and host access is YouTube only (0.4814ms)
✔ content script covers YouTube and YouTube Music in every frame at document_idle (0.1263ms)
✔ service worker, popup and options page are declared as local files (0.5399ms)
✔ no remote code anywhere in the manifest or its HTML (0.2389ms)
✔ icons are declared at 16/32/48/128 and shipped at 16/24/32/48/128 as real PNGs (0.8692ms)
✔ derives the fixture extension id from its SPKI key (1.2612ms)
✔ deriveIdFromManifest reads the key and reports a missing one (6.7896ms)
✔ ensureKey never overwrites an existing key (2.3643ms)
✔ ensureKey generates a 2048-bit key once and preserves the rest of the manifest (35.2856ms)
✔ --print emits the id on its own line (49.8729ms)
✔ the shipped manifest key derives the pinned extension id (0.3362ms)
✔ installer targets the web-discord-rpc host under its own install dir (0.6629ms)
✔ host manifest and launcher are built from absolute paths (0.9727ms)
✔ registry argv pins the default value to the host manifest (0.0978ms)
✔ installHost writes both files and registers all three browsers (8.5851ms)
✔ installHost --check writes nothing and reports a missing install (2.662ms)
✔ verifyHost fails when a registry default points somewhere else (4.1103ms)
ℹ tests 27
ℹ suites 0
ℹ pass 27
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 188.2975
```

The check goes red without the fix: the negative cases are live assertions, not skips — `installHost --check` on an empty dir returns `ok:false`, `verifyHost` against a diverted registry default fails all three browser checks, `deriveIdFromManifest` on a keyless manifest returns `ok:false`, and the pinned-id test fails if the manifest key is ever regenerated.

## Unverified

- Unpacked load in Chrome (`chrome://extensions` with the package dir): not run; no browser here. The manifest declares `background.js`, `popup.html`, and `options.html`, which do not exist yet, so Chrome will warn until the owning seams land them.
- Real `reg add/query` on Windows: installer logic ran only against the in-memory fake registry; `node scripts/install-host.mjs --check` on this machine was not run because the host files are not installed.
- Icon artwork quality: PNG dimensions, magic, bit depth, and colour type are asserted, but visual appearance was not inspected.

## Scope

All paths inside Owns, none outside:

- `packages/web-discord-rpc/manifest.json` (created, key generated once via `scripts/extension-key.mjs --print`)
- `packages/web-discord-rpc/package.json` (created)
- `packages/web-discord-rpc/config.js` (created)
- `packages/web-discord-rpc/scripts/install-host.mjs` (created, from crunchy-presence with host/dir/description renamed)
- `packages/web-discord-rpc/scripts/uninstall-host.mjs` (created, usage string renamed)
- `packages/web-discord-rpc/scripts/extension-key.mjs` (created, verbatim copy; path-derived `REPO_ROOT` needs no change)
- `packages/web-discord-rpc/icons/icon16.png`, `icon24.png`, `icon32.png`, `icon48.png`, `icon128.png` (created, deterministic generator output)
- `packages/web-discord-rpc/test/extension/config.test.mjs` (created)
- `packages/web-discord-rpc/test/extension/manifest.test.mjs` (created)
- `packages/web-discord-rpc/test/scripts/install-host.test.mjs` (created)
- `packages/web-discord-rpc/test/scripts/extension-key.test.mjs` (created)

`git status` shows no modification outside `packages/web-discord-rpc/` and this report (`.stack/ledger.md` was already modified before this seam started).

## Lesson

The manifest has to declare the slots for files other seams own (background, content scripts, popup, options) up front, because no other seam may touch `manifest.json` — so the scaffold's manifest test must assert JSON shape only for those entries and reserve existence assertions for the icons this seam ships. That keeps the check green now and still green when the later seams land their files with no manifest edit.
