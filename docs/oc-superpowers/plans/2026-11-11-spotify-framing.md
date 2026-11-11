# Spotify-framing presence — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use oc-superpowers:orchestrate to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Discord card for YouTube Music matches Spotify's field-for-field, and the track title, artist line, album art and both buttons open the real song, artist and album.

**Architecture:** The extractor gains three nullable URL fields (`trackUrl`, `artistUrl`, `albumUrl`) read from the player-bar anchors; the activity builder places them on `details_url` / `state_url` / `large_url` plus two buttons and switches timestamps to integer seconds. Docs and version move together because `test/docs.test.mjs` enforces them.

**Tech Stack:** Plain ES modules, MV3 content scripts, `node:test` + `assert/strict`, npm workspaces. No build step, no TypeScript, no lint for this package.

**Spec:** `docs/oc-superpowers/specs/2026-11-11-spotify-framing-design.md`

## Global Constraints

- Package path: `packages/web-discord-rpc`; work on branch `feat/spotify-framing`.
- New version: `1.1.0` everywhere (`package.json`, `manifest.json`, root `package-lock.json` entry, root `README.md` table, `CHANGELOG.md`, `test/docs.test.mjs` assertion).
- Discord limits: `details`/`state`/`large_text` ≤ 128; `details_url`/`state_url`/`large_url` ≤ 256; button label 1–32; button URL 1–512; max 2 buttons.
- Every URL leaving the builder is `https` on `music.youtube.com`; a rejected URL is omitted, never emitted bare.
- Timestamps on the wire are integer **seconds**: `start = Math.floor(now/1000) - Math.floor(clampedPosition)`, `end = start + Math.floor(duration)`.
- The extractor never throws; every field is nullable; nothing is invented.
- No small image, no party, no third button, no `&t=` parameter.

## File Structure

| File | Responsibility |
| --- | --- |
| `extract-youtube.js` | DOM/MediaSession → nullable state, now including the three URLs and `"; "`-joined artist anchors |
| `activity.js` | state → `SET_ACTIVITY` activity; the only place that decides fields, caps and seconds |
| `test/extension/extract-youtube.test.mjs` | selector and URL-resolution cases |
| `test/extension/activity.test.mjs` | exact payload assertions |
| `test/extension/helpers/fake-page.mjs` | fake `document`/`navigator` used by extractor tests |
| `test/extension/background.test.mjs` | worker-level frame assertion (seconds) |
| `test/docs.test.mjs` | docs-as-contract + version alignment |
| `README.md`, `docs/ARCHITECTURE.md`, `CHANGELOG.md` | the contract in prose |

## Review Focus

1. A song played from Home/Explore, where the address bar is not a watch URL — the track link and button must still point at the song, not the home page.
2. A track with no album (single, live take) — no album link, artist link present, one valid button, no empty `assets.large_url`.
3. Punctuation-heavy or multi-artist names ("Tyler, The Creator", three anchors) — joined with `"; "` only between anchors, never re-split inside one, `state` ≤ 128.
4. A byline with no anchors, or a non-`/channel/` artist (local upload, topic channel) — no fabricated URLs, no crash, payload still valid.
5. A paused track — no `timestamps` key at all, and no `end` when duration is unknown.

---

### Task 1: Extractor emits the three click targets

**Files:**
- Modify: `packages/web-discord-rpc/extract-youtube.js` (`RULES.dom`, `readMusicDom`, `readUnsafe`)
- Test: `packages/web-discord-rpc/test/extension/extract-youtube.test.mjs`
- Test helper: `packages/web-discord-rpc/test/extension/helpers/fake-page.mjs` (only if the fixture cannot express player-bar anchors today)

**Interfaces:**
- Consumes: existing `queryOne`, `queryAll`, `clean`, `httpsUrl`, `sourceForHref`, `mediaIdFrom`, `hrefOf` inside the IIFE.
- Produces: `readUnsafe()` returns the existing shape plus `trackUrl: string|null`, `artistUrl: string|null`, `albumUrl: string|null`; `channel` becomes the artist anchors' text joined with `"; "` when ≥ 1 artist anchor exists.

**Selector additions (verbatim, from PreMiD's live-tested YouTube Music presence):**

```js
musicTitleLink: ["ytmusic-player-bar .title a", ".middle-controls .title a"],
musicBylineLinks: [".byline.ytmusic-player-bar a", "ytmusic-player-bar .subtitle a"],
musicAlbumLink: [".complex-string.ytmusic-player-bar a"],  // take the LAST one matching /browse/MPRE
musicArtwork: "ytmusic-player-bar img, ytmusic-player-bar img.image, #song-image img",
trackIdFallbacks: ["a.ytp-title-link", 'link[rel="canonical"]']
```

No `:last-child` and no `[href]` in any selector: apply both rules in code
(`a.getAttribute("href")` truthiness, last match wins). Anchors are resolved by
a new `absoluteUrl(href, base)` regex helper — the extractor must not depend on
the `URL` global, which its `vm` harness does not provide.

- [ ] **Step 1: Write the failing tests**

In `test/extension/extract-youtube.test.mjs`, add cases that (a) assert `state.trackUrl === "https://music.youtube.com/watch?v=dQw4w9WgXcQ"` when the address bar is `https://music.youtube.com/` and the player-bar title anchor is `watch?v=dQw4w9WgXcQ`, (b) assert `artistUrl` from a relative `channel/UCabc` anchor and `albumUrl` from a relative `browse/MPREb123` anchor, (c) assert `channel === "A; B"` for two artist anchors but `channel === "Tyler, The Creator"` unchanged for one, (d) assert all three fields are `null` when the byline has no anchors, (e) assert an anchor on `https://www.youtube.com/channel/UCx` yields `artistUrl === null`, and (f) assert a `browse/VLplaylist` anchor yields `albumUrl === null`.

If the fake page cannot express these anchors or attribute selectors, extend `test/extension/helpers/fake-page.mjs` first — the harness must prove the selectors the extractor ships.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/extension/extract-youtube.test.mjs` (cwd `packages/web-discord-rpc`)
Expected: FAIL — `state.trackUrl` is `undefined`.

- [ ] **Step 3: Implement**

Add the selector entries above to `RULES.dom`. In `readMusicDom`, collect byline anchors, classify by href (`/channel/` → artist, `/browse/` → album), resolve them against `loc.href` with `new URL(href, base)`, and pass each candidate through the existing `https` + Music-host check (reuse `pageUrlFor(absolute, "youtube-music")`). Resolve the track id in order: title-anchor `v=`, `a.ytp-title-link` `href`, `link[rel=canonical]` `href`, `mediaIdFrom(loc.href)`, existing `mediaId`; build `"https://music.youtube.com/watch?v=" + id`. In `readUnsafe`, thread `dom.artistUrl`, `dom.albumUrl`, `dom.trackUrl` into the returned object with `pageUrl`/`mediaId` unchanged.

- [ ] **Step 4: Run all extractor tests**

Run: `node --test test/extension/extract-youtube.test.mjs`
Expected: PASS, including the pre-existing cases.

- [ ] **Step 5: Commit**

```bash
git add packages/web-discord-rpc/extract-youtube.js packages/web-discord-rpc/test/extension/extract-youtube.test.mjs
git commit -m "feat(presence): extract track, artist and album links"
```

---

### Task 2: Activity carries Spotify's fields and four click targets

**Files:**
- Modify: `packages/web-discord-rpc/activity.js`
- Test: `packages/web-discord-rpc/test/extension/activity.test.mjs`

**Interfaces:**
- Consumes: `state.trackUrl`, `state.artistUrl`, `state.albumUrl` from Task 1 (nullable), plus the existing state fields.
- Produces: `buildActivity(...)` returning the exact shape below; new module constant `MAX_LINK_URL = 256`; exported `pickLinkUrl(raw)` returning a validated `music.youtube.com` https URL ≤ 256 or `null`.

```js
{
  name: "YouTube Music",
  type: 2,
  details,
  details_url,          // only when a track URL exists
  state,
  state_url,            // artist URL when state is the artists, album URL when state fell back to the album
  status_display_type: 1,
  assets: { large_image, large_text?, large_url? },
  buttons: [{ label, url }, { label, url }?],
  timestamps: { start, end }   // integer seconds
}
```

- [ ] **Step 1: Write the failing tests**

In `test/extension/activity.test.mjs`, replace the golden `deepEqual` with the new shape and add: (a) a full-`musicState()` golden including `details_url`, `state_url`, `assets.large_url` and two buttons; (b) a no-album case asserting `state_url` is the artist URL, `large_url` is the artist URL and button 2 is `{ label: "View artist", url: artistUrl }`; (c) a no-links case asserting `details_url`/`state_url`/`large_url` are absent and one button remains; (d) a `state` fallback-to-album case where `state_url` is the album URL; (e) a 300-character `trackUrl` case asserting the field is omitted; (f) an `artistUrl` on `https://www.youtube.com/...` case asserting omission; (g) timestamps asserted in seconds (`start: 1_700_000_000 - 5`, `end: 1_700_000_000 - 5 + 200`), with the paused case still having no `timestamps` key.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/extension/activity.test.mjs`
Expected: FAIL on the new fields.

- [ ] **Step 3: Implement**

Add `MAX_LINK_URL = 256` and `pickLinkUrl` (https + `music.youtube.com` + length). Set `details_url` from the track URL, `state_url` from the artist URL when the state line is the artists and from the album URL when it fell back, and `assets.large_url` from album → artist → track. Keep `meta.buttonLabel` for button 1 targeting the track URL with `pageUrl` as last resort; append button 2 `{ label: albumUrl ? "View album" : "View artist", url }` only when the matching URL exists. Change the timestamp arithmetic to integer seconds as stated in Global Constraints. Update the header comment to drop the "album survives only as a tooltip" claim and describe the four click targets.

- [ ] **Step 4: Run the builder tests**

Run: `node --test test/extension/activity.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web-discord-rpc/activity.js packages/web-discord-rpc/test/extension/activity.test.mjs
git commit -m "feat(presence): spotify-parity fields, links in seconds"
```

---

### Task 3: Worker test, docs and version follow the new contract

**Files:**
- Modify: `packages/web-discord-rpc/test/extension/background.test.mjs` (timestamp expectations → seconds)
- Modify: `packages/web-discord-rpc/README.md`, `packages/web-discord-rpc/docs/ARCHITECTURE.md`, `packages/web-discord-rpc/CHANGELOG.md`
- Modify: `packages/web-discord-rpc/package.json`, `packages/web-discord-rpc/manifest.json`, `package-lock.json` (root), `README.md` (root), `test/docs.test.mjs`

**Interfaces:**
- Consumes: the payload shape from Task 2.
- Produces: version `1.1.0` aligned in six places; ARCHITECTURE's field table listing the three `*_url` rows, the two buttons and the seconds formula.

- [ ] **Step 1: Update the worker test and run it against Task 2's code**

Change `test/extension/background.test.mjs`'s timestamp assertions from `BASE - 40 * SECOND` to `Math.floor(BASE / 1000) - 40` (and the same shape for the second case), then run `node --test test/extension/background.test.mjs`; expect PASS once Task 2 is merged.

- [ ] **Step 2: Update the prose**

README: one paragraph naming the four click targets and the seconds rule, keeping the existing regexes (`static name \`YouTube Music\``, `artist in \`state\``, `status_display_type: 1`, "only user-facing preference", "not Discord's rendered UI", "real position", "positive duration", "never invented"). ARCHITECTURE: extend the field table with `details_url` / `state_url` / `large_url` (256 cap, Music host) and `buttons` (max two, second is album-or-artist), and restate the timestamp formula in seconds. CHANGELOG: add `[1.1.0] — 2026-11-11` with three bullets: Spotify-parity field mapping, click-through to song/artist/album, timestamps corrected to seconds.

- [ ] **Step 3: Bump the version in all six places**

`package.json`, `manifest.json`, `package-lock.json` (`packages/web-discord-rpc.version`), root `README.md` table row, `CHANGELOG.md` heading, and the `1.0.4` literals in `test/docs.test.mjs` → `1.1.0`.

- [ ] **Step 4: Run the full package suite**

Run: `npm test --workspace=packages/web-discord-rpc` (cwd: repo root)
Expected: PASS, zero failures; e2e integration tests are win32 and run here.

- [ ] **Step 5: Run the host checks**

Run: `node packages/web-discord-rpc/native/host.mjs --selftest` and `node packages/web-discord-rpc/scripts/install-host.mjs --check`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/web-discord-rpc README.md package-lock.json test/docs.test.mjs
git commit -m "docs(presence): 1.1.0 click-through contract"
```

---

## Self-review

- Spec coverage: field parity → Task 2; four click targets → Tasks 1–2; seconds → Tasks 2–3; version/docs alignment → Task 3; anti-goals → asserted in Task 2's omission tests.
- Type consistency: `trackUrl` / `artistUrl` / `albumUrl` names are identical in Tasks 1, 2 and the spec; `pickLinkUrl` is introduced once.
- Review Focus items 1–5 each have a test in Task 1 (1, 3, 4) or Task 2 (2, 5, plus 3's 128-cap via the existing cap test).
