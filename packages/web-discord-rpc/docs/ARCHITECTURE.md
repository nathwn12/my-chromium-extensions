# Architecture

How a YouTube tab becomes two Discord activities, what crosses each boundary, and where the limits are. Dated 2026-11-10.

## Data flow

```
YouTube / YouTube Music tab
  → content.js (extract-youtube.js)    read DOM + mediaSession, report flat state
  → background.js (per source, 4/20 s) one record per tab per source, two budgets
  → native host (host.mjs)             default `ipc`: Discord desktop pipe, per source
                                       `auto`: IPC first, arRPC fallback
  → local Discord pipe                \\.\pipe\discord-ipc-N, N = 0..9 (default; may itself be owned by arRPC when the desktop app is absent)
  → arRPC WebSocket                    127.0.0.1:6463-6472 (deferred, only with `auto` or `arrpc`; Vencord bridge)
  → Discord                            SET_ACTIVITY, type 3 (YouTube) + type 2 (Music)
```

Chrome starts the host as a child process through the registered `host.cmd`. Chrome native messaging frames carry `uint32LE length | JSON` on stdin and stdout; stdout carries protocol messages only, diagnostics go to stderr. The host keeps one client per source plus the last activity per source and resends it after a reconnect.

`background.js` imports `config.js` for `HOST_NAME` (`com.nathwn12.web_discord_rpc`) and the client id: the effective id is `resolveClientId(stored)`, which is `DEFAULT_CLIENT_ID` (`1566530911514923188`) when nothing valid is stored, so a fresh install publishes under the built-in application with no paste step.

## Components

| Component | Runs in | Job |
| --- | --- | --- |
| `extract-youtube.js` | content script, classic (Chrome cannot load content scripts as modules) | pure extraction from a document/navigator/location triple; never throws; exposes `globalThis.YoutubeExtract` |
| `content.js` | content script, top frame only | report `wdr-state` on media events (never `timeupdate`), SPA navigation, visibility, pagehide; 1 s URL/title/pause poll; `wdr-gone` with `scope: "tab"` |
| `background.js` | MV3 service worker (module) | per-source tab maps, `pickBestTab`, per-source 4/20 s coalescing limiters, one native port, reconnect with backoff, `storage.session` tab restore |
| `activity.js` | worker import | one activity per source state; text caps, source-hosted button, timestamp maths |
| `config.js` | worker + host import | identity, transports, source meta, `sourceForUrl`/`resolveClientId`/`clientIdToPersist`/`resolveTransport`/`resolveEnabled` |
| `bridge-status.js` | worker + host + surfaces | availability/bridge vocabulary, `classifyBridgeFailure`, friendly copy, `presentStatus`/`presentSources` |
| `native/host.mjs` | Node child of Chrome | one client per source, transport selection per `hello`, activity queue, acks, reconnect republish, `--selftest` |
| `native/ipc.mjs` | Node | Discord desktop IPC framing, pipe scan, handshake, nonce-matched `SET_ACTIVITY` |
| `native/arrpc.mjs` | Node | arRPC WebSocket client, port probe, READY gate, nonce-matched `SET_ACTIVITY` |
| `native/native-framing.mjs` | Node | Chrome stdio framing: `uint32LE length | UTF-8 JSON`, 1 MiB cap |
| `scripts/install-host.mjs` | Node, run by the user | writes `host.cmd` + manifest under `%LOCALAPPDATA%\web-discord-rpc`, registers Chrome/Edge/Brave |

## Message contract

Extension → host:

| `t` | Fields | Meaning |
| --- | --- | --- |
| `hello` | `clientId` (17–20 digit string), `version: 1`, `transport: "auto" \| "ipc" \| "arrpc"` | open the Discord path for this application; missing `transport` means `auto` on a legacy caller |
| `activity` | `source: "youtube" \| "youtube-music"`, `id`, `activity` (object or `null`) | set or clear one source's presence; `null` clears |
| `ping` | — | liveness; the host answers `pong` |

Host → extension:

| `t` | Fields | Meaning |
| --- | --- | --- |
| `status` | `state: "connected" \| "waiting" \| "error"`, `transport: "discord-ipc" \| "arrpc" \| "mixed"`, `reason`, `detail`, `sources: { youtube, youtube-music }` | handshake result or transport absence; `detail` is diagnostic only |
| `ack` | `source`, `id`, `ok: true` | one activity frame was accepted |
| `ack` | `source`, `id`, `ok: false`, `error` | one activity frame was not delivered (`transport-unavailable`, `arrpc-unavailable`, `rejected`, `unknown-source`) |
| `pong` | — | reply to `ping` |

`reason` is one of `discord-closed | arrpc-closed | host-missing | rejected | hung`. `transport` names what the host actually used; the stored preference (`auto | ipc | arrpc`, default `ipc`) is a different vocabulary and never appears on the wire. Before any `hello` the host reports the legacy arRPC path.

## Availability and bridge state

Two axes, deliberately separate (shared with the surfaces via `bridge-status.js`):

| Axis | Values | Meaning |
| --- | --- | --- |
| Availability | `unknown`, `available`, `unavailable` | whether presence can reach Discord at all |
| Bridge | `idle`, `connecting`, `connected`, `waiting`, `error` | what the native port is doing |

`classifyBridgeFailure` maps raw diagnostics to reasons: arRPC absence (`no arrpc`, `ECONNREFUSED`/`ECONNRESET` on loopback) → `arrpc-closed`; Chrome failing to launch the host → `host-missing`; `invalid client id` / handshake rejection → `rejected`; connect/handshake/pong timeouts and a dropped pipe → `hung`. Only `rejected` (fatal) and a hang exhausted after `HUNG_RETRY_LIMIT` (3) consecutive pong timeouts become `error`. A sync `connectNative` throw and an async host-missing disconnect collapse to the same `host-missing` waiting state.

The enable toggle is always operable (`storage.local` key `enabled`, default on). Turning presence off posts an explicit clear for every source straight down the port, past the send budget, then drops the port and stays down.

## Activity shape

The host sends one `SET_ACTIVITY` per source connection as `{cmd: "SET_ACTIVITY", args: {pid, activity}, nonce}` with `pid = process.pid`. Everything except `type` is optional; `null` instead of an object clears that source.

| Field | Value | Limit |
| --- | --- | --- |
| `name` | `YouTube` or `YouTube Music` | overrides the Discord application label |
| `type` | `3` (YouTube WATCHING), `2` (Music LISTENING) | must be exactly the source's type |
| `details` | video/track title | 2–128 chars, whitespace-collapsed |
| `state` | channel/artist, or `channel — album` on Music | 2–128 chars |
| `timestamps.start` | `floor(now/1000)*1000 − floor(position)*1000` | integer epoch ms, whole seconds |
| `timestamps.end` | `start + floor(duration)*1000`, position clamped to `[0, duration]` | integer, `end > start` |
| `assets.large_image` | page `https` artwork URL | omitted without one |
| `assets.large_text` | album or title | ≤ 128 chars |
| `buttons` | one: `Watch on YouTube` / `Listen on YouTube Music` → page URL | ≤ 1 here, label ≤ 32, url `https` on the source host, ≤ 512 |

Timestamps attach only while `paused` is explicitly `false` and duration is positive. `buildActivity` returns `null` without a showable title. Because timestamps are second-quantised, an unchanged position second yields identical bytes and the worker dedupe (`lastSent`) holds the budget.

## Framing

Discord IPC frame, both directions:

```
uint32LE opcode | uint32LE length | UTF-8 JSON
```

| Opcode | Name | Use |
| --- | --- | --- |
| 0 | HANDSHAKE | `{v: 1, client_id}`, answered by a `READY` dispatch |
| 1 | FRAME | `SET_ACTIVITY` request and its reply, matched by `nonce` |
| 2 | CLOSE | Discord is closing the connection |
| 3 / 4 | PING / PONG | transport keepalive, answered in kind |

The IPC client scans `\\.\pipe\discord-ipc-0` through `-9` in order and stops at the first pipe that completes a handshake. An answering pipe is usually the Discord desktop app, but when the desktop app is absent arRPC itself can own the pipe (live probe 2026-11-10: `discord-ipc-0` answered with `user: "arrpc"`), so IPC-first can carry Discord Web traffic without the WebSocket fallback. A forced `arrpc` always uses `ws://127.0.0.1:<port>/?v=1&client_id=<id>` and never touches the pipes. Both decoders reassemble partial reads. Caps: 1 MiB per native message, 8 MiB per Discord frame.

arRPC frame: plain JSON text over `ws://127.0.0.1:<port>/?v=1&client_id=<id>`. The client probes `6463–6472` in order, accepts only a `READY` whose `data.user` is the arRPC mock user (id `1045800378228281345`, username `arrpc`), sends `SET_ACTIVITY`, and matches the reply by `nonce`. `WDR_ARRPC_PORTS` / `WDR_DISCORD_PIPES` override the probe sets for integration runs only.

## Rate guard

- At most 4 ordinary sends per rolling 20 s **per source** at the worker's coalescing limiter; the host IPC client keeps a 5/20 s backstop so bursts are not double-throttled. A null clear is not special-cased in the limiter here: clears flow through the same per-source budget, while reconnect replays bypass it.
- Coalescing keeps the newest payload; older deferred payloads are dropped, never queued.
- The worker drops a send when the serialized activity equals the last one sent (`lastSent`), so a steady page spends nothing; second-quantised timestamps make the comparison hit.
- A rejected ack records the rejection without latching the bridge to `error` (a slow connect acks `arrpc-unavailable` while the handshake is still in flight).
- The tab map is mirrored into `chrome.storage.session` (`wdrTabs`); an MV3 suspension restores it, and only sources the previous session actually published get an explicit clear on startup.

## Extraction layers

`extract-youtube.js` never throws; every field is nullable. Caps: text 256 chars here (the activity builder enforces 128), URLs 1024 chars here (buttons enforce 512).

| Order | Layer | Reads | Fills |
| --- | --- | --- | --- |
| 1 | `mediaSession` | `navigator.mediaSession.metadata`: `title`, `artist`/`album`, `artwork` (largest area wins) | title, channel, album, artwork |
| 2 | JSON-LD | `script[type="application/ld+json"]` with `VideoObject`/`MusicRecording`: `name`, `author`, `thumbnailUrl`/`image`, ISO-8601 `duration` | title, channel, artwork, duration |
| 3 | DOM | YouTube: `h1.ytd-watch-metadata yt-formatted-string`, `#owner #channel-name a`, `meta[property="og:image"]`; Music: `ytmusic-player-bar .title/.byline/img` | title, channel, album, artwork |
| 4 | Open Graph | `meta[property="og:title"]` | title text |
| 5 | Document title | `<title>` minus ` - YouTube Music` / ` - YouTube` / ` | YouTube` suffixes | title fallback |

Eligibility: the URL must be `https:` on a YouTube host **and** carry a watch media id (`?v=` 11-char id, or `/shorts|embed|live|v/` path). Otherwise `read` returns `null` and the content script clears the tab. Only the `video` element contributes playback fields (`currentTime`, `duration`, `paused`, `playbackRate`).

Precedence (verified in `extract-youtube.js`): YouTube prefers DOM title → session → JSON-LD → OG → document title, with `og:image` beating the lower-resolution MediaSession art; Music prefers session → DOM → JSON-LD → OG → document title, with session art first.

## Frames and per-source merge

The content script runs with `all_frames: true` but only the top frame may report; a subframe's state would overwrite the tab's real activity. The worker keys state by `sender.tab.id` per source:

- One record per tab per source: `{state, at, rankAt}`. The newest report wins the tab.
- `wdr-gone` with `scope: "tab"` deletes the whole tab entry at once (pagehide, non-watch navigation: `content.js` sends it when the URL stops being a watch URL). Tab close deletes the entry via `tabs.onRemoved` → the worker's `handleTabRemoved` path.
- Across tabs for one source, a playing tab beats a paused one; ties go to the newest report. A title that is not showable (under 2 chars after cleanup) never wins.
- A tab that has not reported for 30 min (`TAB_TTL_MS`) is treated as closed.
- The worker recomputes the desired activity after every report, tab close, alarm, reconnect, or storage change. `push` sends through the source limiter only when the bridge is `connected`; otherwise the desired value waits and the next `status connected` replays it.

## Recovery

| Failure | Behaviour |
| --- | --- |
| Native port dies | worker reconnects with backoff 500 ms → 8 s, resets each limiter, replays desired state; bridge shows `waiting` |
| Discord desktop pipe drops | per-source IPC client reports `discord-closed`, rearms the reconnect only when a last activity exists |
| Discord not running, `auto` selected | `auto` probes the pipes first (which may themselves be arRPC-owned), then falls back to the arRPC WebSocket; all absent → `status waiting` with the primary reason; the native loop never crashes |
| Discord not running, default `ipc` | no fallback: the pipe scan finds nothing, the host stays `waiting` and keeps retrying on reconnect |
| Forced transport absent | no fallback: `ipc` without pipes (or `arrpc` without a listener) acks `transport-unavailable`/`arrpc-unavailable` and stays `waiting` |
| Host stops ponging | a ping with no pong for 10 s (`PONG_TIMEOUT_MS`) drops the port and reconnects; only 3 consecutive timeouts become `error` |
| Service worker sleeps | 30 s `alarms` watchdog reopens the port and pings; the tab map survives in `storage.session` |
| Page is SPA navigation | content script settles 250 ms after the URL change, then reports; same-URL re-renders report at once |
| Hello with unknown transport | rejected before any client is built (`ack`-level `rejected`, no probe) |

## Limitations

| Limit | Effect |
| --- | --- |
| DRM | The encrypted stream is never inspected; only element state is read. Presence is metadata plus a timer, not a capture. |
| Redesigns | Selectors are layered with generic fallbacks, but a YouTube markup change can still blank fields until `RULES` in `extract-youtube.js` is updated. |
| Local only | No account, no sync, no history. Presence exists only while this machine runs Chrome, the host, and Discord or arRPC. |
| Shorts/embeds | Any URL with a media id is eligible, including Shorts and embeds; there is no watch-only filter beyond the id. |
| Sleep | A sleeping tab stops producing events; the 1 s poll and the 30 s watchdog restore state on wake. |
| Unknown pages | A page with no media id reports nothing, so the activity clears rather than guessing. |
