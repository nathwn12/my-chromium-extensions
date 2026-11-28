# Privacy Policy

Presence Suite is one local MV3 extension and one native messaging host that publish Discord rich presence for YouTube Music and Crunchyroll. The extension is local-only and never uploads anything.

## Data Collection

- No browsing history is uploaded and no analytics or telemetry is collected; the extension makes no network requests of its own and there is no remote server.
- Metadata from the two enabled sites is read locally and sent through Chrome native messaging to the local host, which writes the activity to Discord's desktop IPC.
- No tabs, cookies, downloads or scripting permission is requested, so nothing outside those two sites is inspected.

## Permissions

- `nativeMessaging` is used to hand each activity to the local host `com.nathwn12.presence_suite`.
- `storage` keeps the per-source switch map (`enabled`) and settings in `chrome.storage.local`, with the tab snapshot in session storage.
- `alarms` drives the watchdog alarm that recovers the worker after a restart.
- `host_permissions` are limited to `https://*.crunchyroll.com/*` and `https://music.youtube.com/*`.

## What is sent

- One activity per enabled source: for YouTube Music, a LISTENING card with the track title, artist, HTTPS artwork and two buttons on `music.youtube.com`; for Crunchyroll, a WATCHING card with the series or episode name, synopsis, position, duration, artwork URL and up to two buttons. Both go to Discord over the local IPC pipe.
- After a reconnect the host replays the last activity only while its end is still in the future. No remote server receives any of it.

## Local settings

- The worker reads the switch map from `storage.local` immediately, so a change takes effect without a reload. `presenceStatus` holds the last published status, `presenceTabs` is the session-storage tab snapshot used across service-worker restarts, and an optional application-ID override per source is kept in local storage.
- The old `crpStatus` and `ytmpStatus` records are left untouched; a clean install starts with the new keys and both switches on.

## Contact

If this policy needs a support contact or website URL, add it before Chrome Web Store submission.
