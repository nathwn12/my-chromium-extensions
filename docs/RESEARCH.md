# Research notes

Dated findings behind the protocol and selector choices. Every source below was fetched on 2026-11-02 and every URL returned HTTP 200 to a HEAD request.

`UNVERIFIED` means this repository did not confirm the claim itself. Where a page was read, the quoted words were present in the fetched text.

## Why the selectors are layered

Crunchyroll's live DOM was Cloudflare-blocked to headless browsers on 2026-11-01, so no live selector sample exists in this repository. The DOM layer therefore comes from a maintained peer activity and is backed by four independent metadata layers (mediaSession, JSON-LD, Open Graph, document title). That is a deliberate response to missing primary evidence, not a preference.

## Evidence

| Date | Claim | Source | Status |
| --- | --- | --- | --- |
| 2026-11-02 | `SET_ACTIVITY` accepts an activity object "limited to a type of Playing (0), Listening (2), Watching (3), or Competing (5)". This project sends only type 3. | https://docs.discord.com/developers/topics/rpc | Verified in the page text |
| 2026-11-02 | External image URLs are valid for `assets.large_image` and `assets.small_image`: "You can set URLs for details, state, assets.large_image and assets.small_image in Rich Presence", and "Unlike uploaded assets, external URLs also support GIF, animated WebP, and AVIF." | https://docs.discord.com/developers/discord-social-sdk/development-guides/setting-rich-presence | Verified in the page text |
| 2026-11-02 | On Windows the native messaging host manifest is found through `HKEY_CURRENT_USER\SOFTWARE\Google\Chrome\NativeMessagingHosts\<name>`, whose default value is the manifest path, and "allowed_origins values can't contain wildcards." | https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging | Verified in the page text |
| 2026-11-02 | Chrome launches native hosts that are not `.exe` files through `cmd.exe` on Windows; the article covers the change in Chrome 115 and its reliability consequences. This is why the installer writes `host.cmd` with the current node path and the host script path. | https://textslashplain.com/2023/03/16/improving-native-message-host-reliability-on-windows/ | Verified in the page text (`cmd.exe`, 115.0.5789.0) |
| 2026-11-02 | The manifest `key` "maintains the unique ID of an extension … when it is loaded during development", so a fixed key keeps the ID stable for an unpacked load. | https://developer.chrome.com/docs/extensions/reference/manifest/key | Verified in the page text |
| 2026-11-02 | Extension ID derivation is implemented as SHA-256 over the DER-encoded SPKI public key, first 16 bytes, each nibble mapped 0–f to a–p. `node scripts/extension-key.mjs --print` prints `afghbfidjjlgnhaacaiiakmknffnmiom` for the committed key. | `scripts/extension-key.mjs` (implementation) | Derivation verified in this repo; that Chrome displays the same ID for this key is UNVERIFIED here (no unpacked load was exercised) |
| 2026-11-01, re-read 2026-11-02 | PreMiD's Crunchyroll activity queries `#player-container video` (fallback `video`), `a > h4`, `h1.title` and `.show-title-link`, and reads JSON-LD `episodeNumber` / `partOfSeason.seasonNumber`. Its `iframe.ts` forwards `currentTime`, `duration` and `paused` from the player frame. | https://github.com/PreMiD/Activities/tree/main/websites/C/Crunchyroll | Verified in `presence.ts` and `iframe.ts` |
| 2026-11-02 | The peer desktop publisher uses `discord-rpc` over IPC with `UPDATE_INTERVAL = 15000` and `TEXT_LIMIT = 128`, and reads schema.org metadata for its presence. | https://github.com/Zyhloh/Unofficial-Crunchyroll-For-Desktop | Verified in `src/main/discord.js` and the README |
| 2026-11-02 | Presence is attached to the Discord application identified by the `client_id` sent in the IPC handshake; Discord's `SET_ACTIVITY` reply carries the application name in `data.name`, which this host reports as the bridge's app name. | https://docs.discord.com/developers/topics/rpc | Reply field verified in `native/ipc.mjs`; the docs' wording of the `client_id` requirement is UNVERIFIED from the page text read here |
| 2026-11-01 | Crunchyroll's live DOM was behind a Cloudflare challenge for headless browsers, which is why the selector set is not sampled from a live page. | none | UNVERIFIED (reported by the 2026-11-01 research pass; not reproducible from this repository) |

## Consequences recorded in the design

- Type 3 is the only activity type the validator accepts; a type 0, 2 or 5 payload is rejected with an `ack` error rather than silently coerced.
- Artwork is sent as an `https` URL, never as an uploaded asset key, so the repository ships no Discord asset upload step.
- The host manifest names one exact `chrome-extension://<id>/` origin and the installer derives that ID from the committed key.
- The native host is a `.cmd` shim because Chrome launches non-exe hosts through `cmd.exe`; the shim pins the node executable used at install time.
- The peer publisher's 15 s update interval is the same order of magnitude as this project's 4-per-20 s guard, which is why the guard exists at two layers rather than one.
