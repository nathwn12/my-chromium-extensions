# Changelog

Notable changes to this package. Dates are ISO 8601. This package is local-only and is not published to a registry.

## [1.1.6] - 2026-11-11

- A queued update is dropped when the port dies, and the pacing docs no longer promise more than the poll can detect.

## [1.1.5] - 2026-11-11

- A queued update is dropped when the desired card returns to the published one or when the port dies, so a payload queued for a state that is no longer true is never sent later. Two edges remain: a rate change the player never reports can mask or delay one drift report until the next poll, and buffering can still produce a single report.
- The drift check respects the reported playback rate and stays quiet while buffering, so playback that has not actually moved no longer churns the card.

## [1.1.4] - 2026-11-11

- Presence updates land within 1.5 s and a track change publishes immediately, replacing the old four-per-20-second budget that could delay a song switch by up to twenty seconds.

## [1.1.3] - 2026-11-11

- A localized view count can no longer be read as the artist: the artist line comes only from artist anchors or MediaSession, never from an arbitrary byline segment.
- The cover tooltip is only used when it says something the card does not, so a view count that repeats the visible lines is dropped.
- Every button target is shape-checked - a track URL must be a watch page with an 11-character id, an album URL a `/browse/MPRE` page, an artist URL a `/channel` page - and anything else is dropped rather than repointed.

## [1.1.2] — 2026-11-11

- The card carries no link fields and no underlined text: `details_url`, `state_url` and `large_url` are gone, so the track title, artist and album are plain text and the two buttons are the only click targets.
- The cover tooltip falls back to the YouTube Music view count when the player bar reports one and no distinct album exists, and still never repeats the track title.
- A view count is no longer mistaken for an album name.

## [1.1.1] - 2026-11-11

- Timestamps are anchored to the instant the position was sampled, so the progress bar never jumps or lags after a watchdog tick or a Discord reconnect.

## [1.1.0] - 2026-11-11

- The activity maps onto the official Spotify presence field for field: `details` is the track, `state` the artist anchors joined with `"; "`, `assets.large_image` the album art, `assets.large_text` the album while it is distinct, and there is no small image.
- The card carries four click targets: the track title opens the song, the artist line opens the artist channel, the album art opens the album, and two buttons cover the song and the album or artist channel.
- Start/end timestamps are sent as integer seconds, as the RPC endpoint expects; they were milliseconds before, which Discord read as a timer far in the future.

## [1.0.4] - 2026-11-11

- YouTube Music is the only reported source and the extension publishes to Discord desktop over IPC, with one persistent presence switch.
- Discord receives a static `YouTube Music` activity name, the track in `details`, the artist in `state`, and `status_display_type: 1`; tests prove the payload, not Discord's rendered member list.
- Elapsed/end timestamps use the real audio/video position and duration, and are omitted when either is unavailable.

## [1.0.3] - 2026-11-11

- The popup now names a YouTube Music track with its artist and album (`artist — album`), and Settings reads the whole row as `title — artist — album`; YouTube rows still read the title and channel only.

## [1.0.2] - 2026-11-11

- The YouTube Music card and status line now name the track artist when one resolved (Discord renders both from `activity.name`); the track stays in `details` and the album moves to `state`, so the artist is never repeated. Without an artist the card keeps the `YouTube Music` label and the old state.

## [1.0.1] - 2026-11-11

- Presence reaches Discord while the connection is still being set up: the worker hands desired activities to the host when it is `connecting` or `waiting` instead of only once connected, so a running Discord no longer leaves the status stuck at Waiting. The host announces itself on `hello`, and a missing desktop pipe reads "Discord is not running" rather than "Waiting for Discord to respond".
- YouTube Music is detected from any `music.youtube.com` page as soon as a title resolves, with no watch id required (it is null there); YouTube still requires a watch id.
- Docs are corrected to match, and assertions guard both claims.

## [1.0.0] - 2026-11-10

- You can now see YouTube and YouTube Music in Discord at the same time: watching a video shows a WATCHING card titled YouTube, listening shows a LISTENING card titled YouTube Music, and one app install covers both.
- Discord desktop is the default: presence goes to the installed app over its local socket. The arRPC/Vencord (Discord Web) route stays selectable as `auto` or `arrpc` and is deferred, not used automatically.
- A fresh install works with no setup: the built-in app is used unless you saved your own 17–20 digit application ID, which you can clear at any time to go back.
- If Discord is unreachable, the status reads Waiting with a plain explanation instead of an error; only a rejected application ID needs you to act.
- Your tabs stay private: nothing leaves this machine except Discord's own presence traffic, artwork is only handed to Discord as a link, and the video stream itself is never touched.
- If presence never appears: start the Discord desktop app (or arRPC for the web path), re-run the host installer with `--check`, and reload the extension.
