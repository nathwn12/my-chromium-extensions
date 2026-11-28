# Privacy Policy

YouTube Music Presence reads local YouTube Music page metadata and the real media clock, then publishes one Discord rich-presence activity over Chrome native messaging and desktop IPC.

## Data Collection

- No browsing history is uploaded. The extension does not report YouTube video activity or upload browsing data.
- The extension makes no network requests of its own. It reads the Music page and sends metadata to the local native host; Discord receives the RPC activity. The page and media stream are never modified or captured.
- No analytics or telemetry: with no network requests of its own, nothing is sent to a remote server or shared with a third party.

## Permissions

- `nativeMessaging` is used to send the activity to the local native host; desktop IPC is the only product transport.
- `storage` is used to keep the persistent presence switch in `chrome.storage.local` and the last published status in `chrome.storage.session` on this machine.
- `alarms` drives the watchdog that reconnects the worker after a restart.
- `host_permissions` are limited to `https://music.youtube.com/*`, the only eligible page.

## What is sent

- One LISTENING activity: the static name `YouTube Music`, the track title, the artist, HTTPS artwork, start/end timestamps while playing, and at most two buttons on `music.youtube.com`. Elapsed time and duration are never invented.
- The card carries no link fields: `details_url`, `state_url` and `large_url` are never emitted, and the cover is not a link. The two buttons are the only click targets.

## Local settings

- The only user-facing preference is the persistent presence switch. Transport is fixed to desktop IPC; stored transport, site and application-id settings are ignored. The switch persists in `chrome.storage.local`.

## Contact

If this policy needs a support contact or website URL, add it before Chrome Web Store submission.
