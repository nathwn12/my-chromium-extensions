# Presence Suite

One MV3 extension and one native messaging host publish Discord rich presence
for two sites: **YouTube Music** (Listening) and **Crunchyroll** (Watching).

## What it replaces

Presence Suite supersedes the two single-site extensions:

- **YouTube Music Presence** — music-only cards, the `ytmp-*` messages and
  `ytmpStatus` storage keys, and the `com.nathwn12.youtube_music_presence` host.
- **Crunchy Presence** — WATCHING cards, the `crp-*` messages and `crpStatus`
  storage keys, and the `com.nathwn12.crunchy_presence` host.

Both sites now share one extension, one worker, one send budget and one native
host. The per-site extraction rules were kept: YouTube Music still reads its
player bar and media session; Crunchyroll still merges top-frame metadata with
player-iframe video state per tab. Neither site's built-in Discord application
ID changed.

## Install

1. Open your browser's extensions page and enable developer mode.
2. Choose **Load unpacked** and select `packages/presence-suite`.
3. Install the native host from the package directory:
   `node scripts/install-host.mjs`
4. Verify it: `node scripts/install-host.mjs --check --json`.

The host installer writes `host.cmd` and `host-manifest.json` into a
per-user local application-data folder named `presence_suite` and registers
the host for Chrome, Edge and Brave. It derives the extension ID from the
manifest key, so the registration is tied to this unpacked copy.

There is **no store listing**. Install from this repository with Load unpacked;
the extension is local-only and never uploads anything.

## UI kit

The popup and options styles are vendored in `ui-kit/` from `packages/ui-kit` at
copy time; there is no build step for extensions. When the shared kit changes,
update every vendored copy (this package, `packages/ui-kit` and each sibling
extension) so they stay in sync.

## Per-site knobs

Both sources are **on by default**. No configuration is needed for a fresh
install.

- The popup lists both sources. Each row has its own switch: turning one off
  stops that site's card and leaves the other site running. The pill at the top
  shows the shared bridge state and the reason line shows friendly status copy.
- Settings (the options tab) has a switch and an optional application ID for
  each source, plus a read-only diagnostics block. An application ID is 17-20
  digits; leave it empty to use that source's built-in ID.
- The worker reads the switch map from `storage.local` immediately, so a
  change in either surface takes effect without a reload.

Storage keys are new and shared: `enabled` is a map
(`{ crunchy: true, "youtube-music": true }`) in local storage,
`presenceStatus` holds the last published status, and `presenceTabs` is the
session-storage tab snapshot used across service-worker restarts.

**Migration note:** the old `crpStatus` and `ytmpStatus` records are left
untouched. The first release does no auto-migration and does not delete them;
a clean install starts with the new keys and both switches on.

## Hosts and requirements

- Native messaging host name: `com.nathwn12.presence_suite`. One host speaks
  both application IDs, selected by the source registry in `config.js`.
- Requirements: Chromium 120 or newer, the Discord desktop app, a Node runtime
  for the installer, and the registered native host.
- Browser permissions are exactly `nativeMessaging`, `storage` and
  `alarms`, plus the two site host permissions. No tabs, cookies, downloads
  or scripting permission is requested.

See `docs/ARCHITECTURE.md` for the worker/message design and
`docs/INSTALL.md` for host setup details.
