# Seam wdr-music-any-page: YouTube Music playback from any page is detected

**Owner of this seam:** one `employee` employee. **Written by:** the lead. **State:** briefed.

## Why now

Owner screenshot: song playing on the YouTube Music home page, popup reads Nothing playing for both sites; extraction gates on a v= id that YouTube Music does not put in the URL when playback starts from a shelf.

## Out

With a song playing on music.youtube.com from Home, Explore or a shelf (URL without v=), the popup shows the track, artist and album instead of Nothing playing, while a YouTube browse page still reports nothing.

## Check

```text
node --test packages/web-discord-rpc/test/extension/extract-youtube.test.mjs packages/web-discord-rpc/test/extension/content.test.mjs && npm test && node scripts/verify-integration.mjs && node packages/web-discord-rpc/native/host.mjs --selftest && node packages/web-discord-rpc/scripts/e2e-ipc.mjs
```

It passes only when the command exits 0 and the output shows the new behaviour.
A check that cannot go red is not a check.

## Owns

- `packages/web-discord-rpc/extract-youtube.js`
- `packages/web-discord-rpc/test/extension/extract-youtube.test.mjs`
- `packages/web-discord-rpc/docs/ARCHITECTURE.md`

## Files (exact, exclusive)

- `packages/web-discord-rpc/extract-youtube.js`
- `packages/web-discord-rpc/test/extension/extract-youtube.test.mjs`
- `packages/web-discord-rpc/docs/ARCHITECTURE.md`

No other seam may touch these. No other file is yours.

## Do not touch

- `packages/web-discord-rpc/background.js`
- `packages/web-discord-rpc/bridge-status.js`
- `packages/web-discord-rpc/native/**`
- `packages/crunchy-presence/**`
- `README.md`
- `scripts/**`

## Read first

- `packages/web-discord-rpc/extract-youtube.js`
- `packages/web-discord-rpc/test/extension/extract-youtube.test.mjs`
- `packages/web-discord-rpc/test/extension/helpers/fake-page.mjs`
- `.stack/goal.md`

## Tier

standard. Multi-file coordination, ordinary care.

The archetype names the seat, and `routing.json` pins its model at install. The tier says how much judgement the brief expects, not which model runs: an expert seam is designed by the lead before it reaches you.

## Rules that bind this seam

1. Name the unknown before writing code. If this brief is wrong, say so in one message and stop; do not reinterpret it.
2. The smallest change that closes Out. No speculative flexibility.
3. Every changed line traces to Out. Orphans you created, you delete. Pre-existing dead code, you report.
4. Paste the command and its output in the report. A claim without a command is `Unverified`.
5. Never merge, never push a shared branch, never dispatch another agent. Two failures of the same command: stop and report.

## Report

Write `.stack/reports/wdr-music-any-page.md` with these five headings, all mandatory:

```text
## Outcome     what shipped, two or three sentences
## Evidence    the command and the real output at the head you hand back
## Unverified  every claim you did not check, and why; "none" is a claim
## Scope       paths touched, each inside Owns, or why not
## Lesson      one paragraph the next employee should know
```

Then return one paragraph: outcome, commits, check result, concerns.

## Known gap (proved by the owner'"'"'s screenshot plus a live Discord probe)

The owner'"'"'s music tab is playing (pause icon showing, 0:03/1:51) at URL `https://music.youtube.com` with **no `?v=`**: the song started from a Home shelf and YouTube Music never changed the URL. `extract-youtube.js readUnsafe()` runs `var mediaId = mediaIdFrom(href); if (!mediaId) return null;` for every source, so the tab reports nothing, the worker has no activity, and both surfaces say "Nothing playing". Clicking into a song page (`/watch?v=...`) worked earlier for the same reason. A live probe with the extension'"'"'s exact activity payload (name `YouTube Music`, `mp:` external artwork, button, timestamps) round-tripped through SET_ACTIVITY on the owner'"'"'s Discord pipe and echoed back accepted, so Discord is not the blocker: only extraction is.

Required shape (smallest change, keep the rules table as the one source of tunables):

1. **Red test first** in `test/extension/extract-youtube.test.mjs`: a `musicPage({ href: "https://music.youtube.com/", title: "PIXELATED KISSES", byline: [node("a",{text:"Joji"}), " • PIXELATED KISSES • 2025"], artwork: "https://lh3.googleusercontent.com/cover=w544-h544", children: [video({ currentTime: 3, duration: 111, paused: false })] })` must yield a non-null state with title, channel `Joji`, album `PIXELATED KISSES`, `mediaId: null`, `pageUrl: "https://music.youtube.com/"`, `paused: false`, `duration: 111`. Watch it fail before changing the extractor.
2. **Rule:** the media id is required only for `youtube` (a browse-page `h1` is a feed heading, not a video). For `youtube-music`, any page on the host may carry the persistent player: accept it when a title resolves from mediaSession, the player bar, JSON-LD, og:title or document title; return null when no title resolves. `mediaId` stays the parsed id when the URL has one, otherwise `null`. Put the difference in a named rule/comment, not an inline special case.
3. **Keep these true:** the existing test that `read` on `https://music.youtube.com/explore` with no player furniture is null must still pass; YouTube pages without a media id must still be null; every other existing extract test stays green untouched.
4. **Docs truth:** `docs/ARCHITECTURE.md:140` says `content.js` sends `wdr-gone` when "the URL stops being a watch URL". Correct that one sentence for YouTube Music (its player persists across pages, so a `wdr-gone` only follows when no title resolves), and change nothing else. `test/docs.test.mjs` must stay green.

Do not touch `content.js`, the worker, the host or the copy. `buildActivity` ignores `mediaId`, so a null id is safe. Commit the three files with a plain message, write the report with Outcome / Evidence (red then green) / Unverified / Scope / Lesson.