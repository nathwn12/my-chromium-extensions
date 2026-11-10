# Architecture

How one Crunchyroll tab becomes a Discord activity, what crosses each boundary, and where the limits are.

## Data flow

```
Crunchyroll tab
  → content.js (extract.js)              read DOM + mediaSession, report flat state
  → background.js (merge per tab, throttle)   one record per tab, 4 ordinary sends / 20 s (null clears bypass uncounted)
  → native host (host.mjs → ipc.mjs, arrpc.mjs) validate, frame, speak Discord IPC first, arRPC fallback
  → \\.\pipe\discord-ipc-N                local named pipe, N = 0..9 (primary; may itself be owned by arRPC when the desktop app is absent)
  → arRPC WebSocket                        127.0.0.1:6463-6472 (fallback; Vencord bridge)
  → Discord                               SET_ACTIVITY, type 3 (WATCHING)
```

Chrome starts the host as a child process through the registered `host.cmd`. Chrome native messaging frames carry `uint32LE length | JSON` on stdin and stdout. stdout carries protocol messages only; diagnostics go to stderr.

`background.js` imports `config.js` for `HOST_NAME` and the client id: the effective client id is `resolveClientId(stored)`, which is `DEFAULT_CLIENT_ID` when nothing valid is stored, so a fresh install publishes under the built-in application with no paste step.

## Components

| Component | Runs in | Job |
| --- | --- | --- |
| `extract.js` | content script, every frame | pure extraction from a document/navigator pair; never throws |
| `content.js` | content script, every frame | report `crp-state` on media events (no `timeupdate`), URL changes, visibility changes, bfcache `pageshow` restores, plus a 30 s keepalive while a video exists |
| `background.js` | MV3 service worker | keep per-tab state, pick one activity, throttle, own the native port and reconnect |
| `options.js` / `popup.js` | extension pages | Application ID, synopsis option, status, diagnostics, enable toggle, current buttons |
| `native\host.mjs` | Node child of Chrome | message loop, Discord IPC first with arRPC fallback per `hello`, activity forwarding, retry |
| `native\ipc.mjs` | Node | Discord IPC framing, pipe scan, `SET_ACTIVITY` request/reply, rate guard |
| `native\arrpc.mjs` | Node | arRPC WebSocket client, port probe, READY gate on the mock user, nonce-matched `SET_ACTIVITY` |
| `native\protocol.mjs` | Node | message and activity validation shared with the tests |

## Message contract

Extension → host:

| `t` | Fields | Meaning |
| --- | --- | --- |
| `hello` | `clientId` (17–20 digit string), `transport: "auto" \| "ipc" \| "arrpc"` | open the Discord handshake for this application; missing `transport` means `"auto"` |
| `activity` | `activity` (object or `null`), optional `id` | set or clear presence; `null` clears |
| `ping` | — | liveness; the host answers `pong` |

Host → extension:

| `t` | Fields | Meaning |
| --- | --- | --- |
| `status` | `state: "connected"`, `transport: "discord-ipc" \| "arrpc"`, `appName`, `user` | handshake succeeded, or an activity was accepted |
| `status` | `state: "waiting"`, `transport`, `reason`, `detail` | expected absence: Discord desktop closed, arRPC bridge absent, host missing, or a transient timeout; `detail` is diagnostic only |
| `status` | `state: "error"`, `detail`, `code`, `fatal` | a failure; `fatal: true` is only a permanent handshake rejection (bad application ID) |
| `ack` | `id`, `ok: true`, `appName` | one activity frame was accepted |
| `ack` | `id`, `ok: false`, `error` | one activity frame was rejected (`transport-unavailable`, `arrpc-unavailable`, `rejected`) |
| `pong` | — | reply to `ping` |

`reason` is one of `discord-closed`, `arrpc-closed`, `host-missing`, `rejected`, `hung`.
`detail` keeps the raw diagnostic (a pipe name, `ENOENT`, a handshake code) for
the options diagnostics; the popup and options status card render a separate
friendly sentence and never show `detail`.

## Availability and bridge state

Two axes, deliberately separate:

| Axis | Values | Meaning |
| --- | --- | --- |
| Availability | `unknown`, `available`, `unavailable` | whether presence can reach Discord at all |
| Bridge | `idle`, `connecting`, `connected`, `disconnected`, `waiting`, `error` | what the native port is doing |

`bridge-status.js` is the single classifier and label table for both the worker
and the two surfaces. Only `rejected` (bad application ID) and a host still
hung after three consecutive pong timeouts map to `error`. `discord-closed`,
`arrpc-closed`, `host-missing`, a connect/handshake timeout and a dropped pipe all map to
`waiting` with no error. An arRPC probe failure (`ECONNREFUSED`/`ECONNRESET` on loopback, `no arrpc`) maps to `arrpc-closed` before it can read as `discord-closed`. A sync `connectNative` throw and an async host-missing
disconnect collapse to the same `host-missing` waiting state. The raw string is
never deleted: `lastError` keeps it for logs and the copyable diagnostics.

The enable toggle is always operable. Turning presence off is never blocked by
Discord's absence, and the null clear is posted to the host even while the
bridge is waiting so a stale episode is not republished when Discord returns.

## Activity shape

The host sends this as `SET_ACTIVITY` with `args: { pid, activity }`. Everything except `type` is optional; `null` instead of an object clears presence.

| Field | Value | Limit |
| --- | --- | --- |
| `type` | `3` (WATCHING) | must be exactly 3 |
| `details` | series name, else episode title; with a synopsis, ``<series> · S1 E5`` when both numbers are known | ≤ 128 characters |
| `state` | smart-truncated synopsis when one is shown, else `S1 E5 · 12:34 / 24:00` | ≤ 128 characters |
| `timestamps.start` | now - position, epoch ms, both floored to whole seconds so an unchanged position second yields identical bytes and the worker dedupe fires | integer, end > start |
| `timestamps.end` | now + (duration - position), epoch ms, same second quantisation | integer |
| `assets.large_image` | Crunchyroll artwork `https` URL, or a Discord asset key | non-empty |
| `assets.large_text` | episode title, else series | ≤ 128 characters |
| `buttons` | `Watch Episode` → episode URL, `View Series` → series URL; a lone episode link is labelled `Watch on Crunchyroll` | ≤ 2, label ≤ 32, url https Crunchyroll |

Timestamps are only attached while `paused` is explicitly `false` and a duration is known. Discord renders elapsed and remaining from that pair; a paused activity carries no timer. The synopsis option is opt-in and off by default; when it is on and a synopsis exists, it replaces the timer line but the timestamps stay attached. Without the option the phase-1 layout is unchanged, so a spoiler never appears unexpectedly. Buttons are only attached for `https` `crunchyroll.com` URLs; when neither direct link exists, the phase-1 `pageUrl` button is used. Smart truncation fits 128 characters by cutting at the last sentence end (`. `/`! `/`? `), else the last space, strips a dangling `·`/`,`/space and appends `…` only when text was cut.

## Framing

Discord IPC over the desktop pipe is the primary transport; arRPC is the optional web fallback for Discord in a browser. There is no third transport.

Discord IPC frame, both directions:

```
uint32LE opcode | uint32LE length | UTF-8 JSON
```

| Opcode | Name | Use |
| --- | --- | --- |
| 0 | HANDSHAKE | `{ v: 1, client_id }`, answered by a `READY` dispatch |
| 1 | FRAME | `SET_ACTIVITY` request and its reply, matched by `nonce` |
| 2 | CLOSE | Discord is closing the connection |
| 3 / 4 | PING / PONG | transport keepalive, answered in kind |

The host scans `\\.\pipe\discord-ipc-0` through `-9` in order and stops at the first pipe that completes a handshake. Both decoders reassemble partial reads, so a frame split at any byte boundary is decoded exactly once. Caps: 1 MiB per native message, 8 MiB per Discord frame.

arRPC frame: plain JSON text over `ws://127.0.0.1:<port>/?v=1&client_id=<id>`. The client probes `6463–6472` in order, accepts only a `READY` whose `data.user` is the arRPC mock user (id `1045800378228281345`, username `arrpc`), sends `SET_ACTIVITY`, and matches the reply by `nonce`. No `Origin` header is set. Forced `ipc` never touches the network; forced `arrpc` always uses this WebSocket and never touches the pipes; `auto` (the default when `hello` omits `transport`) tries the pipes first and only reaches arRPC when no pipe answers — and an answering pipe may itself be owned by arRPC when the desktop app is absent, so IPC-first can carry Discord Web traffic too.

## Rate guard

- At most 4 ordinary activity sends per rolling 20 s at the service worker's coalescing limiter, which is the binding guard; the host keeps a backstop of 5 per 20 s so a burst is not double-throttled. A null clear bypasses the bucket on both sides — it is sent immediately and never counted — so the window holds at most 4 ordinary sends plus clears, inside Discord's 5/20 s.
- In normal use play, pause, seek and clear each land sub-second: the content script sends no `timeupdate` reports, so position drift never spends the budget, and only a fifth ordinary update inside the same 20 s window is coalesced (deferred to the window edge, newest wins).
- Coalescing keeps the newest payload; older deferred payloads are dropped, never queued as a backlog.
- A payload that cannot send while the bridge is offline is stashed (null included) and flushed on the next connected status or ack. A rejected ack resets the send dedupe and re-pushes with bounded backoff (1 s, 2 s, 4 s, max 3), after which the watchdog recovers.
- The host only counts successful `SET_ACTIVITY` replies toward the window; queued frames are flushed when the window frees, a flush with the pipe down reschedules instead of stranding the payload, and a rejected flush is kept and retried with backoff until it sends or a newer payload supersedes it. Queued sends ack `{ok: true, queued: true}` so the extension never latches an error for an accepted delivery.
- The worker drops a send when the serialized activity equals the last one sent, so a steady page does not spend the budget; timestamps are second-quantised so the comparison can hit. The status payload carries `lastSent` (what the port last accepted) alongside the desired `lastActivity`, and the popup renders `lastSent`.

## Extraction layers

The video element is read first for playback state. Metadata then follows first-non-null-wins in the order below; each field is nullable and a malformed page yields nulls, never an exception.

| Order | Layer | Reads | Fills |
| --- | --- | --- | --- |
| 1 | `mediaSession` | `navigator.mediaSession.metadata`: `title`, `artist`/`album`, `artwork` | series, artwork, episode title (last fallback) |
| 2 | JSON-LD | `script[type="application/ld+json"]` with `VideoObject`, `TVEpisode` or `Episode`: `name`, `partOfSeries.name`/`@id`, `partOfSeason.@id`, `episodeNumber`, `url`/`@id`, `thumbnailUrl`/`image`, `duration` | episode title, series, season, episode, artwork, direct links, duration |
| 3 | Open Graph | `meta[property="og:image"]`, `meta[name="twitter:image"]`, `meta[property="og:title"]` | artwork, title text |
| 4 | Document title | `SxxExx`, `Season N Episode M`, `Ep N`; the series is the text before the match | season, episode, series |
| 5 | DOM | `#player-container video`, `h1.title`, `a > h4`, `a.show-title-link`; generic fallbacks `video`, `h1`/`h2`, `[data-testid]` | playback state, series/episode text |
| 6 | Watch URL | `/watch/<id>` in the page URL | eligibility signal only |

Only the video element contributes playback fields: `duration`, `currentTime`, `paused`, `playbackRate`. The media pipeline behind it is never touched.

### Episode title and duration

On a watch page the `h1` is the episode (`E1 - Alone and Lonesome`). The JSON-LD `VideoObject.name` is the clean title (`Alone and Lonesome`), while the `TVEpisode.name` repeats the series (`Darling in the FRANXX | E1 - Alone and Lonesome`); the raw composite never reaches `episodeTitle` while a cleaner source exists, and when it is the only source the leading `<series> | ` is removed. The order is watch-page `h1` → `VideoObject.name` → stripped `TVEpisode.name` → media-session title → `og:title` → DOM fallback.

`<video>.duration` wins whenever it is finite and positive. When no video reports one (a paywalled or flat page), the JSON-LD `VideoObject.duration` is parsed from ISO-8601 — `PT24M0.023999999999887223S` → `1440.024` seconds, rounded to whole milliseconds — so the state line still renders `S1 E1 · 0:00 / 24:00`. A video duration of `0` is treated as missing, never as truth.

### Direct links and synopsis

Three more nullable fields use their own layering, all absolute `https` only:

| Field | Layer order |
| --- | --- |
| `seriesUrl` | JSON-LD `partOfSeries.@id` → `partOfSeason.@id` → `a.show-title-link` href → nearest `a` ancestor of `a > h4` |
| `episodeUrl` | JSON-LD `TVEpisode.url`/`@id` → `link[rel=canonical]` → `meta[property="og:url"]` → the page `location.href` when it matches `/watch/` |
| `synopsis` | JSON-LD `description` (VideoObject) → `meta[property="og:description"]` → `meta[name="description"]` with the leading `Watch … on Crunchyroll.` clause stripped → `[class*="expandable-section"]` text |

A meta description carries the episode title before the synopsis, so that prefix is stripped rather than rejecting the whole string. Boilerplate text is discarded: any `Stream … Crunchyroll`, premium/sign-up upsell, terms/privacy/cookie consent text, comma-separated language lists, and anything under 40 characters. Surrounding quotes are stripped. The extractor keeps up to 1000 characters; `background.js` performs the 128-character smart truncation. `content.js` forwards these fields unchanged through its existing spread of the extract result.

## Frames and per-tab merge

The content script runs with `all_frames: true`, so the top page and the player frame both report. The worker keys state by `sender.tab.id`:

- One record per tab. The newest informative report from any frame in that tab becomes the tab's record.
- A report with neither a video nor real metadata is ignored by the content script; `crp-gone` carries a scope — `pagehide` sends `scope: "tab"` and deletes the whole tab entry at once, an SPA URL change sends `scope: "frame"` and drops just that frame (the entry is deleted only when no frames remain) so a still-playing iframe survives a top-frame navigation. A same-tab navigation away from Crunchyroll drops the entry via `tabs.onUpdated`, and a loading/discarded signal with no readable URL schedules a 1.5 s clear that any arriving `crp-state` cancels, so a reload never blanks.
- Across tabs, a playing tab beats a paused one; ties go to the most recently updated tab.
- A tab is eligible when it has a video and is either playing or on screen. A paused tab that is hidden stops counting.
- The service worker recomputes the single activity after every report, tab close, wake or reconnect.

## Recovery

| Failure | Behaviour |
| --- | --- |
| Native port dies | worker reconnects with backoff from 500 ms to 8 s, resets the coalescing window and replays the stashed payload; the bridge shows `waiting`, never a latched error |
| Discord IPC pipe drops | host client reconnects from 250 ms to 5 s, emits `waiting` immediately, and republishes the last activity on the next handshake |
| Discord is not running yet | `auto` tries the desktop pipes first, then the arRPC bridge; both absent emits `waiting` (`discord-closed` when no pipe answered, `arrpc-closed` when no listener answered). The host retries the handshake from 1 s to 30 s and emits `connected` on the first success, replaying the last activity with no user action |
| Forced transport absent | no fallback: `ipc` without pipes (or `arrpc` without a listener) acks `transport-unavailable`/`arrpc-unavailable` and stays `waiting` |
| Native host missing | both the sync throw and the async disconnect classify to `waiting` / `host-missing` with installer guidance; the worker keeps retrying |
| Host stops ponging | a ping with no pong for 10 s drops the port and reconnects; only three consecutive timeouts become an error |
| Service worker sleeps | a 30 s `alarms` watchdog wakes it, reopens the port and pings; the alarm is only created when absent so a reboot never resets the countdown. A restart suppresses the boot-time null publish until the first `crp-state` or 60 s after boot, so a restart never blanks a live presence while a closed site still clears. |
| Page is a SPA navigation | the content script sends `crp-gone`, waits 300 ms for the new page, then reports again; a same-tab navigation away from Crunchyroll deletes the tab entry at once; a bfcache restore reports again on `pageshow` |

## Limitations

| Limit | Effect |
| --- | --- |
| DRM | The encrypted stream is never inspected; only element state is read. Presence is metadata plus a timer, not a capture. |
| Ads | Smallest reliable ad signal: a playing video under 60 s whose duration is less than half the episode length this tab already reported. During that break the last episode card is frozen with no timer, so the ad never renders as advancing episode progress. A short episode or a missing prior duration never triggers it (safe false negative). |
| Redesigns | Selectors are layered with generic fallbacks, but a Crunchyroll markup change can still blank fields until `RULES` in `extract.js` is updated. |
| Local only | No account, no sync, no history. Presence exists only while this machine runs Chrome, the host and Discord. |
| Chrome only | The manifest targets Chrome 120+ on Windows. Edge and Brave registry keys are written by the shared installer but are not part of the documented setup. |
| Sleep | A sleeping tab stops producing events; a paused tab re-reports every 30 s so it survives the 120 s frame TTL, and the watchdog reconnects but cannot invent playback state. |
| Unknown pages | A Crunchyroll page with no video and no metadata reports nothing, so the activity clears rather than guessing. |
