# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Bypass restores the element audible (`media.muted = false` unconditionally on teardown); the extension's own mute is no longer recorded as the page's mute, so turning Active off never leaves autoplay-muted tracks silent.
- Contract mute no longer silences the graph: `volumeHandler` ramps on `sourceStale` only, never on `media.muted`, so the attach-time `muted = true` (element muted, graph plays) survives its own queued `volumechange` at `media.volume`.

- Popup uses the card/pill shell (320px grid, header with native 32px icon plus `#status-pill`, one card holding both sliders, native checkbox toggle, footer Reset, `#status-text` detail line).
- Final repair: restore `tabs` permission for `tab.url`, stop the `captureStream` leak on attach failure, send live drags via `APPLY_LIVE_SETTINGS` with persist on `pointerup`/`change`, gate import-time rehydrate behind a session flag, and show waiting states with the amber `idle` pill.

### Fixed

- Track-change doubling on YouTube Music: the stale capture tap is dropped before the element unmutes, `volumechange` holds `masterGain` at 0 while the source is stale or the host player is muted, and the mute budget resets on rebuild; scoped to `music.youtube.com` only.
- Context race, mute-budget doubling, storage outage, dead worklet, leaked track, false status, stale tab-session override, popup write race, `tabs` permission, docs scope, and page-message hardening (see repair lane).

### Added

- Nothing yet.

## [1.0.2] - 2026-10-02

### Added

- Pitch-safe YouTube slowdown from 0.7x to 1.3x without pitch distortion.
- Local Dattorro plate reverb implemented as an AudioWorkletProcessor in `dattorro-worklet.js`, with adjustable intensity (0-100%).
- Primed reverb tank for instant wet output with no wind-up (primed t90 13ms vs cold 303ms), plus a rebuild guard and safe unmute ramp.
- Per-site speed, reverb intensity, and Active state persisted in `chrome.storage.local`, surviving restart and refresh with auto-apply on first play.
