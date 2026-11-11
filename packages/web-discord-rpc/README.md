# YouTube Presence

YouTube Music playback appears as one Discord desktop rich-presence activity. The extension reads local page metadata and the real media clock, then sends one activity over Chrome native messaging and Discord desktop IPC. It does not report YouTube video activity or upload browsing data.

## Requirements

- Windows 10 or 11, Chrome 120 or newer, and Node 22 or newer.
- Discord desktop installed, signed in, and running.

## Install

From the repository root, register the local native messaging host:

```text
node packages/web-discord-rpc/scripts/install-host.mjs
```

Then open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `packages/web-discord-rpc`. In the extension popup, use the accessible presence switch to turn presence on or off. The choice persists across refreshes and Discord reconnects.

## Presence contract

Only `https://music.youtube.com/` pages are eligible. The activity is type 2 (LISTENING), with the static name `YouTube Music`, track title in `details`, and artist in `state`. `status_display_type: 1` requests that Discord show the state/artist in its member list; this package verifies the outgoing IPC payload, not Discord's rendered UI. The artist line comes only from artist anchors or MediaSession; a byline segment is never read as an artist, so a localized view count cannot be mistaken for one. Start/end timestamps are integer seconds and are emitted only while playing when extraction supplies a real non-negative position and positive duration; elapsed time and duration are never invented. The anchor is the instant the position was sampled, not the instant the activity is sent, so a watchdog tick, a coalesced send or a replay after a Discord reconnect cannot move the progress bar; a future-dated sample stamp is ignored in favour of the worker's receipt time. A missing artist falls back to the album, then the `YouTube Music` label.

Two buttons are the only click targets, and the card carries no link fields at all: Discord underlines every linked line and offers no way to link without the underline, so `details_url`, `state_url` and `large_url` are deliberately never emitted and the track title, artist and album stay plain text. The cover is not a link either; its tooltip shows the album when the album is distinct from the visible lines, otherwise the YouTube Music view count when the player bar reports one, and is omitted when neither applies. That tooltip never repeats the track title, and a view count is never treated as an album name. The two buttons repeat the two most valuable doors - "Listen on YouTube Music" for the song and "View album" or "View artist" for the album or artist channel. Every button URL is `https` on `music.youtube.com` and capped at 512 characters, and a link that fails either check is dropped instead of emitted bare. Each target is also shape-checked: a track URL must be a `/watch` page with an 11-character video id, an album URL a `/browse/MPRE` page, and an artist URL a `/channel` page; anything else is dropped rather than repointed. The second button is decided from URLs, never from text, so an album name without an album link never produces a "View album" button.

The only user-facing preference is the persistent presence switch. Transport is fixed to desktop IPC; legacy transport, site, and application-id preferences are ignored. The built-in application id is `1566530911514923188`.

## Privacy and troubleshooting

The extension makes no network requests of its own. It reads the Music page and sends metadata to the local native host; Discord receives the RPC activity. The page and media stream are never modified or captured. If presence is absent, start Discord desktop and sign in, then check the popup's bridge status and run the installer with `--check`.

## Checks

```text
npm test --workspace=packages/web-discord-rpc
node packages/web-discord-rpc/native/host.mjs --selftest
node packages/web-discord-rpc/scripts/install-host.mjs --check
```

The suite covers Music-only extraction and UI, persistence/reconnect, artist payload, and timestamps through the outgoing activity frame.

## More

- `docs/ARCHITECTURE.md` — extension-to-IPC data flow and activity shape.
- `docs/RESEARCH.md` — evidence and limitations.
- `docs/INSTALL.md` — installation and verification.
