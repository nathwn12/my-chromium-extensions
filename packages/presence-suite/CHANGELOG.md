# Changelog

Notable changes to this project. Dates are ISO 8601. This package is local-only and is not published to a registry.

## [Unreleased]

- A changed live total no longer overwrites a remembered one for the same identity without ownership evidence. A stale read mid-track keeps the remembered total on the outgoing card and in the cache; a near-zero playhead on a freshly owned source, a coherent new identity, or a genuinely different track still publishes its own live total. No playhead is invented.

## [1.0.2] - 2026-11-28

- Timestamps now come only from a measured playhead: a sample with no position publishes without a timer instead of inventing a 0:00 start, and a real zero still reads 0:00.
- A reconnect no longer replays an expired pair: the host sends the last activity only while its end is still in the future, so a stale card cannot come back as elapsed-only.
- A timed track's last known total is remembered in local storage for up to 1000 tracks with no expiry. A cold play rebuilds with that total instead of showing a bare elapsed timer, while a fresh live total always wins.
- Missing title, artist and album text is warmed from the cache only for the exact confirmed video ID: a mismatched or unknown ID borrows nothing, and no artwork, link or playhead is invented.
- Hidden-tab loops and throttled polls no longer leave the timer stuck: a large backward playhead jump re-anchors the card, and playback at a rate Discord cannot represent re-anchors each tick so elapsed time stays with the media.
