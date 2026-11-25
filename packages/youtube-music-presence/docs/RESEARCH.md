# Research notes

This document records what this package verifies locally and what it does not. Dates use ISO 8601. Each row is dated evidence: a version row records the version at that date and is not rewritten by a later release.
The extension's desktop IPC path is the only supported product transport.

## Verified in the package

| Date | Claim | Evidence |
| --- | --- | --- |
| 2026-11-11 | The extension accepts only `youtube-music`, ignores reports for any other source, and sets `transport: "ipc"`. | `config.js`, `background.js`, extension tests. |
| 2026-11-11 | The activity is type 2 with static name `YouTube Music`, artist state and `status_display_type: 1`. | `activity.js`, activity/background tests, outgoing IPC payload test. |
| 2026-11-11 | Playback timestamps derive from extracted media position and duration; absent values omit timestamps. They leave as integer RPC seconds, not milliseconds. | `extract-youtube.js`, `activity.js`, extractor/activity/background tests. |
| 2026-11-11 | Track, artist and album anchors are extracted, but the activity carries **no** link fields: Discord underlines every linked line, so the card is plain text and the two buttons are the only clickable targets. The artist line comes only from artist anchors or MediaSession, never an arbitrary byline segment, so a localized view count cannot be read as the artist. The cover tooltip shows the album when it is distinct from the visible lines, otherwise the view count, and never the track title. Button targets are shape-checked: a track URL must be a watch page with an 11-character id, an album URL a `/browse/MPRE` page, an artist URL a `/channel` page, and anything else is dropped rather than repointed. | `extract-youtube.js`, `activity.js`, extractor/activity tests. |
| 2026-11-18 | The package version was 1.1.11. | `manifest.json`, `package.json`, root lockfile and this package changelog. |
| 2026-11-19 | The package version was 1.1.12. | `manifest.json`, `package.json`, root lockfile and this package changelog. |
| 2026-11-24 | The package version was 1.1.13. | `manifest.json`, `package.json`, root lockfile and this package changelog. |
| 2026-11-24 | The total timestamp span is the real duration at 0.70×, 1× and 1.30×; the elapsed reference follows the sampled media position with a bounded rate bias, and a track at 0:00 reads 0:00. | `activity.js`, `background.js`, activity/background tests. |
| 2026-11-24 | The package version was 1.1.14. | `manifest.json`, `package.json`, root lockfile, root README and this package changelog. |
| 2026-11-25 | Track identity and timing come from one current song: a changed duration or track link is a new sample even with an unchanged title, and timing is withheld rather than borrowed from a stale, hidden or paused media element. A player-bar `M:SS / M:SS` clock validates which media element belongs to the displayed title; MediaSession `playbackState` keeps handoff metadata playing while timestamps are absent. | `extract-youtube.js`, `content.js`, extractor/content/worker-frame tests. |
| 2026-11-25 | A stale clock agreeing with a stale playing element is not freshness: an identity change with an unchanged duration holds timestamps until the duration moves. Two playing media with the same duration but different elapsed times withhold timing rather than pick DOM order; a healthy no-clock startup and agreeing duplicate media still stamp. | `content.js`, `extract-youtube.js`, extractor/content/worker-frame tests. |
| 2026-11-25 | Disagreement withholds timing in both directions: a clock ahead of stale media and a stale clock with current media both emit metadata without timestamps until the sources agree. A trusted media element's pause outranks MediaSession playback; MediaSession only fills in when no element is trusted. A `loadedmetadata` from the outgoing element cannot approve a stale pair. A duration appearing, or a position appearing at the same duration, refreshes on the poll. | `extract-youtube.js`, `content.js`, extractor/content tests. |
| 2026-11-25 | A hold releases on an owned reset: a playhead at or near zero, a coherent source new to the last published timed sample, or on a changed identity a coherent total that differs from both the held and the credited total and whose playhead agrees with the shown clock. `sourceEvidence()` proves the element matches the clock's total and `clockAgreesOf()` proves it matches the playhead; a bare `currentSrc` proves neither. On the same track a changed total under the last published timed source stays outgoing and is withheld, so a blank-page or incoherent read cannot erase that source baseline. A new source at the old total stays blocked. An owned first read publishes at once, so a genuinely fresh new duration is never held forever; wall time alone never releases a hold and a withheld read never becomes the baseline. Both source signals stay local to the content script and are never fields on the RPC state. Reused-source mid-song recovery is limited to a trustworthy, non-conflicting player-bar clock whose playhead agrees with the chosen element; absent bar clock, disagreeing clock and same-total reads stay deliberately held rather than proving a universal first-read guarantee, and their live-page behaviour is unverified. | `content.js`, `extract-youtube.js`, content and next-track tests. |
| 2026-11-25 | A null timing gap during an identity change holds the last credible duration instead of clearing the gate, so a stale duration returning under the new identity stays unstamped until real timing arrives. A large backwards playhead reset is not used as fresh-source evidence on its own, because an outgoing seek or loop can produce it. | `content.js`, `docs/ARCHITECTURE.md`, content tests. |
| 2026-11-25 | A player-announced backward seek reopens a hold only with a full match to the last published timed sample: same identity, duration unit and non-null coherent source, a playing media element and a playhead behind the last published timed one. The baseline stays local to the content script. A paused seek, a clock conflict (no coherent source), a changed total and a stale handoff all remain withheld. | `content.js`, handoff-hold/content tests. |
| 2026-11-25 | Arming and suppression compare durations in floored integer seconds, the unit stamped on the wire. During `emptied`, a 366.4 s media element and a 0:47 / 6:06 bar clock (366 s) hold the same duration instead of bypassing the gate, while a real 2:09 (129 s) releases; a same-duration source change alone stays held. | `content.js`, content tests. |
| 2026-11-25 | Two displayed clocks that disagree are a conflict, not a missing clock: the read emits metadata without timestamps instead of falling through to the media element it just caught disagreeing. | `extract-youtube.js`, extractor tests. |
| 2026-11-25 | The package version was 1.1.15. | `manifest.json`, `package.json`, root lockfile, root README and this package changelog. |
| 2026-11-25 | The package version is 1.1.18. | `manifest.json`, `package.json`, root lockfile, root README and this package changelog. |
| 2026-11-26 | The package version is 1.1.19. | `manifest.json`, `package.json`, root lockfile, root README and this package changelog. |
| 2026-11-26 | The package version is 1.1.20. | `manifest.json`, `package.json`, root lockfile, root README and this package changelog. |
| 2026-11-26 | The package version is 1.1.21. | `manifest.json`, `package.json`, root lockfile, root README and this package changelog. |

The package check validates the emitted activity payload, not Discord's UI. No live observation in this seam establishes that Discord's member list actually renders `state` when `status_display_type: 1` is present.

## Source and boundary

The extractor reads `navigator.mediaSession`, the YouTube Music player bar, JSON-LD and real `<audio>`/`<video>` media properties. Its tests use a fake page and therefore prove local extraction logic, not that every current Music page exposes the same selectors. The extension sends local metadata through Chrome native messaging; the native host's IPC framing is exercised by its package tests. No external endpoint, credentials, account state, or Discord client rendering was inspected for this change.

`status_display_type` and timestamp behavior are treated as outgoing protocol fields under test. The regression boundary for timestamps is the real-media-element values through activity construction and the outgoing frame. A missing/invalid position or nonpositive duration is not replaced with an estimate.

The player-bar clock selectors are an assumption about current Music markup, not a live observation: the class list is a fast path and a bounded pattern scan inside `ytmusic-player-bar` is the fallback. When no coherent clock exists the extractor fails closed and emits no timestamps; it never guesses a track from DOM order.

## Pending live closure (staged, not run)

Two claims remain UNVERIFIED because they can only be settled by watching a real session, not by the local payload tests:

1. Discord interpolates the elapsed bar in wall time between re-anchors, and no RPC field carries the playback rate, so a non-1× track cannot literally run at its speed on screen. The 3.3 s re-anchor cadence and the ±375 ms bias are outgoing-payload arithmetic, not observed on live YouTube Music.
2. Discord's rendered card is never inspected here. The stated 1123 ms (1.30×) / 377 ms (0.70×) offsets from the real media position are outgoing-payload arithmetic, not pixels on the member list/voice panel.

Closure route, one line the owner may authorise later (nothing here has been run; Discord was not touched and nothing was captured):

`tools["oc-hand"].desktop_screenshot({ target: { titleContains: "Discord" }, fmt: "png" })`

A read-only `tools["oc-hand"].desktop_list_windows()` confirms the exact window title first. The capture targets the Discord window by title with no activation: `desktop_screenshot` never moves the pointer, changes focus or writes the clipboard, and its reply carries `foregroundUnchanged`, `cursorUnchanged` and `noSteal` so the no-steal property is measured, not assumed. With the owner playing a known track at 0.7× and then 1.3× over a 60 s window on his word, two such captures (one per rate) of the rendered card are the receipt: the PNG shows what Discord actually displayed at that instant, and the no-steal fields prove the owner's session was not disturbed. Together with his stated rate and real position, those pixels are what would turn the two bounds above into observed facts. **Pending the owner's word — do not run until he authorises it.**
