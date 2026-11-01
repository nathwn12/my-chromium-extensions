# Changelog

Notable changes to this project. Dates are ISO 8601. This package is local-only and is not published to a registry.

## [Unreleased]

- Built-in Discord application id, so the extension works with no setup; the options page can override it.

## [1.0.0] - 2026-11-02

### Added

- MV3 extension for Chrome 156+ that reports Crunchyroll playback as Discord rich presence.
- `WATCHING` activity with series, season/episode, elapsed/duration, external artwork and one "Watch on Crunchyroll" button.
- Layered page extraction: `mediaSession`, JSON-LD, Open Graph, title patterns, then DOM fallbacks.
- Per-tab state merge with playing-over-paused selection and coalesced updates (4 per 20 s).
- 30 s watchdog alarm and reconnect with backoff for the service worker and the native port.
- Native messaging host with Discord IPC framing, `SET_ACTIVITY`, reply acknowledgement, republish on reconnect, and a `--selftest` mode.
- Protocol validation: type 3 only, 128-character text caps, 2-button cap, millisecond timestamps.
- Options page with Application ID, bridge status, current activity, diagnostics and a test-presence button; popup with an enable toggle.
- Installer and uninstaller for the Chrome/Edge/Brave native messaging registry entries, with `--check`.
- Fixed extension key and derived-ID helper so the host registration survives extension reloads.
- `node --test` suite covering extraction, manifest shape, activity building, framing and the rate guard.
