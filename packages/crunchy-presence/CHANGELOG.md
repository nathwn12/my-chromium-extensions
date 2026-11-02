# Changelog

Notable changes to this project. Dates are ISO 8601. This package is local-only and is not published to a registry.

## [Unreleased]

- Crunchyroll-only hardening and idle savings: artwork and button URLs are restricted to `https://*.crunchyroll.com` (matching the button rule), the manifest and page-URL predicate are https-only, `crp-state` requires the extension sender id plus a Crunchyroll URL, storage writes dedupe identical payloads (including disabled idle ticks), the content-script poll clears on `pagehide` and skips while disabled, the `#clientId` placeholder meets 4.5:1, and the popup toggle reads "Active".

- Repair pass: the native port is disconnected on every drop so reconnects leak no host process; disabling presence still sends the null clear; the worker sends 4 ordinary updates per 20 s while null clears bypass uncounted on both sides (host backstop 5/20 s); rejected acks reset the send dedupe and retry with 1 s/2 s/4 s backoff; blind loading/discarded signals schedule a 1.5 s clear cancelled by arriving state; `crp-gone` is tab-scoped on `pagehide` and frame-scoped on SPA URL changes so a playing iframe survives; the first hello sends no null clear; the watchdog no longer re-sends idle nulls; boot suppresses the null publish until first state or 60 s; the popup renders `lastSent`; the options test button reports "queued" when queued.

- Restored the original popup/options design; the only carry-over is `#bridgeState.pill { justify-self: start; }` so the status pill hugs its text.

- Latency: normal play/pause/seek/clear lands sub-second — the content script no longer reports on `timeupdate` so position drift never spends the update budget (only the 30 s keepalive plus play/pause/seeking/seeked/ended/ratechange/loadedmetadata report), ordinary payloads are capped at 3 per rolling 20 s with one token reserved for a null clear that flushes immediately, and only a fourth ordinary update inside the same window is coalesced; null clears are delivered through the coalescer, offline payloads are stashed and flushed on the next status/ack, the host backstop is 10 per 20 s so bursts are not double-throttled, and reconnects reset the coalescing window.
- Clearing: closing or navigating away clears within one watchdog tick — top-frame `crp-gone` deletes the whole tab entry, `tabs.onUpdated` drops same-tab navigations away from Crunchyroll at once, and a host connect retry now emits `connected`.
- Reliability: a host flush with the pipe down reschedules instead of stranding the queue, `ack ok:false` records `lastError` without latching the bridge to `error`, the watchdog alarm is only created when absent, and the content script reports again on bfcache `pageshow` with a 30 s keepalive while a video exists.
- Built-in Discord application id, so the extension works with no setup; the options page can override it.
- Direct-link buttons: up to two, `Watch Episode` then `View Series`, with the `Watch on Crunchyroll` fallback for a lone episode link.
- Episode synopsis in presence, layered from JSON-LD, meta tags and DOM text, with boilerplate rejection and 128-character smart truncation.
- `Show episode synopsis in presence` option (default on) and a popup preview of the buttons Discord receives.
- JSON-LD completeness: `partOfSeries.@id`/`partOfSeason.@id` series links, `TVEpisode.url`/`@id` episode links, a clean episode title that never repeats the series, and an ISO-8601 `duration` fallback when no video element reports one.

## [1.0.0] - 2026-11-02

### Added

- MV3 extension for Chrome 120+ that reports Crunchyroll playback as Discord rich presence.
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
