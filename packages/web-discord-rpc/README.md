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

Only `https://music.youtube.com/` pages are eligible. The activity is type 2 (LISTENING), with the static name `YouTube Music`, track title in `details`, and artist in `state`. `status_display_type: 1` requests that Discord show the state/artist in its member list; this package verifies the outgoing IPC payload, not Discord's rendered UI. Album metadata is kept only as a unique artwork tooltip. Start/end timestamps are emitted only while playing when extraction supplies a real non-negative position and positive duration; elapsed time and duration are never invented. A missing artist falls back to the album, then the `YouTube Music` label.

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
