## Outcome

Shipped `packages/web-discord-rpc/extract-youtube.js` — a never-throwing classic content script (`globalThis.YoutubeExtract.sourceForLocation` / `.read`) that reads title, channel/artist, album, https artwork, page URL, media id and playback state from YouTube and YouTube Music using mediaSession, JSON-LD, DOM and the `<video>` element in that order. Shipped `content.js` — a reporter that sends `{t:"wdr-state", source, state}` (with `state.at`) and `{t:"wdr-gone", source, scope:"tab"}` on media events, `yt-navigate-finish` / `yt-page-data-updated`, `popstate`, `visibilitychange`, `pagehide` and a 1 s URL/title/pause poll, never on `timeupdate`, and no-ops outside the top frame. The test helper is a dependency-free fake page plus a vm harness that drives the timers by hand.

## Evidence

Red first, before either production file existed:

```text
PS> node --test packages/web-discord-rpc/test/extension/extract-youtube.test.mjs packages/web-discord-rpc/test/extension/content.test.mjs
Error: ENOENT: no such file or directory, open
  '...\packages\web-discord-rpc\extract-youtube.js'
ℹ tests 2  ℹ pass 0  ℹ fail 2
Exit code: 1
```

Sensitivity proof against the finished code: the top-frame guard was replaced with `if (false) return;`, which turned exactly one test red, then the file was restored byte-for-byte:

```text
✖ a subframe no-ops: only the top frame may report
ℹ pass 12  ℹ fail 1
```

Green, at the head handed back:

```text
PS> node --test packages/web-discord-rpc/test/extension/extract-youtube.test.mjs packages/web-discord-rpc/test/extension/content.test.mjs
✔ a watch page reports one wdr-state with source, state and at
✔ YouTube Music reports its own source
✔ a non-watch page reports nothing
✔ media events report; timeupdate is never listened to
✔ the 1 s poll reports a title or pause change once, then stays quiet
✔ same-URL SPA updates report immediately
✔ a watch-to-watch SPA navigation reports once the page settles
✔ navigating to a non-watch page sends one wdr-gone with scope tab
✔ pagehide sends wdr-gone with scope tab
✔ visibilitychange republishes the state with the new visible flag
✔ a throwing chrome.runtime.sendMessage never escapes the script
✔ content without the extractor does nothing and schedules no poll
✔ a subframe no-ops: only the top frame may report
✔ sourceForLocation maps only the https YouTube hosts
✔ read returns null off YouTube and off a watch page
✔ a YouTube watch page yields the whole state
✔ media ids parse from watch, shorts, live and embed paths
✔ a watch page without a video is paused with null playback numbers
✔ position is clamped to duration and NaN is null
✔ visible mirrors document.visibilityState exactly
✔ YouTube prefers og:image; a non-https artwork is dropped
✔ mediaSession fills title and channel when the DOM is bare
✔ YouTube Music reads song, artist and album from the player bar
✔ YouTube Music prefers mediaSession metadata and drops a lone artist byline
✔ JSON-LD is the fallback for title, channel, artwork and duration
✔ text is stripped, collapsed, de-noised and capped at 256
✔ read never throws, whatever the page hands it
ℹ tests 27  ℹ suites 0  ℹ pass 27  ℹ fail 0  ℹ cancelled 0  ℹ skipped 0  ℹ todo 0
Exit code: 0
```

## Unverified

- No real YouTube page was loaded; the extractor was proven against fixtures modelled on the live probe in `.stack/contracts.md`, not against the live DOM. Selector drift on the real site is unobserved.
- The background/worker side does not exist yet (`background.js` is another seam), so end-to-end delivery of these messages, and whether media-event frequency needs throttling there, is unverified.
- YouTube Music player-bar class names (`.title`, `.byline`, `img`) are from the reference page structure, not from a live probe; only the YouTube watch-page selectors were probed live.

## Scope

All inside Owns: `packages/web-discord-rpc/extract-youtube.js`, `packages/web-discord-rpc/content.js`, `packages/web-discord-rpc/test/extension/extract-youtube.test.mjs`, `packages/web-discord-rpc/test/extension/content.test.mjs`, `packages/web-discord-rpc/test/extension/helpers/fake-page.mjs`. No other file was created or edited; `manifest.json` already lists `extract-youtube.js` before `content.js` and was not touched. `package.json`'s `test` script does not yet include these two files — that file belongs to the scaffold seam.

## Lesson

The extractor and the reporter fail in opposite directions: the extractor must return a state on a watch page with every field null, while the reporter must treat that state as "gone" and stay silent until a title exists. Keep the watch-page gate (`mediaId != null`) in `read`, not in `content.js`, so a non-watch SPA navigation clears the tab on the same tick. In the vm harness, messages cross a realm boundary — JSON round-trip them before `deepStrictEqual`, or the assertion fails on prototypes while the payload is identical.
