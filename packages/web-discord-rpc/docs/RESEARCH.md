# Research notes

Dated findings behind the protocol and selector choices. Dates are ISO 8601.

`UNVERIFIED here` means this seam did not re-observe the claim; the dated source or the contracts record is quoted instead. Where a page was read, the quoted words were present in the fetched text.

## Evidence

| Date | Claim | Source | Status |
| --- | --- | --- | --- |
| 2026-11-10 | arRPC 3.7.0 listens on `127.0.0.1:6463-6472` (first free) and the test bridge on `1337`. | `.stack/contracts.md` (lead intake) | UNVERIFIED here (recorded by the lead; this seam ran no listener) |
| 2026-11-10 | A WebSocket client with no `Origin` is accepted. Node's global `WebSocket` sends none. | `.stack/contracts.md`; `native/arrpc.mjs` (no `Origin` header is set) | Verified in the code named |
| 2026-11-10 | Two arRPC WebSocket connections get distinct `socketId` values and each `SET_ACTIVITY` keeps its `type`. | `.stack/contracts.md` | UNVERIFIED here (live bridge proof recorded by the lead, not re-run) |
| 2026-11-10 | `SET_ACTIVITY` frame: `{cmd: "SET_ACTIVITY", args: {pid, activity}, nonce}`. | `packages/web-discord-rpc/native/arrpc.mjs`, `native/ipc.mjs` | Verified in the code named |
| 2026-11-10 | arRPC sends `{cmd: "DISPATCH", evt: "READY", data: {v: 1, ...}}` on connect; the mock user is `1045800378228281345` / `arrpc`. | `native/arrpc.mjs` (`ARRPC_USER_ID`, `isArRpcUser`); `native/host.mjs --selftest` accepts only that READY | Verified: `node packages/web-discord-rpc/native/host.mjs --selftest` prints `PASS` on the READY/nonce checks |
| 2026-11-10 | The arRPC URL must carry `?v=1&client_id=<id>`: without it arRPC stamps `application_id: ""` and Vencord cannot resolve the app or its assets. | `.stack/contracts.md`; `native/arrpc.mjs` (query on the probe URL) | Verified in code; the Vencord failure itself is UNVERIFIED here (live bridge proof recorded by the lead) |
| 2026-11-10 | Vencord's `WebRichPresence (arRPC)` plugin forwards `{socketId, pid, activity}` to `LOCAL_ACTIVITY_UPDATE`. | `.stack/contracts.md` | UNVERIFIED here (lead record; no Vencord was read in this seam) |
| 2026-11-10 | Discord's web client reducer keys `LOCAL_ACTIVITY_UPDATE` by `socketId`; two connections stack two activities. | `.stack/contracts.md` | UNVERIFIED here (bundle reading recorded by the lead, not re-read) |
| 2026-11-10 | `activity.name` overrides the Discord application name. | `config.js` (`SOURCE_META` names) + `.stack/contracts.md` (`name: u.name ?? t.application.name`) | Verified in this repo's config; the Discord client expression is UNVERIFIED here |
| 2026-11-10 | `assets.large_image` may be an `https:` URL; Discord converts it to an `mp:` media-proxy asset. | `activity.js` (`httpsUrl` gate) + `.stack/contracts.md` | Code gate verified; the Discord conversion is UNVERIFIED here |
| 2026-11-10 | Activity types `2` LISTENING and `3` WATCHING; details/state/large_text 2–128; buttons max 2, label 1–32, url 1–512 https. | `activity.js` (`MAX_TEXT = 128`, label 32, url 512, types from `config.js`) | Verified in the code named |
| 2026-11-10 | `mediaSession` is readable from a content script and is the first metadata source; for YouTube, `og:image` (maxresdefault) beats the 320x180 MediaSession art; title selector `h1.ytd-watch-metadata yt-formatted-string`; channel selectors `#owner #channel-name a`, `ytd-channel-name a`. | `.stack/contracts.md` live probe `https://www.youtube.com/watch?v=aqz-KE-bpKQ` + `extract-youtube.js` `RULES.dom` | Selectors verified in `RULES`; the live page read is UNVERIFIED here (no browser probe was run in this seam) |
| 2026-11-10 | The actual `extract-youtube.js` evaluated in the page reads Big Buck Bunny (634.601 s) and a Music track (Despacito, 281.521 s) with title, channel, artwork, media id, duration, position, paused. | `.stack/contracts.md` live extractor proof | UNVERIFIED here (recorded by the lead; no page was loaded in this seam) |
| 2026-11-10 | Desktop IPC handshake `{v: 1, client_id}` opcode 0 against `\\.\pipe\discord-ipc-0..-9` returns READY and acks `SET_ACTIVITY` by nonce; one pipe per source stacks both activities. | `native/ipc.mjs` (`DISCORD_PIPES`, `encodeDiscordFrame`); `native/host.mjs --selftest` IPC checks | Verified: selftest prints `discord ipc handshake acks SET_ACTIVITY` PASS and `stacks two sources on two pipes` PASS |
| 2026-11-10 | Extension ID derivation is SHA-256 over the DER SPKI key, first 16 bytes nibble-mapped 0–f to a–p. `node packages/web-discord-rpc/scripts/extension-key.mjs --print` prints `mnmmfbjinpokfnendlbhbbdmfjidgikf` for the committed key. | `scripts/extension-key.mjs` | Verified in this repo (command output quoted in `docs/INSTALL.md`) |
| 2026-11-02 | `SET_ACTIVITY` accepts an activity object "limited to a type of Playing (0), Listening (2), Watching (3), or Competing (5)". This package sends only types 2 and 3. | https://docs.discord.com/developers/topics/rpc | UNVERIFIED here (carried from crunchy `docs/RESEARCH.md` 2026-11-02; not re-fetched) |
| 2026-11-02 | The manifest `key` "maintains the unique ID of an extension … when it is loaded during development". | https://developer.chrome.com/docs/extensions/reference/manifest/key | UNVERIFIED here (carried from crunchy `docs/RESEARCH.md`; not re-fetched) |

## Consequences recorded in the design

- Desktop IPC is primary, arRPC is the fallback; forced preferences never cross. The statuses and the `mixed` transport follow from that order.
- One application ID serves both cards because `name` overrides the label; the ID itself is public and grants nothing.
- The `client_id` query on every arRPC probe is not optional: it is what lets arRPC and Vencord attribute the activity.
- `og:image` is preferred over MediaSession art on YouTube because the live probe showed it is higher resolution.
- The extractor never throws and the worker never trusts a non-`https` URL, so a hostile page cannot inject a button target.
