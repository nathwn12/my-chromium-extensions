# Architecture

Music-only presence from the page to Discord desktop. The extension never publishes YouTube video activity and does not offer transport or per-site configuration.

## Data flow

```text
music.youtube.com
  extract-youtube.js -> content.js -> background.js
  background.js -> Chrome native messaging -> native host -> Discord desktop IPC
```

`extract-youtube.js` reads media-session/player metadata and the actual `<audio>` or `<video>` element. `content.js` reports changes from media events, SPA navigation, visibility and page lifecycle; a one-second poll catches title and pause changes, and also re-reports when the live position drifts more than 2.5 seconds from where the last sample says it should be at the reported playback rate — and only when the position actually moved — so a seek the player never announced still re-aligns the card while buffering and non-1× playback stay quiet. `background.js` retains tab state in `storage.session`, selects the best playing tab, coalesces sends, and reconnects/replays after worker or Discord restarts. The accessible popup switch persists in `storage.local` and clears presence when switched off.

## Wire and activity

The worker opens one native port with `transport: "ipc"` and the built-in application id `1566530911514923188`. Only `source: "youtube-music"` reports are accepted. The host carries the activity to a Discord desktop named pipe; legacy YouTube reports are rejected by the extension path.

The outgoing `SET_ACTIVITY` activity is type `2` (LISTENING), with `name: "YouTube Music"`, title in `details`, artist in `state`, and `status_display_type: 1` to request that Discord use the state in its member list. The expanded header remains `Listening to YouTube Music`. The artist line comes from the player bar's artist anchors, then MediaSession, then a structured JSON-LD author, and is absent when none resolves: an arbitrary byline segment is never read as an artist, so a localized view count cannot be mistaken for one. The card carries no link fields — no `details_url`, `state_url` or `large_url` — because Discord underlines every linked line and there is no link without the underline, so the title, artist and album are plain text and the two buttons are the only click targets. Tests inspect the outgoing IPC payload; actual Discord rendering has not been observed in this seam.

| Field | Rule |
| --- | --- |
| `details`, `state` | Collapsed, trimmed text, capped at 128 characters. Artist is preferred for state; then a distinct album; then the source label. |
| `assets.large_image` | HTTPS artwork only. The cover is not a link. |
| `assets.large_text` | The cover tooltip: the album when it is distinct from the visible lines, otherwise the YouTube Music view count when the player bar reports one, otherwise omitted. A value that only repeats a visible line is dropped, it never repeats the track title, and a view count is never treated as an album name. |
| `buttons` | At most two, HTTPS and on `music.youtube.com`, URLs capped at 512 characters and labels at 32. Each target is shape-checked: a track URL must be a `/watch` page with an 11-character video id, an album URL a `/browse/MPRE` page, an artist URL a `/channel` page; anything else is dropped rather than repointed. The first targets the track URL, with the current page URL as the last resort; the second is "View album" when an album link exists, otherwise "View artist", and is absent when neither exists. That second label is decided from URLs, never from text. |
| `timestamps` | Only when playing and both a real finite position and positive duration exist. Integer seconds on the wire: `start = floor(now/1000) - floor(clampedPosition)`, `end = start + floor(duration)`; `now` enters as milliseconds. `now` is the instant the position was **sampled**, never the instant the payload is sent: the anchor is a function of the sample alone, so rebuilding one sample yields a byte-identical activity and no watchdog tick, coalesced send or replay can move the bar. `sampleAt` prefers the content script's own stamp, falls back to worker receipt time, and ignores a stamp more than five seconds ahead of that receipt time as junk — the reference is always a stored instant, never a clock read at build time. Missing elapsed or duration means no timestamps; elapsed and duration are never invented. |

The native host uses nonce-matched Discord IPC frames and retries after disconnect. The extension sends the current desired state on reconnect; the host replays its last activity across a pipe reconnect. The anchor is a function of the sample, never of the send, so that replay re-emits the same `start` instead of restarting the progress bar at replay time.

## Extraction and limits

Metadata precedence is MediaSession, Music player bar, JSON-LD, Open Graph title, then document title. Playback values come from the real media element only; JSON-LD duration may help identify a track, but does not create an elapsed position or make a paused/missing media element into playing playback. Text and URLs are bounded before they cross the boundary. The content script runs only in the top frame, ignores `timeupdate`, and clears the tab on pagehide or navigation off Music.

The worker publishes the selected tab's latest state: ordinary updates are paced at one per 1.5 s with a ceiling of eight per rolling 20 s, so a seek or a pause lands within 1.5 s while the eight-per-20 s ceiling has room. A change of identity — a new track, artist line or album — is published immediately, even inside that 1.5 s floor, so switching songs is instant; the floor and that immediate change both hold only while the eight-per-20 s ceiling has room, and past it the next update waits for the window to expire. A queued update is dropped when the desired card returns to the published one or when the port dies, so a payload queued for a state that is no longer true is never sent later. Two edges remain: a rate change the player never reports can mask or delay one drift report until the next poll, and buffering can still produce a single report. The native host keeps its own budget and that budget is deliberately looser than the worker's: it never adds latency to a send the worker already allowed, it only guards the pipe against a runaway client. The worker persists tab state through service-worker suspension. Presence off sends an explicit clear and closes the port. Page/player DOM redesigns can still require selector updates; the extension does not inspect or capture media streams.

## Rate tracking

Discord's activity timer counts `floor(now − start)` in wall time, and no RPC field carries a playback rate, so a `start`/`end` pair anchored once would fall behind a track played faster or slower than 1× — the card cannot literally run at 1.5×. While the rate is not 1× the extension re-anchors at most once every 2.5 s and biases the reference instant by half that interval's drift, `(rate − 1) × 1.25 s`, so the displayed time oscillates symmetrically around the real position instead of lagging and snapping back: about ±0.6 s at 1.5× and about ±1.25 s at 2×. That is eight re-anchors per rolling 20 s, the ordinary ceiling. At 1× no re-anchor runs and pacing is unchanged.
