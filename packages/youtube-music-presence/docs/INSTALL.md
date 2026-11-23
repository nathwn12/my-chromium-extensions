# Install

YouTube Music Presence publishes over desktop IPC to the Discord desktop app. Requirements: Windows 10/11, Chrome 120 or newer, Node 22 or newer, and Discord desktop running and signed in.

## Register the native host

From the repository root:

```text
node packages/youtube-music-presence/scripts/install-host.mjs
node packages/youtube-music-presence/scripts/install-host.mjs --check
```

The installer registers `com.nathwn12.youtube_music_presence` for the extension's pinned id. `--check` verifies the installation without writing.

## Load the extension

1. Install the stable runtime folder from the repository root:

   ```text
   node scripts/install-extension.mjs youtube-music-presence
   ```

   It prints the folder it wrote, under `%LOCALAPPDATA%\youtube-music-presence\extension`.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the printed path. Chrome stores an unpacked extension as a folder path, so selecting `packages/youtube-music-presence` would break if the checkout moves. The stable folder does not move with the checkout.
4. Start Discord desktop, then open YouTube Music.
5. Use the accessible popup presence switch to enable or disable presence. The setting persists across page refresh and Discord restart.

Only Music pages are reported. The outgoing activity names `YouTube Music`, carries the track title in `details`, artist in `state`, and requests member-list state display with `status_display_type: 1`. The payload is covered by tests; the actual Discord rendering is not asserted here.

## Verify

From the repository root, with Bun installed:

```text
bun run --filter youtube-music-presence test
node packages/youtube-music-presence/native/host.mjs --selftest
node scripts/install-extension.mjs youtube-music-presence --check
```

If the popup reports the host missing, rerun the installer and reload the extension. If Discord is unavailable, start/sign in to the desktop app; no transport fallback is offered.

## Remove

```text
node packages/youtube-music-presence/scripts/uninstall-host.mjs
node scripts/install-extension.mjs youtube-music-presence --uninstall
```

Then remove the unpacked extension from `chrome://extensions`.
