# Architecture

Presence Suite keeps the two sources independent end to end and joins them only
at the native host.

## Surfaces

- `extract-youtube.js` and `content.js` are classic content scripts on
  `https://music.youtube.com/*`. The extractor exposes
  `globalThis.YoutubeExtract`; the content script reports
  `presence-state` / `presence-gone` frames for the `youtube-music` source.
- `sources/crunchy/extract.js` and `sources/crunchy/content.js` are the
  Crunchyroll adapters, loaded on `https://*.crunchyroll.com/*` in all frames.
  They expose `globalThis.CrunchyrollExtract` and report the same new message
  kinds for the `crunchy` source. The old `crp-*` names are not used.
- `sources/crunchy/activity.js` and `sources/crunchy/frame-merge.js` are
  ported pure helpers: the WATCHING payload builder and the per-tab frame merge
  that joins top-frame metadata to player-iframe video truth.

## Worker

`background.js` is an ES-module service worker. It keeps a tab map per
source, so a Crunchyroll iframe report can never overwrite a Music tab. On each
report it recomputes one desired activity per source, de-duplicates against the
last published payload and sends changes through a single coalescing limiter
over one native port. The watchdog alarm is named `presence-watchdog`.

Messages are `presence-state`, `presence-gone` and
`presence-get-status`; none collides with the single-site extensions' older
`ytmp-*` or `crp-*` names. The worker starts the native port with a hello
carrying the built-in ID and desktop IPC.

## Shared vocabulary

`config.js` owns identity: `HOST_NAME`, `SOURCE_META` (activity type,
display copy, trusted host and per-source application ID), URL-to-source
routing, client-ID validation and the per-source enabled map.
`bridge-status.js` is pure: the union of both source vocabularies, including
`disconnected`, `CHOSEN_TRANSPORT`, `presentSources`, and an enabled-aware
`presentStatus`. The worker, the native host, the popup and the options page
all import the same module, so a state cannot drift between them.

Raw native diagnostics stay in `status.detail` for the options diagnostics
block; the UI only renders the friendly copy from `bridge-status.js`.

## Storage

| Key | Area | Shape |
| --- | --- | --- |
| `enabled` | local | `{ crunchy: boolean, "youtube-music": boolean }` |
| `presenceStatus` | local + session | last published status, with `activities` and `hostSources` maps |
| `presenceTabs` | session | per-source tab snapshot |
| `clientId:<source>` | local | optional 17-20 digit override |

Old `crpStatus` and `ytmpStatus` records are not read or rewritten.
