# Spotify-framing Rich Presence for YouTube Music — design

Date: 2026-11-11
Package: `packages/web-discord-rpc` (v1.0.4 → 1.1.0)
Status: decided, ready to build

## Intent

The card Discord renders for this extension should read exactly like the card the
official Spotify connection renders, and every visible element should be a door
to the real thing: the song title opens the song, the artist line opens the
artist, the album art opens the album.

Two things block that today: the payload wastes its click targets on a single
generic button, and the timestamps are sent in milliseconds to an RPC endpoint
that expects seconds (Discord's own `SET_ACTIVITY` example uses `time(nullptr)`).
The second one is invisible in tests and wrong on screen.

## Field parity with Spotify (the contract)

Official Spotify activity, observed payload and rendered card (see
`C:\Users\nathan\AppData\Local\Temp\opencode\reports\spotify-presence-reference.md`):

| Spotify field | Rendered as | Our field | Source |
| --- | --- | --- | --- |
| `name` + `type: 2` | "Listening to Spotify" | `name: "YouTube Music"`, `type: 2` | static |
| `details` | track title | `details` | `title` |
| `state` | artists, `"; "`-separated | `state` | artist anchors joined with `"; "` |
| `assets.large_image` | album art | `assets.large_image` | `artworkUrl` |
| `assets.large_text` | album (tooltip only) | `assets.large_text` | `album`, only when distinct |
| — | no small image | *omitted* | — |
| `timestamps.start` / `.end` | progress bar / timer | `timestamps` in **seconds** | real media clock |
| — | no RPC buttons (native ones instead) | 2 buttons | see below |

Our activity keeps `status_display_type: 1` so the member list reads
"Listening to \<artist\>". Spotify omits the field; the expanded card is
unaffected either way. This is a deliberate divergence, documented as before.

## Click targets (the part the owner asked for)

| What the user clicks | Field | Value |
| --- | --- | --- |
| Track title line | `details_url` | canonical `https://music.youtube.com/watch?v=<id>` |
| Artist line | `state_url` | first artist anchor (`/channel/UC…`) |
| Album art | `assets.large_url` | album page (`/browse/MPRE…`), else artist, else track |
| Button 1 — "Listen on YouTube Music" | `buttons[0].url` | canonical track URL |
| Button 2 — "View album" / "View artist" | `buttons[1].url` | album page when an album exists, else artist channel |

`details_url`, `state_url`, `large_url` are part of the RPC `SET_ACTIVITY` shape
(docs example, 256-char cap). Their rendering in the current desktop client is
unverified, which is why the two buttons duplicate the two most valuable targets:
the song always has a button, and the album or artist always has one. Four doors
total, no target lost if any single one is ignored.

Rejected alternatives: two buttons only (one of song/artist/album is always
unreachable); rotating buttons on a timer (15 s RPC cadence, visible flicker,
untestable).

## Calls I made

1. **Artist text comes from the artist anchors only, joined `"; "`** — an
   anchor is an artist anchor when its href contains `/channel/`. The album
   anchor never enters the state line. Names are never split or rewritten: a
   single anchor keeps its own punctuation, so "Tyler, The Creator" survives.
   Fallback order: artist anchors → MediaSession artist → byline segment.
2. **An album URL requires an album id.** `albumUrl` is accepted only from a
   href matching `/browse/MPRE` (album browse ids); `/browse/VL…` is a playlist
   and is rejected. The `.complex-string` fallback is therefore read as "all
   anchors, take the last one that matches", not via `:last-child`, because the
   fake selector engine cannot express that pseudo-class and a rejected link is
   better than a wrong one. Album *text* and album *URL* come from the same
   anchor when it exists, so the tooltip can never name a different album than
   the link opens; MediaSession supplies the text only when there is no anchor.
3. **Button 2 is decided by URLs, never by text.** `albumUrl` present → "View
   album"; else `artistUrl` present → "View artist"; neither → one button.
   An album name with no album link never produces a "View album" button.
4. **`state_url` follows the line it belongs to.** Artist state → `artistUrl`;
   album-fallback state → `albumUrl`; anything else → omitted. A null
   `artistUrl` never borrows the album link, because the artist line would then
   open the wrong page.
5. **Relative hrefs are resolved without the `URL` global.** The extractor is a
   classic content script and its test harness is a bare `vm`; a small
   `absoluteUrl(href, base)` regex helper (scheme + host + leading slash) keeps
   the file dependency-free and keeps the tests honest.
6. **No small image.** Spotify sends none. A play/pause badge is a PreMiD
   flourish, not parity.
7. **No `&t=` on the track URL.** Matches "Play on Spotify" and PreMiD; the
   label promises the song, not the offset.
8. **Canonical track URL, never the current page URL.** YouTube Music is an SPA
   and the address bar stays on Home/Explore while a song plays, so the current
   button often lands on the home page. The track id is read from the player bar
   title link (or `a.ytp-title-link`, canonical link, `?v=`, then `mediaId`) and
   the URL is rebuilt. `pageUrl` remains only as the last-resort button URL.
9. **Album art opens the album page** (`large_url`), falling back to artist, then
   track. The artwork is the album's face; that is the least surprising target.
10. **Timestamps are integer seconds on the wire.** `start = floor(now/1000) −
    floor(position)`, `end = start + floor(duration)`. Unchanged rules: only while
    playing, only with a finite position and positive duration, dropped when
    paused, never invented.
11. **Links cap at 256 characters** (Discord's `*_url` limit); button URLs keep
    their 512 cap and labels 32. All link fields must be `https` on
   `music.youtube.com` — the same host policy as today. A rejected link is
   omitted, never emitted bare.

## Extraction contract (`extract-youtube.js`)

New nullable state fields, never thrown:

- `trackUrl` — canonical `https://music.youtube.com/watch?v=<id>` built from the
  resolved track id; `null` when no id resolves.
- `artistUrl` — absolute URL of the first anchor in the player-bar byline whose
  href contains `/channel/`.
- `albumUrl` — absolute URL of the first anchor in the byline whose href matches
  `/browse/MPRE`, else the last such anchor in
  `.complex-string.ytmusic-player-bar`. Playlist browse ids (`/browse/VL…`) are
  rejected.

Selector additions, all taken from PreMiD's live-tested YouTube Music presence
(`PreMiD/Activities`, `websites/Y/YouTube Music/dataGetter.ts`). They are written
in the forms the package's fake selector engine can match — no `:last-child`, no
`[href]` — with the last-anchor rule applied in code:

- title link: `ytmusic-player-bar .title a`, `.middle-controls .title a`
- byline links: `.byline.ytmusic-player-bar a`, `ytmusic-player-bar .subtitle a`
- album link fallback: every `a` in `.complex-string.ytmusic-player-bar`, keep
  the last one matching `/browse/MPRE`
- track id fallbacks: `a.ytp-title-link`, `link[rel="canonical"]`, `?v=`,
  existing `mediaIdFrom`
- artwork: existing `ytmusic-player-bar img`, plus `img.image`, `#song-image img`

Links are resolved against the current `location.href` through a new
`absoluteUrl(href, base)` regex helper in the extractor — the file stays free of
the `URL` global because it runs as a classic content script and its tests run in
a bare `vm` — then filtered through the existing https + Music-host policy
before leaving the extractor.

If the fake selector engine cannot express an attribute selector like
`link[rel="canonical"]`, extend the engine in
`test/extension/helpers/fake-page.mjs` rather than weakening the extractor: the
harness must be able to prove the selector it tests.

`content.js` and `background.js` need no change: the whole state object already
crosses the boundary and `buildActivity(best.state, now())` receives it.

## Activity contract (`activity.js`)

Exactly these fields, in this order, when the data exists:

```js
{
  name: "YouTube Music",
  type: 2,
  details,                 // track, ≤128
  details_url,             // trackUrl, ≤256
  state,                   // artists / album fallback / "YouTube Music", ≤128
  state_url,               // artistUrl when state is artists, else albumUrl
  status_display_type: 1,
  assets: { large_image, large_text?, large_url? },
  buttons: [{ label, url }, { label, url }?],
  timestamps: { start, end }   // integer seconds
}
```

Rules that do not change: `title` required; text collapsed and capped; artwork
must be https; one activity per state; clock only from the real media element.

## Version and docs

`1.1.0` aligned in `package.json`, `manifest.json`, root `package-lock.json`
entry, root `README.md` table, `CHANGELOG.md`, and the hardcoded assertion in
`test/docs.test.mjs`. README and ARCHITECTURE gain the click-through and the
seconds rule; the docs-as-contract tests keep their existing regexes satisfied
(`static name`, `artist in state`, `status_display_type: 1`, real position,
positive duration, never invented).

## Non-goals

Other services, transport options, privacy mode, ads/podcasts handling, party or
"Listen Along" (not reachable from a third-party RPC sender), uploaded app
assets, i18n.

## Anti-goals

Fabricated URLs or ids. A link that leaves `music.youtube.com`. More than two
buttons. Breaking the never-throw extractor. A test that asserts milliseconds.

## Verification

```
npm test --workspace=packages/web-discord-rpc
node packages/web-discord-rpc/native/host.mjs --selftest
node packages/web-discord-rpc/scripts/install-host.mjs --check
```

Live Discord rendering of `details_url` / `state_url` / `large_url` remains
unverified by construction; the unit assertions stop at the outgoing payload and
the two buttons guarantee a path to song and album/artist regardless.
