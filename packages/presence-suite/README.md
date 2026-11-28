<p align="center">
  <img src="icons/icon128.png" width="128" height="128" alt="Presence Suite icon" />
</p>
<h1 align="center">Presence Suite</h1>
<p align="center"><strong>One MV3 extension and one native messaging host publish Discord rich presence for two sites.</strong></p>

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
- Settings (the options tab) has an enabled switch and an optional application
  ID for each source, plus a read-only diagnostics block. An application ID is
  17-20 digits; leave it empty to use that source's built-in ID. The Display
  switches are described below.
- The worker reads the switch map from `storage.local` immediately, so a
  change in either surface takes effect without a reload.

Storage keys are new and shared: `enabled` is a map
(`{ crunchy: true, "youtube-music": true }`) in local storage,
`presenceStatus` holds the last published status, and `presenceTabs` is the
session-storage tab snapshot used across service-worker restarts.

**Migration note:** the old `crpStatus` and `ytmpStatus` records are left
untouched. The first release does no auto-migration and does not delete them;
a clean install starts with the new keys and both switches on.

### Display settings

Settings keeps one `displaySettings` record in local storage with three
switches:

- **Detailed clock** — off by default. On, the card sends the real track
  length as `start` and `end` and tracks the position inside the track.
- **Listen / watch button** (`Listen on YouTube Music` / `Watch on
  Crunchyroll`) — on by default.
- **Album / artist button** (`View album` / `View artist`) — on by default.
  Off, the second button is simply absent; with both button switches off there
  is no `buttons` field at all.

The record is remembered across browser restarts. Defaults apply field by
field: a missing or unreadable field falls back on its own rather than
discarding the whole record, so a partial or corrupt stored value still gives
the minimal clock and both buttons on unless a field was saved explicitly.

## Timing

There are two clock modes, chosen by the Detailed clock switch in Settings:

- **Minimal (default)** sends only `start`, never `end`. Discord treats that
  as an open-ended elapsed timer: it counts up indefinitely, so a song looped
  for an hour reads `60:00`. The anchor is the first sample for that track
  identity, not the position in the current pass — a repeat keeps climbing,
  a pause and resume keeps the anchor, and a different song starts a new one.
  With no stable identity no timer is sent rather than a guessed one.
- **Detailed** sends `start` and `end` around the real track length and
  tracks the position inside the track; at the end of a pass the pair
  re-anchors to the next loop.

The minimal anchor is held in the service worker's memory, so an MV3
suspension restarts that climb from 0:00. The remembered mode setting itself
survives restarts in `storage.local`. Both modes still need a playing tab
with a positive duration and a measured position before any timestamps go out.

Once a track or episode has published a timed card, the worker remembers its
last known total in local storage (`trackTotals`: up to 1000 tracks, no
expiry, ~80 KB at ~80 bytes each — no extra storage permission). At the ceiling
the least relevant track goes: play count decayed with a 90-day half-life, so
relistening beats mere recency. A cold sample with no total rebuilds with that
remembered value, so in detailed mode the first card shows the full length
instead of a bare 0:00; a live total replaces it only with ownership evidence - a near-zero
playhead on a freshly owned source or a coherent new identity. A stale read
mid-track keeps the remembered total on the outgoing card and in the cache.
After a reconnect the host replays the last activity only while its end
is still in the future, since an expired pair reaches Discord as an elapsed-only
card. A minimal activity has no end, so the replay guard does not apply to it.

## Privacy

Presence Suite is local-only: it reads page metadata from the two enabled sites
on this machine and sends the activity through Chrome native messaging to the
local host, which writes it to Discord over desktop IPC. It never uploads
browsing data, runs analytics or contacts a remote server. Settings stay in
`chrome.storage.local`; see [PRIVACY_POLICY.md](PRIVACY_POLICY.md) for the full
policy.

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

## Checks

```
bun run test
bun run selftest
node scripts/install-host.mjs --check --json
```

`bun run test` runs the package test suite.
`bun run selftest` exercises the native host against fake Discord IPC and arRPC pipes and prints a PASS line per check.
`node scripts/install-host.mjs --check --json` verifies the host registration without writing and prints each check as JSON.

## Links

- Root README: [README.md](../../README.md)
- Native host installer: [install-host.mjs](scripts/install-host.mjs)
- Changelog: [CHANGELOG.md](CHANGELOG.md)
