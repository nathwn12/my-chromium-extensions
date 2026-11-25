# Changelog

Notable changes to this package. Dates are ISO 8601. This package is local-only and is not published to a registry.

## [1.1.16] - 2026-11-25

- A changed total is published only with an owned reset: a playhead at or near zero, or a coherent source new to the last published sample. An owned first read publishes at once, so a genuinely fresh new duration is never held forever; a new source at the old total stays blocked.
- A mid-song total under the same source cannot be told apart from ingested stale timing and fails closed at the incoming total until a different owned total arrives. Wall time alone never releases a hold, and a withheld read never becomes the baseline for the next decision.

## [1.1.15] - 2026-11-25

- Presence no longer carries one track's timestamps onto the next. During a handoff the card shows the new title with no timer until the timing provably belongs to it: a player-bar `M:SS / M:SS` clock and a media element must agree on the duration, and a lone source is used only when there is no second source to disagree with it. A stale clock and a stale playing element that agree on the previous song are not freshness, so the content script also holds timestamps until the reported duration moves or the selected media element's source changes.
- Timing withheld this way is restored on the next poll or media event: a duration that appears, a position that appears at the same duration, a clock that catches up or a changed media source all publish the correct total and playhead. A same-length new track whose media source never changes stays timer-free; that is the fail-closed choice, not a delay.
- Two disagreeing player-bar clocks are a conflict, not a missing clock, so the stale element is never stamped in that state.

## [1.1.14] - 2026-11-24

- The timestamp span is the real duration at every playback rate. The worker biases the elapsed reference by bounded rate drift so the displayed time follows the sampled media position, and a track still at 0:00 reads 0:00. A 3:27 track no longer reads 4:51 at 0.70x or 2:42 at 1.30x. Discord's timer counts wall time and carries no rate field, so no payload can make a non-1x track literally run at that speed.

## [1.1.13] - 2026-11-24

- Presence is published only from a live report that says playback is running. A paused report no longer puts a card on screen with no timer, and a pause or worker restart clears this extension's own presence through the null path so a native `lastActivity` snapshot cannot replay stale listening.
- Restored tab snapshots are marked unconfirmed and are never published on their own. A fresh worker records a null clear as its starting state, and only a live content-script report may promote a tab to a card; unconfirmed entries stay in the map so a later live report can take the same tab over.

## [1.1.12] - 2026-11-19

- A media event that fires before YouTube Music swaps the player-bar title now arms one 250 ms re-read, so a stale-event switch lands in about 250 ms instead of waiting for the 1 s poll (≤500 ms ordinary, 0 ms when the DOM already flipped). The re-read never republishes an unchanged title; the 1 s poll, the 1.5 s pacing and the eight-per-20 s ceiling are unchanged, and a burst past eight changes in 20 s still defers to the window edge.
- The countdown is now rate-scaled from the un-biased sample second and the remaining media time divided by the playback rate, with one floor on the sum. Measured over 60 s the countdown error stays within 552 ms at 0.70×, 123 ms at 1× and 277 ms at 1.30×, and the 1× frame is byte-identical. The elapsed bar keeps its ±375 ms bias and can still read up to 1123 ms ahead at 1.30× — the honest bound left by integer-second stamps and the ~3.3 s re-anchor gap, not a figure the send budget is loosened to chase.
- Docs now name the measured ~3.3 s cadence and the honest bound instead of the 2.5 s / ~2 s claim.

## [1.1.11] - 2026-11-18

- The package is `youtube-music-presence` everywhere: folder, package name, display name, and native host `com.nathwn12.youtube_music_presence` installed under `%LOCALAPPDATA%\youtube-music-presence`. **Reinstall the native host** (`node scripts/install-host.mjs`) and reload the unpacked extension: the extension asks only for the new host name, so an earlier registration is never consulted.
- Internal names follow the package: message tags `ytmp-state`, `ytmp-gone` and `ytmp-get-status`, storage keys `ytmpStatus` and `ytmpTabs`, the `ytmp-watchdog` alarm, and the test-only `YTMP_ARRPC_PORTS` / `YTMP_DISCORD_PIPES` overrides. A status or tab snapshot stored under an earlier key is ignored and rebuilt from the live page.

## [1.1.10] - 2026-11-16

- Native host startup clears inherited `NODE_OPTIONS` so a stale preload cannot prevent Node from starting.

## [1.1.9] - 2026-11-16

- A delayed disconnect from a replaced native port no longer tears down its replacement or schedules another reconnect.

## [1.1.8] - 2026-11-12

- The media poll stops entirely while the presence switch is off and starts again the moment you turn it back on, so a disabled extension does no repeating work in the background.

## [1.1.7] - 2026-11-11

- While the playback rate is not 1×, the card re-anchors at most once every 2.5 s and biases its reference by half the interval's drift, so the displayed time crosses the truth instead of lagging behind it; whole-second timestamps put a floor of roughly two seconds on the error at 1.5× (about three at 2×), and it never accumulates. Later measurement corrected this claim: 2.5 s was a spacing floor, not the cadence — deduplicated payloads put the measured re-anchor near 3.3 s — and the countdown no longer depends on re-anchoring at all (see 1.1.12).

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
