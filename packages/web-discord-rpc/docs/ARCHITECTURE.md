# Architecture

Music-only presence from the page to Discord desktop. The extension never publishes YouTube video activity and does not offer transport or per-site configuration.

## Data flow

```text
music.youtube.com
  extract-youtube.js -> content.js -> background.js
  background.js -> Chrome native messaging -> native host -> Discord desktop IPC
```

`extract-youtube.js` reads media-session/player metadata and the actual `<audio>` or `<video>` element. `content.js` reports changes from media events, SPA navigation, visibility and page lifecycle; a one-second poll catches title/pause changes. `background.js` retains tab state in `storage.session`, selects the best playing tab, coalesces sends, and reconnects/replays after worker or Discord restarts. The accessible popup switch persists in `storage.local` and clears presence when switched off.

## Wire and activity

The worker opens one native port with `transport: "ipc"` and the built-in application id `1566530911514923188`. Only `source: "youtube-music"` reports are accepted. The host carries the activity to a Discord desktop named pipe; legacy YouTube reports are rejected by the extension path.

The outgoing `SET_ACTIVITY` activity is type `2` (LISTENING), with `name: "YouTube Music"`, title in `details`, artist in `state`, and `status_display_type: 1` to request that Discord use the state in its member list. The expanded header remains `Listening to YouTube Music`. Tests inspect the outgoing IPC payload; actual Discord rendering has not been observed in this seam.

| Field | Rule |
| --- | --- |
| `details`, `state` | Collapsed, trimmed text, capped at 128 characters. Artist is preferred for state; then a distinct album; then the source label. |
| `assets.large_image` | HTTPS artwork only. `large_text` is a distinct album tooltip only, never a repeated visible line. |
| `buttons` | At most one link, HTTPS and on `music.youtube.com`. |
| `timestamps` | Only when playing and both a real finite position and positive duration exist. `start = floor(now/1000)*1000 - floor(clampedPosition)*1000`; `end = start + floor(duration)*1000`. Missing elapsed or duration means no timestamps; elapsed and duration are never invented. |

The native host uses nonce-matched Discord IPC frames and retries after disconnect. The extension sends the current desired state on reconnect; the host replays its last activity across a pipe reconnect.

## Extraction and limits

Metadata precedence is MediaSession, Music player bar, JSON-LD, Open Graph title, then document title. Playback values come from the real media element only; JSON-LD duration may help identify a track, but does not create an elapsed position or make a paused/missing media element into playing playback. Text and URLs are bounded before they cross the boundary. The content script runs only in the top frame, ignores `timeupdate`, and clears the tab on pagehide or navigation off Music.

The worker publishes the selected tab's latest state, at most four ordinary updates per rolling 20 seconds, and persists tab state through service-worker suspension. Presence off sends an explicit clear and closes the port. Page/player DOM redesigns can still require selector updates; the extension does not inspect or capture media streams.
