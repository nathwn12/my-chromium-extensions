# Install

YouTube Music Presence publishes over desktop IPC to the Discord desktop app. Requirements: Windows 10/11, Chrome 120 or newer, Node 22 or newer, and Discord desktop running and signed in.

## Register the native host

From the repository root:

```text
node packages/web-discord-rpc/scripts/install-host.mjs
node packages/web-discord-rpc/scripts/install-host.mjs --check
```

The installer registers `com.nathwn12.web_discord_rpc` for the extension's pinned id. `--check` verifies the installation without writing.

## Load the extension

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select `packages/web-discord-rpc`.
3. Start Discord desktop, then open YouTube Music.
4. Use the accessible popup presence switch to enable or disable presence. The setting persists across page refresh and Discord restart.

Only Music pages are reported. The outgoing activity names `YouTube Music`, carries the track title in `details`, artist in `state`, and requests member-list state display with `status_display_type: 1`. The payload is covered by tests; the actual Discord rendering is not asserted here.

## Verify

```text
npm test --workspace=packages/web-discord-rpc
node packages/web-discord-rpc/native/host.mjs --selftest
```

If the popup reports the host missing, rerun the installer and reload the extension. If Discord is unavailable, start/sign in to the desktop app; no web transport fallback is offered.

## Remove

```text
node packages/web-discord-rpc/scripts/uninstall-host.mjs
```

Then remove the unpacked extension from `chrome://extensions`.
