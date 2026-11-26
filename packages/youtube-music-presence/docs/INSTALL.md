# Install

YouTube Music Presence publishes over desktop IPC to the Discord desktop app. Requirements: Windows 10/11, Chrome 120 or newer, the Node version pinned by the repository root `.nvmrc` (mirrored by the root `package.json` `engines.node`), and Discord desktop running and signed in.

The [root README](../../../README.md) carries the shared install flow for development checkouts and release zips.

## Register the native host

Presence needs the host registered once. From an unzipped release folder:

```text
node scripts/install-host.mjs
```

From the repository root instead:

```text
node packages/youtube-music-presence/scripts/install-host.mjs
node packages/youtube-music-presence/scripts/install-host.mjs --check
```

The installer registers `com.nathwn12.youtube_music_presence` for the extension's pinned id. `--check` verifies the installation without writing.

## Load the extension

- **Development** — open `chrome://extensions` and enable **Developer mode**, choose **Load unpacked** and select `packages/youtube-music-presence`.
- **Release** — download the zip, unzip it anywhere, then **Load unpacked** the folder containing `manifest.json`.

Then start Discord desktop, open YouTube Music, and use the accessible popup presence switch to enable or disable presence. The setting persists across page refresh and Discord restart.

Only Music pages are reported. The outgoing activity names `YouTube Music`, carries the track title in `details`, artist in `state`, and requests member-list state display with `status_display_type: 1`. The payload is covered by tests; the actual Discord rendering is not asserted here.

## Verify

From the repository root, with Bun installed:

```text
bun run --filter youtube-music-presence test
node packages/youtube-music-presence/native/host.mjs --selftest
```

If the popup reports the host missing, rerun the installer and reload the extension. If Discord is unavailable, start/sign in to the desktop app; no transport fallback is offered.

## Remove

```text
node packages/youtube-music-presence/scripts/uninstall-host.mjs
```

Then remove the unpacked extension from `chrome://extensions`.
