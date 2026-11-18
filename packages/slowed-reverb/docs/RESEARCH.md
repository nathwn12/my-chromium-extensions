# Research notes

## YouTube Music Home: does `getVideoData().video_id` lag an element source swap?

Measured on the live page with `oc-hand` `browser_*` in an isolated CDP context. The
extension was not loaded. A Chromium user-agent override was applied to the page
target before navigation and verified through `navigator.userAgent`. Every media
element was set `muted = true` and `volume = 0` before any interaction, a
capture-phase `play` listener paused and re-muted the element immediately, and a
mutation observer silenced elements inserted later. Playback never ran past the
instant of `play`; the element stayed muted, at volume 0 and paused for the whole
run. Source swaps were caused by clicking three different track tiles on the
Music Home page, returning to Home between them.

A 10 ms sampler recorded `video.currentSrc`, `#movie_player.getVideoData().video_id`
and its title, `video.currentTime`, and the URL; a capture-phase event log recorded
`emptied`, `loadedmetadata`, `loadeddata`, `canplay`, `play`, `playing`, `pause`,
`seeking` and `seeked`. Sample cadence: median 10.1 ms, 95th percentile 10.9 ms.
Bound stated before looking: 250 ms.

| Swap (URL `v`) | `emptied` to id change | id change minus source change | `loadedmetadata` minus source change | stale different id after source change |
|---|---|---|---|---|
| `WNxAvQNsJuM` | +1.7 ms | -160.3 ms (id leads) | +42.9 ms | 0 |
| `Mk-XlXe40FM` | +1.5 ms | -220.0 ms (id leads) | +905.4 ms | 0 |
| `vx9vv0ECQOM` | +1.3 ms | -224.3 ms (id leads) | +49.4 ms | 0 |

The player id updated 1.3 to 1.7 ms after the `emptied` reload event and 160 to
224 ms before the element's new `currentSrc`; no sample after a source change
reported a different id. The 250 ms bound therefore holds for these swaps.

Outcome: the v-less Home limit stays fail-closed. Each tile click from Home moves
the URL to a watch page with a `v` parameter, so a different-song swap with no
`?v=` was not produced; the only source reload observed on a v-less URL kept the
same id. The named fail-closed pins S and T in `test/injection-lifecycle.test.js`
also encode this exact same-id case as an invalidation, so closing the limit here
would flip a named pin. The measured facts are recorded rather than used to relax
the gate; no behaviour changed in this part of the work.
