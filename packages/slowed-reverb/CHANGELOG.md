# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.7] - 2026-11-19

- Fix: an armed section now survives a playing song that reloads its source and
  answers the follow-up read with the same id. That answer used to be treated as
  stale, so the saved From/To was dropped and playback ran on to the end of the
  song instead of looping back to From at To. A same-id answer after a
  post-playback source change now confirms the visit only when a confirmed push
  named that id, the live URL and the answer's own href both carry the same
  `?v=`, and the reloaded element is still the one the controller tracks. A
  v-less URL, a href that moved, or a different element still invalidates, so a
  section can never seek into another song. The 1 s read suspension stays.
- The 1.2.6 known limit is retired where the URL names the song: a benign reload
  on a watch page keeps its section. It still applies on YouTube Music Home,
  whose URL carries no `?v=` and cannot corroborate the player's answer.

## [1.2.6] - 2026-11-18

- Fix: a saved section no longer seeks into another song. The player's pushed id
  is now anchored to the href it was read in, so a push replayed after a
  navigation - or an id that outlived one - is stale and cannot arm a section on
  the new page. When the navigation leaves the pushed song its points are
  dropped and no seek follows. Adopting a saved section still turns Repeat on, as
  it always has.
- Nothing seeks until the player's own reading confirms the song. A media source
  change, `yt-navigate-finish` or `yt-player-updated` asks the page hook what the
  player holds now (`SLRA_QUERY_SONG`, answered by `SLRA_SONG_STATE`); the answer
  is correlated against the push sequence and bounded at 1 second. A repeated id
  after a source change, a timeout, or a player that reads as nothing invalidates
  the visit instead of guessing. An unconfirmed identity never seeks a media
  element already past its first second, while a fresh element still restores
  instantly, so an ordinary track load is unchanged.
- A player that reads as two `#movie_player` nodes mid-swap now answers "nothing
  readable" instead of picking one of them.
- Fix: the wheel volume survives a refresh. The stored volume used to be latched
  before any controller existed, so the one hand-off was spent on a null and the
  refreshed page kept its own louder value; it is now handed over once per
  document, after the first sync creates the controller.
- A trusted move of YouTube Music's own volume slider is treated as the user's
  own number: it cancels a restore that has not applied yet and is stored for the
  next document. An install, revive or poll push is only a reading of the page's
  value and no longer cancels the restore. The adopted value is shown in the
  readout whoever moved it.
- Known limit, accepted rather than hidden: after the song has played, when the
  same media element reloads its source and the player answers with the same id -
  a benign refresh on YouTube Music Home, whose URL carries no `?v=` - the
  extension cannot tell that reload from a track swap, so it stops seeking until
  a different id arrives. Nothing is lost: the saved section is adopted again,
  with Repeat on, as soon as the player reports an id it can stand behind.

## [1.2.5] - 2026-11-18

- Fix: a saved section repeat now stays latched for the whole song. The loop
  used to be enforced only by the 100 ms backstop, which one transient loss of
  song identity or a hidden tab could tear down for the rest of the song, so a
  section that was still set stopped binding after its first pass.
- The armed section keeps the backstop installed and the loop is also applied on
  the media's own `timeupdate` and `seeked` events, so repeated passes, a pause,
  a manual seek and a `seeking`/`seeked` cycle all return to the section start.
  Repeat off or Clear still ends the loop.
- Fix: the wheel volume is stored per site and restored on load, so a refresh
  no longer jumps back to the page's own louder value. The restore is handed to
  the controller exactly once per document, on the first state that carries
  settings; a wheel step permanently disarms it, writes are coalesced to one per
  burst, and a pending write is flushed when the tab hides. YouTube Music's own
  slider is written by the wheel on every step and is never corrected behind it.
- Fix: the volume percentage is a permanent readout beside the Repeat button
  instead of a pill that faded out, and it sits in the panel's own row so it
  cannot overlap the panel when open.
- Fix: moving the speed or reverb slider no longer changes how loud the output
  is. The dry and wet paths are level-compensated against the measured reverb
  transfer and share a constant headroom, holding the matrix within 0.4 dB while
  full reverb stays under unity on a hot master.

## [1.2.4] - 2026-11-18

- A track change no longer becomes audible before the effect is applied. The
  next song starts with the slowed rate and pitch already in place instead of
  playing briefly at the page's own rate and correcting itself, which sounded
  like the effect re-aligning in real time.
- When YouTube Music writes its own playback rate mid-track, the correction now
  happens under a 5 ms fade instead of in the open.
## [1.2.3] - 2026-11-18

- Section repeat now saves itself: Now, Enter or blur on a valid range, and Clear all commit the saved section without a Save click. A commit that matches the saved range writes nothing, and an in-flight write for the same range is shared.
- A one-step Restore glyph sits beside Clear and Save; it is disabled when there is nothing to restore, restores the previous bounds (or removes a newly saved section), and clears after use.
- Wheel volume shows a transient percentage above the player bar and fades after 900 ms; it is hidden from assistive tech because YouTube Music's own slider is the announcement.
- Fix: a wheel volume write no longer plays the element alongside the graph. The page hook restores the mute the content script owns in the same task as `setVolume`, so the graph ramps alone and the wheel sounds like the native slider.
- Local operator only: a gitignored `.dev/section-import.json` dropped into the unpacked extension is merged once at worker start, preserving every saved section, refusing a malformed entry or a merge past the 100-entry cap, and reporting a hidden count-and-digest receipt. No message, page or popup route reaches it.

## [1.2.2] - 2026-11-14

- Fix: wheel volume over the player bar no longer moves the site volume the wrong way or stalls near 20. The wheel cache is player scale (0–100) and is seeded from the element only until the first applied page reply; afterwards it follows applied replies only, so the YTM element/player unit mismatch (element max ≈0.741) cannot re-seed it on every sync.
- Fix: a native YTM slider drag or keyboard/media-key step is pushed from the page hook over the existing `SLRA_VOLUME_STATE` type (no new message type, no read-request surface) and adopted as the wheel base, so the next wheel notch starts from the real site volume; the push also re-settles the graph mute, since a native `setVolume` unmutes the element with no `volumechange`.
- Fix: the hook-absent fallback element write now scales through the measured YTM slope instead of linear `percent/100`, so it matches the painted slider value.

## [1.2.1] - 2026-11-12

- Fix: after a page-hook volume write, settle the graph and re-assert the mute. YouTube's player API unmutes the element and fires no `volumechange`, which could leave the old gain and the native element playing together — heard as louder at low slider values.

## [1.2.0] - 2026-11-12

- Wheel volume over the player bar and the watch-page player panel, snapped to YouTube Music's 5% slider grid and mirrored into the real slider and tooltip; no HUD, the site's own control is the feedback.
- Section repeat (A-B): From/To with Now capture, live loop, and per-song save/restore keyed by the player's own video id, so a section saved from Home playback survives a refresh; the saved list is cache-backed and kept in sync across tabs.
- Player-sourced identity, a volume-only page hook and a single mute writer: the page hook never touches `muted`, and volume writes cannot silence or double the page.

## [1.1.0] - 2026-11-10

- Repair lane: page-message origin+token hardening, mute-budget fail-open to dry bypass with honest status, corrupt-setting fallback to defaults, storage-failure eligible fallback, rehydrate flag only after success, idle context suspend/resume, worklet dry fast-path with hoisted invariants, safety-poll pagehide/teardown clear, and visibility/playing watchdog gating.
- DSP repair: hard clamp to [-1, 1] instead of the per-sample soft-clip (transfer now 0.0 dB below 1.0); equal-power wet/dry crossfade with full wet at 100% and <1 dB dip anywhere; sub-1e-20 tank flush kills denormals after 40 s silence with the audible tail intact; fractional preDelay reads plus a continuous per-sample LFO remove the 2048-sample click (1.13x of baseline); DC-blocker (~178 Hz), wet-beam (~4.87 kHz) and LFO rate (0.673 Hz) are now derived from the live sampleRate so all three hold at 44.1/48/96 kHz; the 353/3627 early-reflection taps move from the 4453-sample loop to the 4217-sample loop per Dattorro's figure (266/2974 move the other way, swapping which tank feeds the left/right early taps).

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
