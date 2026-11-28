# Privacy Policy

Crunchy Presence reads the Crunchyroll episode you are watching and publishes it as Discord rich presence through a local native messaging host.

## Data Collection

- No browsing history is uploaded. The extension makes no network requests of its own.
- The native host makes no network requests on the desktop path: it writes `SET_ACTIVITY` frames to Discord's local named pipes. On the fallback path it opens a WebSocket to `127.0.0.1` (this machine only) for arRPC.
- No telemetry, no analytics, no remote config, no update check.
- Nothing is uploaded anywhere, so no personal data is sent to a remote server or shared with a third party.

## Permissions

- `nativeMessaging` is used to hand the extracted activity to the local native host.
- `storage` is used to keep settings in `chrome.storage.local` and the last extracted page state in `chrome.storage.session` on this machine.
- `alarms` drives the watchdog that reconnects the worker.
- `host_permissions` are limited to `https://*.crunchyroll.com/*`, the site whose page is read.

## What is sent

- Only the presence card: series and episode names, synopsis, position and duration, an artwork URL on `https`, and up to two buttons pointing at the episode and series pages. It goes to Discord over the local IPC pipe (or the loopback arRPC bridge), never to a remote server.
- Artwork URLs are handed to Discord, which fetches them. That request is Discord's, not the extension's.
- The page is read, never modified. The DRM video is never inspected or captured; only element state (position, duration, paused, playback rate) is read.

## Local settings

- Settings and the last extracted page state stay in `chrome.storage.local` / `chrome.storage.session` on this machine. The diagnostics on the options page are local text that you copy yourself.

## Contact

If this policy needs a support contact or website URL, add it before Chrome Web Store submission.
