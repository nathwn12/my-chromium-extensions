# YouTube Music Presence

YouTube Music playback appears as one Discord desktop rich-presence activity. The extension reads local page metadata and the real media clock, then sends one activity over Chrome native messaging and Discord desktop IPC. It does not report YouTube video activity or upload browsing data.

## Requirements

- Windows 10 or 11, Chrome 120 or newer, and Node 22 or newer.
- Discord desktop installed, signed in, and running.

## Install

From the repository root, register the local native messaging host:

```text
node packages/youtube-music-presence/scripts/install-host.mjs
```

Then install the stable runtime folder with `node scripts/install-extension.mjs youtube-music-presence`. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the folder the installer prints. Chrome keeps an unpacked extension as a folder path, so loading `packages/youtube-music-presence` would break if the checkout moves. In the extension popup, use the accessible presence switch to turn presence on or off. The choice persists across refreshes and Discord reconnects.

## Presence contract

Only `https://music.youtube.com/` pages are eligible. The activity is type 2 (LISTENING), with the static name `YouTube Music`, track title in `details`, and artist in `state`. `status_display_type: 1` requests that Discord show the state/artist in its member list; this package verifies the outgoing IPC payload, not Discord's rendered UI. The artist line comes from artist anchors, then MediaSession, then a structured JSON-LD author; a byline segment is never read as an artist, so a localized view count cannot be mistaken for one. Start/end timestamps are integer seconds and are emitted only while playing when extraction supplies a real non-negative position and positive duration; elapsed time and duration are never invented. The anchor is the instant the position was sampled, not the instant the activity is sent, so a watchdog tick, a coalesced send or a replay after a Discord reconnect cannot move the progress bar; a future-dated sample stamp is ignored in favour of the worker's receipt time. Because the timer counts wall time and no RPC field carries a playback rate, a track played faster or slower than 1× cannot be shown at its true speed; the worker keeps a 2.5 s spacing floor under the eight-per-20 s ceiling, but identical payloads are deduplicated, so the measured re-anchor cadence is about 3.3 s. The elapsed bar's reference is biased by half the interval's drift, so the displayed time crosses the real position instead of always lagging behind it. The countdown is instead derived from the un-biased sample second and the rate-scaled time remaining with one floor on the sum: measured over 60 s it stays within 552 ms at 0.70×, 123 ms at 1× and 277 ms at 1.30×, and the 1× frame is byte-identical to the unscaled build. Integer-second stamps still leave the elapsed bar up to about 1.1 s ahead at 1.30× (about 0.4 s at 0.70×); that is the honest bound, not a figure the send budget is loosened to chase. A missing artist falls back to the album, then the `YouTube Music` label.

Two buttons are the only click targets, and the card carries no link fields at all: Discord underlines every linked line and offers no way to link without the underline, so `details_url`, `state_url` and `large_url` are deliberately never emitted and the track title, artist and album stay plain text. The cover is not a link either; its tooltip shows the album when the album is distinct from the visible lines, otherwise the YouTube Music view count when the player bar reports one, and is omitted when neither applies. That tooltip never repeats the track title, and a view count is never treated as an album name. The two buttons repeat the two most valuable doors - "Listen on YouTube Music" for the song and "View album" or "View artist" for the album or artist channel. Every button URL is `https` on `music.youtube.com` and capped at 512 characters, and a link that fails either check is dropped instead of emitted bare. Each target is also shape-checked: a track URL must be a `/watch` page with an 11-character video id, an album URL a `/browse/MPRE` page, and an artist URL a `/channel` page; anything else is dropped rather than repointed. The second button is decided from URLs, never from text, so an album name without an album link never produces a "View album" button.

The only user-facing preference is the persistent presence switch. Transport is fixed to desktop IPC; stored transport, site and application-id settings are ignored. The built-in application id is `1566530911514923188`.

## Privacy and troubleshooting

The extension makes no network requests of its own. It reads the Music page and sends metadata to the local native host; Discord receives the RPC activity. The page and media stream are never modified or captured. If presence is absent, start Discord desktop and sign in, then check the popup's bridge status and run the installer with `--check`.

## Checks

From the repository root, with Bun installed:

```text
bun run --filter youtube-music-presence test
node packages/youtube-music-presence/native/host.mjs --selftest
node packages/youtube-music-presence/scripts/install-host.mjs --check
node scripts/install-extension.mjs youtube-music-presence --check
```

The suite covers Music-only extraction and UI, persistence/reconnect, artist payload, and timestamps through the outgoing activity frame.

## More

- `docs/ARCHITECTURE.md` — extension-to-IPC data flow and activity shape.
- `docs/RESEARCH.md` — evidence and limitations.
- `docs/INSTALL.md` — installation and verification.
