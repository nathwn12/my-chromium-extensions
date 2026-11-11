# Research notes

This document records what this package verifies locally and what it does not. Dates use ISO 8601.
The extension's desktop IPC path is the only supported product transport.

## Verified in the package

| Date | Claim | Evidence |
| --- | --- | --- |
| 2026-11-11 | The extension accepts only `youtube-music`, ignores legacy YouTube reports, and sets `transport: "ipc"`. | `config.js`, `background.js`, extension tests. |
| 2026-11-11 | The activity is type 2 with static name `YouTube Music`, artist state and `status_display_type: 1`. | `activity.js`, activity/background tests, outgoing IPC payload test. |
| 2026-11-11 | Playback timestamps derive from extracted media position and duration; absent values omit timestamps. They leave as integer RPC seconds, not milliseconds. | `extract-youtube.js`, `activity.js`, extractor/activity/background tests. |
| 2026-11-11 | Track, artist and album anchors are extracted, but the activity carries **no** link fields: Discord underlines every linked line, so the card is plain text and the two buttons are the only clickable targets. The artist line comes only from artist anchors or MediaSession, never an arbitrary byline segment, so a localized view count cannot be read as the artist. The cover tooltip shows the album when it is distinct from the visible lines, otherwise the view count, and never the track title. Button targets are shape-checked: a track URL must be a watch page with an 11-character id, an album URL a `/browse/MPRE` page, an artist URL a `/channel` page, and anything else is dropped rather than repointed. | `extract-youtube.js`, `activity.js`, extractor/activity tests. |
| 2026-11-11 | The package version is 1.1.5. | `manifest.json`, `package.json`, root lockfile, root README and this package changelog. |

The package check validates the emitted activity payload, not Discord's UI. No live observation in this seam establishes that Discord's member list actually renders `state` when `status_display_type: 1` is present.

## Source and boundary

The extractor reads `navigator.mediaSession`, the YouTube Music player bar, JSON-LD and real `<audio>`/`<video>` media properties. Its tests use a fake page and therefore prove local extraction logic, not that every current Music page exposes the same selectors. The extension sends local metadata through Chrome native messaging; the native host's IPC framing is exercised by its package tests. No external endpoint, credentials, account state, or Discord client rendering was inspected for this change.

`status_display_type` and timestamp behavior are treated as outgoing protocol fields under test. The regression boundary for timestamps is the real-media-element values through activity construction and the outgoing frame. A missing/invalid position or nonpositive duration is not replaced with an estimate.
