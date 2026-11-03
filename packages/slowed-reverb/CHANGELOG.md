# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.3] - 2026-11-03

### Fixed

- Track-switch doubling: rebuild confirms the element mute before any gain rises (pre-mute ramp deleted), no-audio-track paths hard-zero `masterGain` before unmuting while the old tap is still connected, and a generation counter bumped on teardown/stale transitions lets stale async resumes and retries die instead of writing mute/gain. Invariant: `audible(controller) === (attached && !sourceStale)`.
- Zero-overlap unmute: stale-window (`emptied`, `loadedmetadata`, `sourceStale` volume) and mute-budget refusal paths hard-zero `masterGain` (`cancelScheduledValues` + `setValueAtTime(0)`) before unmuting, and a disconnected swap pauses before restoring state, so the element and graph are never briefly audible together.
- Bypass restores the element audible (`media.muted = false` unconditionally on teardown); the extension's own mute is no longer recorded as the page's mute, so turning Active off never leaves autoplay-muted tracks silent.
- Contract mute no longer silences the graph: `volumeHandler` ramps on `sourceStale` only, never on `media.muted`, so the attach-time `muted = true` (element muted, graph plays) survives its own queued `volumechange` at `media.volume`.
- Swap fast path: the `MutationObserver` filters to `VIDEO`/`AUDIO` adds/removes (including subtree wrappers) and schedules the existing scan on the next microtask instead of a 50 ms debounce, coalesced so a DOM storm schedules at most one scan; a 5 s safety poll remains the backstop, and disconnected controllers are torn down (paused) before the replacement is tracked.

- Popup uses the card/pill shell (320px grid, header with native 32px icon plus `#status-pill`, one card holding both sliders, native checkbox toggle, footer Reset, `#status-text` detail line).
- Final repair: restore `tabs` permission for `tab.url`, stop the `captureStream` leak on attach failure, send live drags via `APPLY_LIVE_SETTINGS` with persist on `pointerup`/`change`, gate import-time rehydrate behind a session flag, and show waiting states with the amber `idle` pill.
- Popup toggle is now a 36x20 switch (track `var(--line)` off / `var(--accent)` on, 16px knob, 16px travel, `prefers-reduced-motion` disables the transition) with `role="switch"`, `:focus-visible` ring, and a dimmed `:disabled` state; the status pill is 20px tall and the header icon loads `icons/icon24.png` at native 24px.

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
