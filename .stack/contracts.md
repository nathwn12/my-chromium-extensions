# Contracts — web-discord-rpc + crunchy web transport

Dated 2026-11-10. Every seam reads this file first. Where a seam's brief and this file disagree, this file wins for the shared boundary and the brief wins for the seam's own files.

## Proven transport facts

- arRPC 3.7.0 listens on `127.0.0.1:6463-6472` (first free) and the bridge on `1337`.
- A WebSocket client with no `Origin` is accepted. Node 26's global `WebSocket` sends none.
- Two arRPC WebSocket connections get distinct `socketId` values (`0`, `1`) and each `SET_ACTIVITY` keeps its `type`.
- `SET_ACTIVITY` frame: `{cmd:"SET_ACTIVITY", args:{pid, activity}, nonce}`.
- arRPC sends `{cmd:"DISPATCH", evt:"READY", data:{v:1,...}}` on connect. arRPC's mock user id is `1045800378228281345`, username `arrpc`.
- Vencord's `WebRichPresence (arRPC)` plugin forwards `{socketId, pid, activity}` to `LOCAL_ACTIVITY_UPDATE`.
- Discord's web client reducer keys `LOCAL_ACTIVITY_UPDATE` by `socketId`; two connections therefore stack two activities.
- `activity.name` overrides the Discord application name (`name: u.name ?? t.application.name`).
- `assets.large_image` may be an `https:` URL; Discord converts it to an `mp:` media-proxy asset. Vencord's `fetchAssetIds` handles the same conversion.
- Activity types: `2` LISTENING, `3` WATCHING. Details/state/large_text 2-128 chars. Buttons: max 2, label 1-32, url 1-512 https.

## Package layout (new)

```
packages/web-discord-rpc/
  manifest.json  package.json  config.js  activity.js  background.js
  bridge-status.js  content.js  extract-youtube.js
  popup.html  popup.css  popup.js  options.html  options.css  options.js
  icons/icon16.png icon24 icon32 icon48 icon128
  native/host.mjs  native/arrpc.mjs  native/native-framing.mjs
  scripts/install-host.mjs  scripts/uninstall-host.mjs  scripts/extension-key.mjs
  scripts/e2e-arrpc.mjs
  test/extension/*.test.mjs  test/native/*.test.mjs  test/integration/*.test.mjs
  README.md  CHANGELOG.md  docs/ARCHITECTURE.md  docs/RESEARCH.md  docs/INSTALL.md
```

## Identity

`config.js` exports:

```js
export const HOST_NAME = "com.nathwn12.web_discord_rpc";
export const DEFAULT_CLIENT_ID = "1566530911514923188";
export const SOURCE_YOUTUBE = "youtube";
export const SOURCE_YOUTUBE_MUSIC = "youtube-music";
export const SOURCE_META = Object.freeze({
  youtube: { type: 3, name: "YouTube", label: "YouTube", buttonLabel: "Watch on YouTube" },
  "youtube-music": { type: 2, name: "YouTube Music", label: "YouTube Music", buttonLabel: "Listen on YouTube Music" },
});
export function sourceForUrl(url) -> "youtube" | "youtube-music" | null
export function resolveClientId(stored) -> string
export function clientIdToPersist(input) -> string | null | undefined
```

`sourceForUrl` accepts only `https:` URLs. Hosts: `www.youtube.com`, `youtube.com`, `m.youtube.com` -> `youtube`; `music.youtube.com` -> `youtube-music`. Other hosts -> null.

## Content state

`extract-youtube.js` is a classic script exposing `globalThis.YoutubeExtract`:

```js
YoutubeExtract.sourceForLocation(loc) -> source|null
YoutubeExtract.read(doc, nav, loc) -> state|null
```

`state`:

```js
{
  title: string|null,        // required for an activity
  channel: string|null,
  album: string|null,        // YouTube Music only
  artworkUrl: string|null,   // https only
  pageUrl: string|null,      // https only, source host
  mediaId: string|null,      // YouTube video id
  duration: number|null,     // seconds
  position: number|null,     // seconds
  paused: boolean,
  playbackRate: number|null,
  visible: boolean
}
```

Rules: never throw; every field nullable; strip bidi/zero-width; collapse whitespace; cap text at 256 before the activity builder's 128. `paused` is `true` when no video exists. `visible` is `doc.visibilityState === "visible"`.

`content.js` sends:

```js
{ t: "wdr-state", source, state }         // state.at added by content (Date.now())
{ t: "wdr-gone", source, scope: "tab" }    // pagehide / non-watch navigation
```

Content reports on media events, SPA navigation (`yt-navigate-finish`, `yt-page-data-updated`), `popstate`, `visibilitychange`, and a 1 s URL/title/pause poll. It never reports `timeupdate`.

## Activity

`activity.js` exports `buildActivity(source, state, now = Date.now()) -> activity|null`.

```js
{
  name: "YouTube" | "YouTube Music",       // overrides the app label
  type: 3 | 2,
  details: "<title>",                      // 2..128
  state: "<channel or artist — album>",    // 2..128
  assets: { large_image: "<https artwork>", large_text: "<title or album>" },
  buttons: [{ label: "Watch on YouTube", url: "<https watch url>" }],
  timestamps: { start, end }               // epoch ms, only when playing and duration > 0
}
```

Rules: return null without `title`; omit `assets` without an https artwork URL; omit `buttons` without an allowed https URL (youtube.com / music.youtube.com, <=512 chars); timestamps use whole seconds, `start = floor(now/1000)*1000 - floor(position)*1000`, `end = start + floor(duration)*1000`, clamp position to `[0,duration]`, no timestamps when `paused !== false` or duration <= 0.

## Native messages

Extension -> host:

```js
{ t: "hello", clientId: "<17-20 digits>", version: 1, transport: "arrpc" }
{ t: "activity", source: "youtube"|"youtube-music", id: "<string>", activity: <activity>|null }
{ t: "ping" }
```

Host -> extension:

```js
{ t: "status", state: "connected"|"waiting"|"error", transport: "arrpc", reason: "<kind>", detail: "<raw>", sources: { youtube: "<state>", "youtube-music": "<state>" } }
{ t: "ack", source, id, ok: true }
{ t: "ack", source, id, ok: false, error: "<string>" }
{ t: "pong" }
```

`reason` kinds: `arrpc-closed`, `host-missing`, `rejected`, `hung`. Absence of arRPC is never `error`; only a rejected application id or an exhausted hang is.

## Host transport

`native/arrpc.mjs` exports `ArRpcClient`:

```js
new ArRpcClient({ clientId, source, logger, WebSocketImpl = globalThis.WebSocket, ports = ARRPC_PORTS, connectTimeoutMs = 1200, replyTimeoutMs = 5000 })
await client.connect() -> { ok: true, port, user }
await client.setActivity(activity|null) -> { ok: true }
client.close()
client.ready // boolean
client.port  // number|null
```

`connect()` probes ports in order. It accepts only a `READY` whose `data.user.id === "1045800378228281345"` or `data.user.username === "arrpc"`; anything else is closed and the next port tried. It sends one `SET_ACTIVITY` per source connection; `pid` is `process.pid`. It matches replies by `nonce`. On `close`, `ready` becomes false and `onClose` (if provided) fires. No Origin header is set.

`native/host.mjs` owns one `ArRpcClient` per source, created lazily on the first activity. It keeps the last activity per source and resends it after a reconnect. A failed connect returns `ack ok:false, error:"arrpc-unavailable"` and a `status waiting`; it never throws out of the native loop.

`native/native-framing.mjs` is the Chrome stdio framing: `uint32LE length | UTF-8 JSON`, with a decoder that reassembles partial reads and caps at 1 MiB.

## Crunchy transport

Crunchy's host chooses a transport per `hello`:

```js
{ t: "hello", clientId, transport: "auto" | "arrpc" | "ipc" }  // missing => "auto"
```

`auto` tries arRPC first (same `ArRpcClient` contract, one activity), then Discord IPC. `arrpc` never falls back. `ipc` is today's behaviour. The status frame gains `transport: "arrpc" | "discord-ipc"`. Existing message shapes and `type: 3` validation are unchanged.

## Test conventions

- `node --test` with `node:assert/strict`; no new runtime deps; `ws` is allowed only as a root devDependency for tests.
- Every module that touches `chrome` keeps pure helpers exported so tests import without a `chrome` global.
- DOM tests use a sandbox object (`{querySelector, ...}`), never a real browser.
- Native tests inject fake `WebSocket`, timers, and a fake arRPC server; no port binding in unit tests.
- Manifest tests read `manifest.json` and assert MV3, permissions, content-script matches, stable `key`.
- The integration script may bind ports 6463-6472 and 1337; it must skip cleanly with exit 0 and `SKIP` when a port is occupied by something other than its own process.
