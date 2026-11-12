# Player Actions for Slowed Reverb — spec

Date: 2026-11-13
Package: `packages/slowed-reverb` (MV3, no build, vanilla ES2020)
Branch: `player-actions` (never `main`; merge is the ship step)
Target version: 1.2.0

## Outcome

The slowed-reverb extension gains the two player actions the owner already uses in
pear-slowed-reverb:

1. **Easy volume** — the mouse wheel over genuine player/UI surfaces changes the
   YouTube Music volume without hunting for the volume slider. Wheel where scrolling
   is the real intent keeps scrolling.
2. **Section repeat (A-B)** — set From/To, loop the section, save it per song, restore
   it when the song comes back.

Both are ported from the final pear implementation, not re-invented:

- `precise-volume` at pear HEAD: `src/plugins/precise-volume/renderer.ts`
- Section Repeat at pear `a418ecb8` (live branch `feat/pear-main`, never merged to
  master): `src/plugins/player-actions/section-repeat/{engine,saved,controller,section}.ts`
  plus the shared player panel. Extracted byte-exact and read-only at:
  `C:\Users\nathan\AppData\Local\Temp\opencode\vol-ab\reference\`
  (`section-repeat/`, `precise-volume/`). The addendum with SHAs and guard-to-bug
  mapping is at `…\vol-ab\scout-pear-addendum.md`.

## Five angles and what each produced

1. **Parity excavation** — the feature was not at pear HEAD; it was on a live branch.
   Result: the final state machine, the 100 ms engaged-only tick, the exact loop
   thresholds, per-song saves, and 15 hardening commits, each of which becomes a
   regression test (list below).
2. **Audio-graph safety** — the extension already owns a single volume truth:
   `masterGain.gain = media.volume`, with `media.muted === attached`. Result: the
   wheel writes volume through the page player API (YTM slider stays truthful), never
   through a second gain node; no >100 % boost; the mute contract is never touched by
   player actions.
3. **Event arbitration** — a document-level `wheel` listener that calls
   `preventDefault` is how extensions break scrolling. Result: a predicate ladder
   where native scroll always wins inside scrollable ancestors, text fields, and open
   dialogs; volume only on non-scrolling chrome; `preventDefault` only when a volume
   step actually lands.
4. **Lifecycle and persistence** — YTM is an SPA that replaces the media element and
   changes songs. Result: song identity from the URL `v` param (fallback
   `media.currentSrc`), one restore per song id, points cleared on change, saved
   sections restored only for their own song, tick torn down when disarmed/disabled.
5. **Shipability and footprint** — no new permissions, popup untouched (product
   guardrail: exactly four controls), shadow-DOM UI (no CSS leakage), one new
   content-script file, tests through the repo's own runner, release on the fixed
   `slowed-reverb` product slot.

The angle not taken: **store-ready onboarding/options page**. It would need new UI
and a permission story; the wheel and panel are self-explanatory, so the popup stays
as shipped.

## Non-negotiables

- Popup keeps exactly four controls: speed, reverb, Active, reset. No new popup UI.
- No new permissions; `host_permissions` stays `https://music.youtube.com/*`.
- `media.muted` has exactly one writer (`content-script.js`); the page hook writes volume
  only.
- `media.muted === controller.attached` invariant is untouched. Player actions never
  write `muted`.
- Volume is 0–100 %, no software boost. The graph's gain carries `media.volume` once.
- No YTM class selector is required for the feature to work. The panel is fixed and
  shadow-hosted; wheel gating reads computed overflow, not class names.
- No audio playback in tests. Offline/Node only, per `AGENTS.md`.
- `main` is not touched until the merge step. The release is a separate, explicit
  step after green.

## Architecture

### Files

| File | Change |
|---|---|
| `player-actions.js` | **new**. UMD module like `shared.js`: pure engine + a DOM controller factory. Exports under `globalThis.SlowedReverbPlayerActions` and `module.exports` for tests. |
| `content-script.js` | minimal wiring: create the player-actions controller when eligible, feed it the media element(s), tear it down on retire/bypass; no refactor of the audio pipeline. |
| `page-hook.js` | add token-verified `SLRA_SET_VOLUME` handling: call `#movie_player.setVolume(percent)`, read `getVolume()` back, reply with the applied value. Volume only - this hook never writes `muted` (see "Single writer"). |
| `manifest.json` | add `player-actions.js` to `content_scripts[0].js` between `shared.js` and `content-script.js`. Nothing else. |
| `test/player-actions.test.js` | **new**. Engine, saved, wheel arbitration, controller lifecycle, storage. Port pear's cases; add the 15 guards. |
| `popup.html/js/css` | **untouched**. |
| `CHANGELOG.md`, `manifest.json`, `package.json` | version 1.2.0 at release time. |

No CSS file: the panel and HUD live in a shadow root created by `player-actions.js`.

### Volume path

```
wheel / future hotkey
  → predicate ladder (shouldHandleWheel)
  → step = ±5 %, current read from the page player (fallback media.volume)
  → page-hook: #movie_player.setVolume(percent)  [MAIN world]
      → YTM updates its own slider + video.volume
  → native volumechange
  → content-script: masterGain.gain ← media.volume   (existing code, unchanged)
  → HUD "65 %" for 1.2 s
```

- The page hook replies with the actual applied percent; if the API is missing, the
  content script writes `media.volume = percent / 100` directly. Both paths end in the
  same `volumechange` → gain mirror.
- Volume is owned by YouTube (it persists its own player volume). The extension does
  not store or re-apply volume on load. This avoids clobbering a volume the owner set
  while the extension was off.
- **Single writer.** `content-script.js` is the only writer of `media.muted`
  (`media.muted = controller.attached`). `page-hook.js` writes volume and nothing else:
  it has no `muted` assignment, no attach-state channel, and no mute intent travels with
  a wheel write. If `#movie_player.setVolume()` ever flips `muted`, the existing
  `volumechange` enforcement corrects it, spending the same mute-correction budget as any
  other page-side flip. A wheel burst degrading through that budget is acceptable; a
  second mute writer is not, because an in-flight write could re-mute a graph that has
  already detached.
- The page token on `SLRA_SET_VOLUME` is an **anti-collision marker, not
  authentication**: a page script can read it and forge a volume message, which can only
  change the page's own volume. No security claim is made for it.

### Wheel predicate (order matters)

`shouldHandleWheel(event, target, doc)` returns `{ handle: boolean, reason }`.

1. `event.defaultPrevented` → no.
2. `ctrlKey || metaKey || altKey` → no (zoom/back/alt-scroll belong to the browser).
3. `deltaY === 0` → no (horizontal trackpad gesture).
4. Target inside the player-actions shadow host → no (panel has its own wheel/inputs).
5. Target is `input`, `textarea`, `select`, `[contenteditable]`, or inside an open
   dialog (`dialog[open]`, `[aria-modal="true"]`) → no.
6. Nearest scrollable ancestor: walk from target to `<html>`; an element with
   `overflow-y` in `auto|scroll|overlay` and `scrollHeight > clientHeight + 1`.
   - If the ancestor is not the document scroller → no (native scroll wins).
   - If it is the document scroller and the document actually scrolls
     (`documentElement.scrollHeight > innerHeight + 1`) → no.
7. Otherwise → handle.

`preventDefault()` is called only when `handle` is true **and** a volume step will be
applied. The listener is on `window` with `{ capture: true, passive: false }`,
installed once and removed on teardown.

Accumulation: `WHEEL_PX_PER_STEP = 100`, `VOLUME_STEP_PCT = 5`. `deltaMode` 0 is
pixels, 1 is lines (×16 px), 2 is pages (×100 px). Accumulate signed pixels; each
crossed ±100 applies one step; clamp at 0/100 and reset the accumulator when clamped
(running off the end must not bank 20 steps for the way back). Trackpads therefore
move smoothly and a mouse notch is one step.

### Section repeat

State: `{ active, startSeconds, endSeconds }`, exactly pear's `LoopState`.

Pure functions, ported verbatim in behavior:

- `parseTimeInput` — `ss`, `m:ss`, `h:mm:ss`; integers only; sub-parts < 60; empty →
  `{kind:'empty'}`; junk → `{kind:'invalid'}`.
- `formatTime` — `m:ss` below an hour, `h:mm:ss` above; floor; NaN/negative → `0:00`.
- `isLoopEngaged` — `active && (start !== null || end !== null)`.
- `resolveArmedLoop` (private) — start = `start ?? 0`; end = `end ?? duration`; a
  typed end at/past duration clamps to duration; threshold = explicit end − 0.05 s,
  song end − 0.3 s; disarm unless `threshold > start + 0.05` and finite.
- `resolveSeekTarget(state, player)` — null when disarmed, paused, seeking,
  non-finite `currentTime`; else start when `currentTime >= threshold`.
- `resolveEndSeekTarget(state, duration)` — start when armed, else null (the `ended`
  backstop).

Saved sections: `SavedSection { videoId, startSeconds, endSeconds }`; sanitize drops
malformed, drops both-null, dedupes by `videoId` last-wins; `upsertSaved` with both
null removes; lookup scans newest-first. Cap the persisted list at 100, dropping the
oldest.

Controller behavior:

- One 100 ms `setInterval`, created only while `isLoopEngaged` and the tab is visible;
  cleared on disarm/teardown/song change. Each tick re-queries `<video>` (the element
  is replaced on SPA navigation) and seeks when `resolveSeekTarget` returns a number.
- `ended` listener is the backstop: seek to `resolveEndSeekTarget` and `play()` —
  gated on the same arming rules, so clearing/off cannot restart playback.
- Song key: `new URL(location.href).searchParams.get('v')`, fallback
  `media.currentSrc`. On `yt-navigate-finish`, `popstate`, `hashchange`,
  `loadedmetadata`, and `emptied`: if the key changed, clear points, stop the tick,
  then restore the saved section for the new key (set points, `active = true`, seek to
  start when metadata is ready). One restore per key; a pending restore retries for up
  to 3 s on the tick.
- Enabling mid-song seeds the current key immediately (pear guard `52762433`).
- UI: fixed pill bottom-right above the player bar; expands to a shadow-DOM panel:
  Repeat checkbox, From row + Now, To row + Now, status line, Clear, Save. Time
  inputs commit on `change`/Enter; a commit of From seeks immediately; To/clear never
  seek; reversed range marks both fields invalid and refuses the commit; sync never
  clobbers a field being edited.
- Save: read the current `playerActions.sections`, upsert, write, show a transient
  notice only if the song + points are unchanged since the compose.
- Status copy mirrors pear: off / need start / `A → B` / `A → end of song` / invalid
  / saved / removed.

### Storage

`chrome.storage.local` key `playerActions`:

```json
{ "sections": [{ "videoId": "abc", "startSeconds": 12, "endSeconds": 30 }] }
```

Separate from `siteSettings` so `normalizeSettings` can never drop it. Read-modify-
write, debounced 250 ms for saves. No volume key.

## The 15 guards become tests

Each line is a regression test in `test/player-actions.test.js`; the bug is what the
test fails on without the guard.

| Guard | Bug it prevents |
|---|---|
| clamp end ≥ duration to song end | reversed/past-EOF seeks |
| disarm threshold ≤ start + 50 ms | zero-width loop re-seeking every tick |
| sync skips edited fields | external sync wiping in-progress typing |
| `ended` gated on loop invariant | `ended` restarting playback after clear/off |
| clear points on element replace | stale loop firing on the next song |
| latch authoritative song id, defer on null | previous song's section restored onto a new song |
| lifecycle generation + From-seek retry | `stop()` during a pending read resurrecting features |
| recheck generation between starts | a second controller starting stale |
| song-change listener independent of the tick | missed swaps while disarmed |
| blank From = 0:00 (incl. To-only) | To-only sections unusable |
| tick only while engaged | permanent 100 ms wakeups |
| restore on `dataupdated` too | autoplay advance skipping restore |
| seed id when enabling mid-song | saved section never applying until next song |
| save composes from fresh storage, notice gated | lost concurrent saves, stale "Saved" notice |
| explicit end loops without finite duration | dead loop on livestreams/late metadata |

Plus the wheel tests: modifier pass-through, input/dialog pass-through, scrollable
ancestor pass-through, document scroller pass-through, player bar handled, step
accumulation, clamp reset, deltaMode conversion, and `preventDefault` only on handled
events.

## Verification

Green means all of:

1. `bun run --filter slowed-reverb test` — existing 12 + new tests, 0 fail.
2. `bun run lint` — 0 errors, 0 warnings.
3. `node --check` on `player-actions.js`, `content-script.js`, `page-hook.js`.
4. Static manifest assertions in the test file: permissions unchanged, host scope
   music.youtube.com only, popup still four controls, new script present.
5. CDP smoke, **no audio**: load unpacked, open the popup, assert it renders and the
   service worker registers; no YTM navigation, no media playback.
6. Manual QA (owner, 60 s): wheel on the player bar changes volume and YTM's slider
   follows; wheel on the queue scrolls; A/B loops a real section; reload restores the
   saved section; bypass leaves volume/mute sane.

## Ship

1. Commit the work on `player-actions` in logical commits.
2. Merge to `main` (the owner's "ship" is the explicit merge this branch was waiting
   for).
3. `node scripts/release.mjs slowed-reverb minor` → 1.2.0; commit the bump + changelog.
4. Push `main`, update the fixed `slowed-reverb` release slot per the repo's current
   CI flow (`gh workflow run release.yml`; never delete/re-push a tag), verify the
   release asset and the version in the title.
