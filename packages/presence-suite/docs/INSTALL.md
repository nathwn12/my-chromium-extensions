# Install and host setup

## Extension

1. Open the browser's extensions page and turn on developer mode.
2. Choose **Load unpacked** and select `packages/presence-suite`.
3. Note the derived extension ID shown on the page; the host manifest is bound
   to it through the unpacked copy's key.

## Native host

Run from the package directory:

- `node scripts/install-host.mjs` writes the host files and registers them.
- `node scripts/install-host.mjs --check` verifies without writing.
- `node scripts/install-host.mjs --json` prints a machine-readable report.

The installer uses `HOST_NAME` and `INSTALL_DIR_NAME` from the script and the
payload list `host.cmd` + `host-manifest.json`. It registers the same host
under Chrome, Edge and Brave, then reads each registry default value back to
verify it. `node scripts/uninstall-host.mjs` removes those traces.

The host is a single Node process speaking both sources: the worker's hello
selects the transport and an optional per-source ID map, and every activity
frame carries its `source`. The host acks activities by id and keeps the last
one per source for reconnects. A missing Discord client produces a waiting
status, never a crash.

## Verify in the browser

Open the popup: the pill should move from Waiting to Connected when Discord is
running. Play a track on YouTube Music or an episode on Crunchyroll and confirm
the matching row fills in. Both switches start on; turning one off must clear
only that source's card.

## Requirements

Chromium 120+, the Discord desktop app, and a Node runtime for the installer.
No browser store is involved.
