# Architecture

How one Crunchyroll tab becomes a Discord activity, what crosses each boundary, and where the limits are.

## Data flow

```
Crunchyroll tab
  → content.js (extract.js)              read DOM + mediaSession, report flat state
  → background.js (merge per tab, throttle)   one record per tab, 4 sends / 20 s
  → native host (host.mjs → ipc.mjs)      validate, frame, speak Discord IPC
  → \\.\pipe\discord-ipc-N                local named pipe, N = 0..9
  → Discord                               SET_ACTIVITY, type 3 (WATCHING)
```

Chrome starts the host as a child process through the registered `host.cmd`. Chrome native messaging frames carry `uint32LE length | JSON` on stdin and stdout. stdout carries protocol messages only; diagnostics go to stderr.

`background.js` imports `config.js` for `HOST_NAME` and the client id: the effective client id is `resolveClientId(stored)`, which is `DEFAULT_CLIENT_ID` when nothing valid is stored, so a fresh install publishes under the built-in application with no paste step.

## Components

| Component | Runs in | Job |
| --- | --- | --- |
| `extension\extract.js` | content script, every frame | pure extraction from a document/navigator pair; never throws |
| `extension\content.js` | content script, every frame | report `crp-state` on media events, URL changes and visibility changes |
| `extension\background.js` | MV3 service worker | keep per-tab state, pick one activity, throttle, own the native port and reconnect |
| `extension\options.js` / `popup.js` | extension pages | Application ID, synopsis option, status, diagnostics, enable toggle, current buttons |
| `native\host.mjs` | Node child of Chrome | message loop, Discord handshake, activity forwarding, retry |
| `native\ipc.mjs` | Node | both framings, pipe scan, `SET_ACTIVITY` request/reply, rate guard |
| `native\protocol.mjs` | Node | message and activity validation shared with the tests |

## Message contract

Extension → host:

| `t` | Fields | Meaning |
| --- | --- | --- |
| `hello` | `clientId` (17–19 digit string) | open the Discord handshake for this application |
| `activity` | `activity` (object or `null`), optional `id` | set or clear presence; `null` clears |
| `ping` | — | liveness; the host answers `pong` |

Host → extension:

| `t` | Fields | Meaning |
| --- | --- | --- |
| `status` | `state: "connected"`, `appName`, `user` | handshake succeeded, or an activity was accepted |
| `status` | `state: "error"`, `detail`, `code` | handshake or validation failed |
| `ack` | `id`, `ok: true`, `appName` | one activity frame was accepted |
| `ack` | `id`, `ok: false`, `error` | one activity frame was rejected |
| `pong` | — | reply to `ping` |

## Activity shape

The host sends this as `SET_ACTIVITY` with `args: { pid, activity }`. Everything except `type` is optional; `null` instead of an object clears presence.

| Field | Value | Limit |
| --- | --- | --- |
| `type` | `3` (WATCHING) | must be exactly 3 |
| `details` | series name, else episode title; with a synopsis, ``<series> · S1 E5`` when both numbers are known | ≤ 128 characters |
| `state` | smart-truncated synopsis when one is shown, else `S1 E5 · 12:34 / 24:00` | ≤ 128 characters |
| `timestamps.start` | now − position, epoch ms | integer, end > start |
| `timestamps.end` | now + (duration − position), epoch ms | integer |
| `assets.large_image` | Crunchyroll artwork `https` URL, or a Discord asset key | non-empty |
| `assets.large_text` | episode title, else series | ≤ 128 characters |
| `buttons` | `Watch Episode` → episode URL, `View Series` → series URL; a lone episode link is labelled `Watch on Crunchyroll` | ≤ 2, label ≤ 32, url https Crunchyroll |

Timestamps are only attached while `paused` is explicitly `false` and a duration is known. Discord renders elapsed and remaining from that pair; a paused activity carries no timer. When the synopsis option is on and a synopsis exists, it replaces the timer line but the timestamps stay attached. Without a synopsis the phase-1 layout is unchanged. Buttons are only attached for `https` `crunchyroll.com` URLs; when neither direct link exists, the phase-1 `pageUrl` button is used. Smart truncation fits 128 characters by cutting at the last sentence end (`. `/`! `/`? `), else the last space, strips a dangling `·`/`,`/space and appends `…` only when text was cut.

## Framing

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

## Rate guard

- At most 4 activity sends per rolling 20 s, at two layers: the service worker's coalescing limiter and the host client's guarded sender.
- Coalescing keeps the newest payload; older deferred payloads are dropped, never queued as a backlog.
- The host only counts successful `SET_ACTIVITY` replies toward the window; queued frames are flushed when the window frees.
- The worker drops a send when the serialized activity equals the last one sent, so a steady page does not spend the budget.

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
- A report with neither a video nor real metadata is ignored by the content script; `crp-gone` removes the tab's record.
- Across tabs, a playing tab beats a paused one; ties go to the most recently updated tab.
- A tab is eligible when it has a video and is either playing or on screen. A paused tab that is hidden stops counting.
- The service worker recomputes the single activity after every report, tab close, wake or reconnect.

## Recovery

| Failure | Behaviour |
| --- | --- |
| Native port dies | worker reconnects with backoff from 500 ms to 8 s |
| Discord IPC pipe drops | host client reconnects from 250 ms to 5 s and republishes the last activity |
| Discord is not running yet | host retries the handshake from 1 s to 30 s, then keeps the last activity for replay |
| Service worker sleeps | a 30 s `alarms` watchdog wakes it, reopens the port and pings |
| Page is a SPA navigation | the content script sends `crp-gone`, waits 300 ms for the new page, then reports again |

## Limitations

| Limit | Effect |
| --- | --- |
| DRM | The encrypted stream is never inspected; only element state is read. Presence is metadata plus a timer, not a capture. |
| Ads | An ad break has a video but no episode metadata, so presence can drop to the generic line or clear until the episode resumes. |
| Redesigns | Selectors are layered with generic fallbacks, but a Crunchyroll markup change can still blank fields until `RULES` in `extract.js` is updated. |
| Local only | No account, no sync, no history. Presence exists only while this machine runs Chrome, the host and Discord. |
| Chrome only | The manifest targets Chrome 156+ on Windows. Edge and Brave registry keys are written by the shared installer but are not part of the documented setup. |
| Sleep | A sleeping tab stops producing events; the watchdog can reconnect but cannot invent playback state. |
| Unknown pages | A Crunchyroll page with no video and no metadata reports nothing, so the activity clears rather than guessing. |
