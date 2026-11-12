# Audio Normalizer — live enable/disable, no reload

Date: 2026-11-13
Package: `packages/audio-normalizer` (MV3, no build)
Branch: `feat/an-live-toggle` in worktree `Q:\PROJECTS\PERSONAL\my-chromium-extensions-wt-an-live`
Target version: 5.5.0 → 5.6.0

## Outcome

Toggling the normalizer on a site takes effect on the live document: off→on starts
processing without navigation, on→off bypasses instantly, and repeated toggles are
seamless. A page reload is not part of the normal toggle path. The only residual
reload case is the first-ever enable on a host where no hook exists; that case
auto-reloads the tab once (or shows the current one-time notice if auto-reload is
not wanted).

## Why it works the way it does today

- There is **no programmatic reload**. Enable is stored and deferred; the popup says
  `Enabled. Reload applies this.` Disable/exclude is already live (`STOP` → bypass).
- The content script is dynamically registered **only for enabled, non-excluded
  hosts**. `chrome.scripting.registerContentScripts` arms **future** documents only;
  it never retro-injects into an already-loaded page.
- The content script computes `armDecision` at load and refuses late arming; a
  storage change may only tear down.
- The page hook must run at `document_start` to patch `AudioContext`,
  `AudioNode.connect`, `HTMLMediaElement.play`, and to own the one
  `MediaElementSource` per element. A late patch cannot enumerate existing
  contexts or reclaim a page-owned element (`InvalidStateError`); `captureStream`
  is the only independent late tap.

## Evidence (2026)

- Prior art: 5 of 8 maintained audio extensions (volumecontrol, steady-volume,
  EqualLoud, globalSpeed, plus page-level Enhancer) use an **always-present passive
  hook** and make “off” a unity/bypass route; reload survives only in tabCapture
  release paths (Volume Master). Patterns: `effectiveGain` unity, `setBypass` input
  selector, `SET_GAIN 0`, deduped `setState`, never `close()` a context holding a
  one-time source, WeakMap of claimed sources, gesture-gated resume.
  Report: `C:\Users\nathan\AppData\Local\Temp\opencode\vol-ab\an-research-prior-art.md`.
- Chromium: `scripting.executeScript({world:'MAIN'})` injects into loaded pages;
  `registerContentScripts` is future-only; no API enumerates `AudioContext`s or
  re-claims page-owned media; `debugger` is banner-blocked for production.
  Report: `C:\Users\nathan\AppData\Local\Temp\opencode\vol-ab\an-apis.md`.
- Repo constraints: `C:\Users\nathan\AppData\Local\Temp\opencode\vol-ab\an-scout.md`
  (reload flow, FINAL RULE, hard/soft walls, tests to invert).

## Design — smallest slice that removes the toggle reload

1. **`seen` per site.** Set once on the first enable of a host. Register the content
   script + hook for `seen || enabled`, minus `excluded`. Never-seen hosts keep the
   current zero cost.
2. **Passive reservation on seen-but-off hosts.** At `document_start`, inject the
   MAIN hook. It patches as today and **reserves** media elements through a unity
   gain path without loading/running the normalizer worklet. The page plays
   unprocessed; the element is already owned, so a later enable needs no reload.
   Follow the existing pre-gesture/mute/`RESEARCH_SEAMLESS_START` rules; do not
   resume page-owned contexts.
3. **Live enable.** Flip the site flag, send `START`. The hook reuses the reserved
   sources/sessions, routes `input → worklet → output`, mints one `reset-program`
   generation, and reports `Active`. No navigation; playback position is untouched.
4. **Live disable.** `STOP` → `input → output` at 0 dB, keep sessions/sources pinned;
   no `destroy`. `destroy` stays for exclusion/uninstall only.
5. **First-ever enable (no hook).** Keep the current deferred notice, and
   auto-reload the tab once (position is lost only in this case). The popup must not
   claim “Reload applies” for a seen host.
6. **Exclusion stays zero-cost.** No registration, no hook, immediate destroy,
   native audio. This is the explicit kill switch; do not weaken it.
7. **Verdicts, not silence.** A page-claimed element or a suspended context reports
   a visible fallback/verdict; never force silence and never double-render.

## Files

| File | Change |
|---|---|
| `shared.js` | Site record `seen`; registration predicates; keep UMD source of truth. |
| `background.js` | Registration for `seen || enabled`; inject the hook for seen-but-off; disable → `stop` not `destroy`; first-enable auto-reload/notice. |
| `content-script.js` | Split the load gate into `hookPresent` and `enabled`; allow live `START` when enabled && hook present; keep exclusion fail-closed and teardown-only safe. |
| `page-hook.js` | Passive reservation mode; live `START`/`STOP` reuse; no destroy on stop; gesture/pre-mute discipline. |
| `popup.js` | Notice only for first-enable; `Active` when live; no reload control (keep the QA-pinned IDs). |
| `tests/*` | Invert the FINAL RULE suites for seen hosts; add live toggle, reservation, exclusion-zero, first-enable, one-source, no-double-audio. |
| `tools/cost-audit` | Add a seen-but-off scenario; keep excluded ⇒ zero scripts. |
| `docs/` | Update ARCHITECTURE/SPEC/CHANGELOG; keep the audio-safety rule. |

## Tests (no audio playback; static/stubbed)

- Seen host loaded **off** with a playing element → toggle on: `START`, sources
  reused, no navigation, position unchanged.
- Toggle off → bypass 0 dB, no teardown, no reload; toggle on again → seamless.
- Seen-but-off at load → hook present/passive, worklet not running.
- First-ever enable → one deferred/auto-reload path, not a silent no-op.
- Excluded host → zero scripts, zero injection, destroy, native audio.
- Page-claimed element → verdict/fallback, no second `createMediaElementSource`.
- No double audio, no dead context, one source per element.
- Cost-audit: seen-off has the passive hook; excluded remains zero.

## Judge

A real-page toggle on a seen host while audio is playing: no navigation, audio
continues, the effect applies within one interaction, and excluded hosts still run
nothing. The owner's ears are the final check for doubles/silence.

## Risks / trade

- Footprint: seen-but-off hosts now carry the passive hook. This is the explicit
  trade for seamless toggling; excluded hosts remain zero.
- Pinning sessions when off raises memory; bounded by elements and released on
  exclude/uninstall.
- Autoplay: a pre-gesture suspended context cannot process; follow the existing
  gesture/mute guard and never silence the page.
- The reservation changes the page's audio graph even when off; test no double audio
  and DRM/CORS fallbacks.
- The FINAL RULE tests encode the old behavior; invert only the seen-host path.

## Ship

`audio-normalizer` 5.5.0 → 5.6.0, CHANGELOG promoted, fixed `audio-normalizer`
release slot overwritten in place, downloaded zip verified. Branch never `main`
until the owner's real-page pass.
