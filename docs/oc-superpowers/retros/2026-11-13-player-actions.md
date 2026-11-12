# Retro — player actions, 2026-11-13

Outcome: slowed-reverb **1.2.1** shipped to GitHub, release asset verified
(`player-actions.js` inside, manifest `1.2.1`, hotfix present). The audio-normalizer
live-toggle branch is open in a worktree, waiting on the owner’s ear pass.

This retro is about the rounds, not the feature. The feature works; the path to it
was too long.

## Rounds

| # | What | Result |
|---|---|---|
| 1 | 3 scouts; A-B found on live `feat/pear-main` @ `a418ecb8`; spec | 173 tests |
| 2 | Review reject: page hook + content script both wrote `muted` | 192 |
| 3 | Attach-state channel; two reviews reject the mirrored race | design |
| 4 | Page hook volume-only; content script sole mute writer | 196 |
| 5 | Restore token/seek provenance; focused review partial | 201 |
| 6 | Async restore replaced with cache + `storage.onChanged` | 200 |
| 7 | Owner defect: 37→42 vs slider 40; 5% grid | 224 |
| 8 | Player-id identity, surface allowlist, zero HUD | 224 |
| 9 | Review: cache read/restore/dirty-field findings | 234 |
| 10 | Pending restore lands only when media exists | 234 |
| 11 | Owner: collapsed-bar wheel scrolled; preventDefault on surfaced wheel | 1.2.0 |
| 12 | Owner: louder at low slider; silent `setVolume` unmute + no `volumechange`; settle graph/mute | 1.2.1 |

Five review rejections, three mechanism reversals (mute writer, async restore,
identity source), two owner-found defects after “green.”

## What cost the rounds

1. **No live probe before the spec.** The URL identity (Home playback has no `?v=`),
   the document-wide wheel (`html` scrolls with `overflow-y: visible`), the missing
   YTM slider/tooltip DOM sync, and the silent `setVolume` unmute were all findable in
   one 10-minute gladius session. They surfaced only after the build.
2. **Two writers for one state.** The page hook owning `muted` produced two critical
   reviews and a design reversal. The content script must be the only mute writer;
   the hook reads/writes volume only.
3. **Async restore patched past the stop rule.** Read token, settle, input provenance
   were three patches on the wrong mechanism. The cache + `onChanged` removed the
   race by construction. The two-failure rule existed; it was not applied at review 2.
4. **The spec omitted pear’s UI sync.** `updateVolumeSlider`, `setTooltip`,
   `showVolumeSlider` were in the extracted reference and not carried into the spec.
   The owner found the gap.
5. **Review scope uncapped.** Conditional findings were argued as blockers; there was
   no accepted-risk register; the reviewer seat could not write its report. Cycles
   grew.
6. **One giant vertical slice.** Wheel + A-B + persistence + UI landed together, so
   foundations were tested after ~5k lines. A wheel-only slice would have shipped
   first and exposed 1, 2 and 4 in the first owner pass.
7. **Owner gates were not labeled.** “Blocked” was ambiguous; the owner thought the
   agent was blocked when the agent was waiting on them. Fixed in `AGENTS.md`.

## What worked

- Git archaeology: the feature was not at HEAD; the live branch held the final code
  and 15 hardening guards. Extracting byte-exact beat re-deriving.
- Test-first porting of the pear engine tables; the 5% grid red/green.
- One writer per file; the branch stayed coherent.
- Release verification by downloading the asset, not trusting the workflow log.
- The owner’s real-page pass, once it happened, caught what no Node test could.

## Changes made from this

`AGENTS.md`: **Probes and slices** (live probe before design; smallest owner-receipt
slice; one writer per state) and **Owner gates** (`THIS NEEDS YOU` vs `BLOCKED — me`).
`SYSTEM.md`: measured YouTube Music facts (player id, volume scale/unmute/no event,
layout surfaces, headless UA). `plan`/`review` skills: probe first, accepted-risk
register, proven blockers only, lead writes the report.

## Judge for the next feature

Time to the first owner real-page receipt, and the count of mechanism reversals.
Target: first receipt inside one slice; zero reversals caused by an unprobed live
surface. A missed target with real dates and numbers is a good result; a faked one is
not.

## The shortest path, restated

Probe the live system → write the facts into the spec → ship the smallest slice →
owner receipt → expand. A probe is minutes; a wrong foundation is rounds.
