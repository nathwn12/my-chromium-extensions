# Research notes

This document records what this package verifies locally and what it does not. Dates use ISO 8601.
The extension's desktop IPC path is the only supported product transport.

## Verified in the package

| Date | Claim | Evidence |
| --- | --- | --- |
| 2026-11-11 | The extension accepts only `youtube-music`, ignores reports for any other source, and sets `transport: "ipc"`. | `config.js`, `background.js`, extension tests. |
| 2026-11-11 | The activity is type 2 with static name `YouTube Music`, artist state and `status_display_type: 1`. | `activity.js`, activity/background tests, outgoing IPC payload test. |
| 2026-11-11 | Playback timestamps derive from extracted media position and duration; absent values omit timestamps. They leave as integer RPC seconds, not milliseconds. | `extract-youtube.js`, `activity.js`, extractor/activity/background tests. |
| 2026-11-11 | Track, artist and album anchors are extracted, but the activity carries **no** link fields: Discord underlines every linked line, so the card is plain text and the two buttons are the only clickable targets. The artist line comes only from artist anchors or MediaSession, never an arbitrary byline segment, so a localized view count cannot be read as the artist. The cover tooltip shows the album when it is distinct from the visible lines, otherwise the view count, and never the track title. Button targets are shape-checked: a track URL must be a watch page with an 11-character id, an album URL a `/browse/MPRE` page, an artist URL a `/channel` page, and anything else is dropped rather than repointed. | `extract-youtube.js`, `activity.js`, extractor/activity tests. |
| 2026-11-18 | The package version is 1.1.11. | `manifest.json`, `package.json`, root lockfile and this package changelog. |
| 2026-11-19 | The package version is 1.1.12. | `manifest.json`, `package.json`, root lockfile and this package changelog. |
| 2026-11-24 | The package version is 1.1.13. | `manifest.json`, `package.json`, root lockfile and this package changelog. |
| 2026-11-24 | The total timestamp span is the real duration at 0.70×, 1× and 1.30×; the elapsed reference follows the sampled media position with a bounded rate bias, and a track at 0:00 reads 0:00. | `activity.js`, `background.js`, activity/background tests. |

The package check validates the emitted activity payload, not Discord's UI. No live observation in this seam establishes that Discord's member list actually renders `state` when `status_display_type: 1` is present.

## Source and boundary

The extractor reads `navigator.mediaSession`, the YouTube Music player bar, JSON-LD and real `<audio>`/`<video>` media properties. Its tests use a fake page and therefore prove local extraction logic, not that every current Music page exposes the same selectors. The extension sends local metadata through Chrome native messaging; the native host's IPC framing is exercised by its package tests. No external endpoint, credentials, account state, or Discord client rendering was inspected for this change.

`status_display_type` and timestamp behavior are treated as outgoing protocol fields under test. The regression boundary for timestamps is the real-media-element values through activity construction and the outgoing frame. A missing/invalid position or nonpositive duration is not replaced with an estimate.

## Pending live closure (staged, not run)

Two claims remain UNVERIFIED because they can only be settled by watching a real session, not by the local payload tests:

1. Discord interpolates the elapsed bar in wall time between re-anchors, and no RPC field carries the playback rate, so a non-1× track cannot literally run at its speed on screen. The 3.3 s re-anchor cadence and the ±375 ms bias are outgoing-payload arithmetic, not observed on live YouTube Music.
2. Discord's rendered card is never inspected here. The stated 1123 ms (1.30×) / 377 ms (0.70×) offsets from the real media position are outgoing-payload arithmetic, not pixels on the member list/voice panel.

Closure route, one line the owner may authorise later (nothing here has been run; Discord was not touched and nothing was captured):

`tools["oc-hand"].desktop_screenshot({ target: { titleContains: "Discord" }, fmt: "png" })`

A read-only `tools["oc-hand"].desktop_list_windows()` confirms the exact window title first. The capture targets the Discord window by title with no activation: `desktop_screenshot` never moves the pointer, changes focus or writes the clipboard, and its reply carries `foregroundUnchanged`, `cursorUnchanged` and `noSteal` so the no-steal property is measured, not assumed. With the owner playing a known track at 0.7× and then 1.3× over a 60 s window on his word, two such captures (one per rate) of the rendered card are the receipt: the PNG shows what Discord actually displayed at that instant, and the no-steal fields prove the owner's session was not disturbed. Together with his stated rate and real position, those pixels are what would turn the two bounds above into observed facts. **Pending the owner's word — do not run until he authorises it.**
