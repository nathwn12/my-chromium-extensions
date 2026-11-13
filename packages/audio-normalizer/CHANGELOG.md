# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [5.6.2] - 2026-11-13

### Changed

- The media path returns to the stable 5.5.0 architecture: **one `createMediaElementSource` per element**, captured once and kept for the document, reused on every re-attach; removed-and-reinserted feed items reuse the same node and are never re-captured. The 5.6.x `captureStream` stream tap, its silent-sink probe, its source-identity re-taps and its churn watchdog are gone — feeds were slow and sticky on scroll and on back-and-forth.
- Unchanged and kept from 5.6.0: live enable/disable on an already-loaded page (`seen` registration, the passive hook on seen-but-off hosts, live `START`/`STOP` with the session kept) and the automatic one-time reload on a host's first-ever enable.

### Known limitation

- Cross-origin media without CORS approval, DRM/EME media and `srcObject` streams are not routed, exactly as in 5.5.0: they play native — or silent if the page's own Web Audio graph takes them. There is no live amplitude probe, so a route that cannot carry audio is not detected at runtime; the fix for such a site is exclusion.

## [5.6.1] - 2026-11-12

### Fixed

- The stream tap is now proven audible before any mute for **every** media source, including `blob:`/MSE (TikTok, YouTube, Instagram feeds) and same-origin media, not just cross-origin `http(s)`. A silent tap stays native with a verdict instead of muting a page nobody is routing.
- Feed churn (TikTok/Facebook/YouTube/Instagram): a reused `<video>` whose source changed kept the previous stream tap, so the element stayed muted for audio nobody was routing. The tap is bound to the source it was captured from; a source change (or `playing` on a new source) detaches it, hands native audio back, and re-evaluates. `playing` is also the re-attach trigger for reused/autoplayed elements (one document-level listener per event, not four per element).
- Fail-open watchdog: while a routed element plays, the recovery pass verifies the context, the tap source, the worklet and the element's presence — never amplitude — and hands the element back (unmute → native, `interrupted` verdict) when the route cannot carry audio. A worklet processor error on a stream route fails open the same way instead of trusting a possibly-silent bypass.

## [5.6.0] - 2026-11-12

### Fixed

- Feed silence on autoplay-gated tabs (e.g. TikTok): the hook never captures into a non-running context (guard restored, one re-attempt on the next gesture or play event); a context that ever captured is never closed (capture latch survives ended/emptied churn); worklet processor errors and throwing connects fall back to the audible input-to-output path with backoff; gesture resume covers pointerdown plus play/playing while elements are attached; disabling the site keeps captured elements on the resumed bypass path; MutationObserver removals coalesce instead of dropping inside the debounce window.
- Feed-main-thread starvation on infinite scroll (e.g. TikTok freezing after 2–3 videos): the observer flush no longer blanket-walks every descendant with `querySelectorAll('*')` (new roots are already captured by the `attachShadow` patch, existing ones by the startup sweep; only the added node's own `shadowRoot` is observed, O(1)); a mutation storm is sliced into capped 200-mutation flushes with the remainder carried to the next tick instead of one unbounded synchronous loop. No audio, mute, capture or routing behaviour changed.
- Feed churn silence on video switching (e.g. TikTok/Reddit/Facebook): the element→source map is now permanent for the document (WeakMap, never deleted) and removal no longer disconnects the source, so a re-inserted element reuses the same node with zero re-capture (one `createMediaElementSource` per element, ever); a context that captured anything is never closed — it suspends when idle and resumes on attach; an element owned by the page (throw with no cache) is skipped unmuted, and that latch never blocks a cached route.

### Added

- Live enable/disable on the page you are already on. A site you have enabled before now loads a passive page hook: present and idle, creating no audio context, no worklet and no listener, and capturing nothing, so the page plays natively at zero graph cost. Turning the switch on starts that hook in place — the playing element is captured once, the session routes through the worklet, and one program generation is minted — with no navigation and the playback position untouched. Turning it off is a bypass to 0 dB that keeps the session, the sources and the dispatcher, so turning it on again is equally instant. The first-ever enable of a host is the one case with no hook to start, and it reloads that tab automatically, once, about half a second after the switch flips (`Reloading to activate…`); only a reload the platform refuses falls back to the one-time notice. Exclusion is unchanged and remains the zero-cost kill switch: no registration, no hook, full teardown, native audio.

### Changed

- `STOP` from the worker is now a bypass, not a teardown. `destroy` (exclusion, uninstall) is the only path that releases a captured element or closes its context, because a captured element can never be captured a second time in the same document.

## [5.5.0] - 2026-11-12

### Added

- Per-site exclusion that is enforced when the content script is registered, not after it loads: a site you have not turned on has the script never registered at all. Until now the script was registered for every URL and each page decided for itself after it had already been injected.

### Changed

- The static `<all_urls>` content-script entry is gone. The script is registered dynamically for enabled sites only, so pages where normalization is off run none of this extension.

## [5.4.3] - 2026-11-03

### Fixed

- Adversarial hardening (13 findings): the hook no longer labels its own `createMediaElementSource` captures as page WebAudio (own captures run under `internalWiring`, so a context close/recover can re-attach); content scripts reach `about:blank`/srcdoc/opaque-origin iframes (`match_origin_as_fallback`); the worklet URL origin is pinned to the content-script-set value at load (a page START can no longer pin a foreign `chrome-extension://` id) and the hook echoes `gainDb` on every status so a page `SET_GAIN` is corrected at once; `HOOK_ERROR` always carries `state.lastError`; a page-defined `window.__tabNormalizerHookV5` no longer blocks the real hook (early-return only on the `__tnConnect` patch); site keys are the full hostname (`alice.github.io` no longer shares `github.io`'s toggle, collapsed keys survive read-only with migration on first write); the DOM pending fallback is ignored after stop until a real START (plus a content-script STOP backstop for disabled-but-active hooks); the unused `tabs` permission is gone (policy line with it) and `page-hook.js` left `web_accessible_resources`; the reset button zeroes gain (Active stays on) and the copy no longer claims every tab is normalized (per-site opt-in).
- Leak/perf: `emptied`/`ended`/removal disconnect the source, drop it from both sets and clear `__tnAttached` (replays reuse the live source instead of re-capturing); closed-context sessions are pruned and hook-created contexts close when idle; `GET_DOCUMENT_STATUS` answers from in-memory state (storage re-read only on `storage.onChanged`); a slider drag persists once on `change`/`pointerup` (live preview is a transient, storage-free tab apply) with one broadcast per write.

- Popup uses the card/pill shell (320px grid, header with native 24px `icons/icon24.png` plus 20px `#status-pill`, one card holding the gain slider and presets, 36x20 switch toggle with `role="switch"`, `:focus-visible` ring and dimmed `:disabled` state, footer Reset, `#status-text` detail line); the status poll still skips `applyControlState` while a save is in flight so controls cannot snap back mid-write.

- Top-frame video, cross-origin iframes, and open shadow-root video now normalize (autoplay-blocked contexts recover on gesture; DRM and closed shadow roots fall back to raw audio): the page hook injects into the sender frame (`frameIds: [sender.frameId]`, frame 0 only for tab-level calls, disappearing frames report an error), the worklet URL travels in the START message from the ISOLATED content script (page DOM is only the pending-start fallback; anything but a `chrome-extension:` URL ending in `/audio/normalizer-worklet.js` fails closed), a pending `resume()` never blocks session readiness (bounded 400 ms `resumeWithTimeout`, gesture retry registered first), an injected-but-dead hook re-syncs via the capped activation retry, the 1.5 s guard restores mute only while still guard-muted, re-enabling mints one fresh program generation with a single `reset-program` (never at attach), and open shadow roots are walked (attachShadow patched, observer-identity check so a second start re-observes the same root).

## [5.4.2] - 2026-10-21

### Fixed

- Per-video feed jumpscare: a new video in a scroll feed no longer starts
  on the previous video's stale measurement. The page hook detects program
  boundaries (new element, `loadstart`/`emptied`/`ended`-then-`play`, dirty
  same element; pause/resume, seek, and stall stay continuity) and sends one
  `reset-program` per live session; the worklet folds AGC into the slow gain
  so the next video starts at the previous video's settled gain with no snap.
- Carry-over cold gain: after the reset the cut-only branch
  (`desired = min(slow, probe)`) re-levels from a fresh probe, so a ~6 dB
  louder next video lands within 1.5 dB of its own settled gain by 250 ms
  (+0.49 dB measured) and 0.5 dB by 500 ms (+0.07 dB); same-loudness moves
  −0.00 dB; quiet next videos see no boost (+0.00 dB).
- Cold probe is now ~50 ms with a fast ~0.08 s log-domain slew (was ~100 ms
  / ~0.12 s): time to −6 dB 0.211 s → 0.123 s; −9.57 dB at 0.3 s, −9.90 dB
  at 0.5 s, settled −10.00; quiet onset untouched (0.000 dB).

### Added

- `reset-program` worklet contract (generation-token idempotent reset;
  AGC fold, meter/probe clear, audio-path preserve; never reset at attach
  time) — see `docs/SPEC_FEED.md`.
- `qa/feed-transition-qa.cjs` (F1–F6 transition harness, 11/11 rows PASS,
  including the delayed-duplicate-after-resume row) and
  `qa/program-boundary-qa.cjs` (page-hook handoff, 13/13 rows PASS,
  generations [1–7], overlap rows 11–13); the release gate's ONSET −6 dB
  check stays at 0.5 s and its negative control is a guard-disabled
  variant (must read above −6.0 dB at 0.5 s, reads −1.55 dB).

## [5.4.1] - 2026-10-19

### Changed

- Startup is seamless: a silence-until-routed attach guard mutes a media element
  until its graph is routed (1.5 s fallback restores its previous muted value;
  on failure the element plays raw as before), the media session (AudioContext +
  AudioWorklet module + node) is pre-warmed before the first media element
  plays, and a cold-start, cut-only onset guard driven by a ~100 ms levelled
  power probe with a fast ~0.12 s log-domain slew hands over continuously to the
  slow loop — so a loud onset is cut toward the target from the start instead of
  passing uncut for ~400 ms. Measured 2026-10-19 on comfort-loud: the old chain
  was still only −1.55 dB down at 0.5 s (−6 dB not reached until ~0.95 s); the
  guard reads −9.3 dB by 0.5 s, −9.7 dB by 1.0 s, settled −10.00, never deeper
  than settled + 1.5 dB, and quiet onsets are untouched.
- Within-program levelling is now a dead-band AGC on the raw input
  (mechanism: ffmpeg `loudnorm` `INNER_FRAME` — inside ±2.5 LU of the program
  no adaptation is applied at all, per EBU R 128 s4 clause k; outside, the
  short-term spread is compressed back to the band edge), replacing the Dolby
  Film Standard static curve. Boost capped at the published +6 dB Film max;
  the +12/−20 dB clamp still binds the total program gain. The 4-LU varying
  program keeps its range; the 12-dB pair lands near
  the LDR ≤ 5 LU outcome.
- The user trim is now written into the limiter delay line before the
  detector (ffmpeg `loudnorm` offset topology, EBU Tech 3344 device order),
  so a trim change can no longer punch through the true-peak ceiling. It
  takes effect after the 5 ms lookahead flushes instead of in the same
  render quantum.

### Removed

- Blast Guard, entirely (owner-directed): the popup control `#blast-guard`, the
  per-site record field `blastGuard`, the hook message `SET_BLAST_GUARD`, and
  the worklet's `set-blast-guard` inbound with its −2 dBTP ceiling, clamps,
  release and hold. The single −1 dBTP true-peak ceiling remains. Legacy
  per-site records that still carry `blastGuard` read cleanly — the field is
  ignored and dropped on the next write.

### Fixed

- Quiet-passage lift and level-step recovery are fixed: the dialogue
  fixture's quiet section rises +6.74 dB, its spread shrinks 12.77 dB
  (26.02 → 13.25), the tail sits at −20.00 LUFS, and the step lands at
  −20.40 LUFS (delta −0.40, tolerance ±1.0) — verified offline in
  qa/loudness-verify.cjs (release gate).
- Trim-step ceiling punch-through (silence, burst, then +12 dB trim):
  was +1.6 dBTP with rail hits; now at or below the ceiling with zero rail
  hits at both sample rates.
- Level-step recovery (60 s quiet then 30 s loud) no longer rides hot for
  seconds; the measured outcome under the release gate is in the Fixed entry
  above (ST@70 -20.40 LUFS, delta -0.40, gate +-1.0 LU).

## [5.4.0] - 2026-10-18

### Changed

- Human-comfort loudness chain in `audio/normalizer-worklet.js`: the
  program target is now FIXED at −20 LUFS (a judgment inside the published
  −20.0 to −16.0 LUFS window — EBU R 128 s2 interim; AES TD1008 speech −18 /
  music −16 — below the platforms' ≈−14 so the levelling stage has headroom,
  and corroborated within 1 dB by EBU R 128 s4's own cinematic remedy, which
  lands program loudness at −21 LUFS).
- New within-program levelling stage, always on: the Dolby Film Standard DRC
  static curve (6 dB max boost below −43 dB, 2:1 boost −43 to −31 dB, 5 dB
  null −31 to −26 dB left untouched, 2:1 early cut −26 to −16 dB, 20:1 cut
  above −16 dB) driven feedforward by a fast peak envelope (3 ms attack,
  250 ms release). The curve keeps its published absolute thresholds — the
  null band is anchored at absolute −31 to −26 dBFS and is NOT re-anchored to
  measured program loudness (the extension cannot measure dialogue, and
  program loudness is not dialogue). Correctness is judged by outcome
  (program → −20, range reduced toward LDR ≤ 5 LU), not by the thresholds.
- The user slider is now an immediate output trim, separate from the target:
  it ramps per sample within one render quantum, never moves the target, and
  never perturbs the integrated measurement. It is written into the delay
  line before the detector, so the −1 dBTP ceiling (−2 dBTP Blast Guard)
  holds at any slider position (the change takes effect after the 5 ms
  lookahead flushes).
- Two loops in the published order with anti-maximizer bounds (LDR ≤ 5 LU;
  short-term ≤ program + 5 LU), a final true-peak limiter, and `set-mode`
  retained for compatibility (both modes run the same comfort chain).
- Live compromise stated plainly: EBU Tech 3343 §9.4.2 prefers offline,
  iterative dynamics adaptation over live processing, and a browser tab cannot
  do a pre-pass — this chain is the live approximation, not offline-grade.

### Fixed

- Loud programs with quiet dialogue no longer sit against the average: the
  levelling stage pulls loud passages down and lifts quiet ones up before the
  slow loop measures, so "loud videos stay loud" and "the quiet parts are
  enhanced" are both addressed at the cause instead of the average.

## [5.3.0] - 2026-10-18

### Changed

- Rewrote `audio/normalizer-worklet.js` as a gated ITU-R BS.1770-4 / EBU R128
  loudness normalizer: exact K-weighting (libebur128 `ebur128_init_filter`
  constants), 400 ms blocks at 75% overlap, an absolute gate at −70 LUFS then
  a relative gate at −10 LU, gain driven only by the gated integrated value
  toward −18 LUFS, the ReplayGain 2.0 reference loudness (slow asymmetric
  slew; `set-gain-db` shifts the target instead of adding gain on top, fixing
  a bug where the user gain was applied twice, so the slider delivers the
  ±12 dB it advertises), and a 4x-oversampled true-peak lookahead limiter
  holding output at or below −1 dBTP (−2 dBTP under Blast Guard) with a
  1.0 dB detector margin sized from the measured worst-case end-to-end under-read against the ffmpeg ebur128 oracle (0.51 dB on a steady full-scale 11.025 kHz tone; transient bursts within 0.21 dB), covering the BS.1770-4 4x under-read bound. Adds
  `set-target-lufs` / `set-mode` (normalize|level with a −20 dBFS 3:1
  compressor) / `reset-meter` inbound and `meter` + `this.telemetry`
  outbound; the old exponential-window gain-riding scheme is deleted.
  Verified offline in Node against ffmpeg's EBU R128 implementation: every
  fixture measures within ±0.1 LU per EBU Tech 3341 with true peak at or
  below the ceiling — the harness lives in the gitignored `qa/` directory,
  so a fresh clone cannot run it and CI does not cover it.


### Fixed

- Persistence is per-site top-level storage records (`site:<siteKey>` holding enabled/gainDb/blastGuard/seq/mirror in ONE write) with the background as the single writer: the popup sends field-level intents (`set` with ONLY the changed field) and the background applies the intent's fields to the live record and writes the whole record back in one `set` (whole-record read-modify-write), bumping the per-site `seq` audit counter; ordering is last-accepted-write-wins with the sequence kept as audit only and nothing ever rejected on ordering grounds. Document messages are frame-targeted (`frameId: 0` with a named `siteKey` provenance check) so one site never resets another frame. Fixed the `chrome.storage.local.get({'key': undefined})` marshalling defect (an object-form `undefined` default is dropped by the extension API JSON marshal, returning `{}` even when the key exists) by using the array form. Legacy migration is lossless (legacy keys normalised before matching so `www.`-only entries survive, an explicit `siteToggles` boolean wins `enabled`, `activeSites` cleared only for consumed entries) and the recurrence path is closed (the whole-map `siteToggles` mirror writer is deleted, so product code can no longer rewrite `siteToggles`/`siteSettings`).

## [5.2.0] - 2026-10-02

### Added

- Per-site loudness normalisation to EBU R128 (superseded by the gated integrated normaliser in 5.3.0).
- True-peak limiter with a -1 dBTP ceiling, plus the Blast Guard mode for stricter peak protection.
- AudioWorklet processing via content-script injection, with SPA navigation detection and service-worker restart recovery.
- Per-hostname Active toggle that persists across tabs.
- Early normalizer tuning work, superseded by the gated integrated normaliser in 5.3.0.
