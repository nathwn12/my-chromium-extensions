# Report — wdr-music-any-page

## Outcome

`extract-youtube.js` now treats a media id as an eligibility requirement only for `youtube`; `youtube-music` is eligible on any page of the host when a title resolves (session, player bar, JSON-LD, og:title or document title), with `mediaId` staying `null` when the URL carries none. A Home/Explore/shelf page whose player bar is playing now yields a full state instead of `null`; a music page with no title, and every YouTube page without a media id, still yield `null`. `docs/ARCHITECTURE.md`'s `wdr-gone` sentence now says the music player persists across pages, so a gone only follows when no title resolves. Committed as `1193457`.

## Evidence

Red first, before touching the extractor:

```text
$ node --test packages/web-discord-rpc/test/extension/extract-youtube.test.mjs
✖ YouTube Music on Home reports the persistent player without a media id (0.5283ms)
  AssertionError [ERR_ASSERTION]: a Home page whose player bar is playing must not be null
      at TestContext.<anonymous> (file:///Q:/PROJECTS/PERSONAL/my-chromium-extensions/packages/web-discord-rpc/test/extension/extract-youtube.test.mjs:258:10)
  actual: null
  expected: true
ℹ tests 15
ℹ pass 14
ℹ fail 1
Exit code: 1
```

Green after the smallest change:

```text
$ node --test packages/web-discord-rpc/test/extension/extract-youtube.test.mjs
✔ YouTube Music on Home reports the persistent player without a media id (0.3963ms)
ℹ tests 15
ℹ pass 15
ℹ fail 0
```

The brief's full check, at commit `1193457`:

```text
$ node --test packages/web-discord-rpc/test/extension/extract-youtube.test.mjs packages/web-discord-rpc/test/extension/content.test.mjs && npm test && node scripts/verify-integration.mjs && node packages/web-discord-rpc/native/host.mjs --selftest && node packages/web-discord-rpc/scripts/e2e-ipc.mjs
✔ YouTube Music on Home reports the persistent player without a media id (0.5217ms)
ℹ tests 226
ℹ pass 226
ℹ fail 0
verify-integration: 16/16 wiring points hold
selftest: PASS (10/10)
e2e-ipc: PASS (7/7)
EXIT=0
```

`git status --short` after the commit prints only the lead's `.stack/ledger.md` modification and the untracked brief, neither mine:

```text
 M .stack/ledger.md
?? .stack/briefs/wdr-music-any-page.md
```

## Unverified

- Nothing was tested in a live browser or against the owner's Discord pipe. The fake page reproduces the screenshot's furniture (title, byline, artwork, playing video) and the command proves extraction and the wire contract, not the real YouTube Music DOM.
- The pre-existing sentence at `docs/ARCHITECTURE.md:131` ("Eligibility: the URL must be https: on a YouTube host **and** carry a watch media id") is now stale for YouTube Music. The brief said to correct only the line-140 sentence and "change nothing else", so it is untouched; it needs one follow-up line.

## Scope

- `packages/web-discord-rpc/extract-youtube.js` — RULES `eligibility.requiresMediaId`, the source-aware gate, and the title-resolves gate.
- `packages/web-discord-rpc/test/extension/extract-youtube.test.mjs` — one new test.
- `packages/web-discord-rpc/docs/ARCHITECTURE.md` — the one `wdr-gone` sentence.
- Nothing else touched. `content.js`, the worker, the host and the copy are unchanged.

## Lesson

The old gate encoded one page's rule for two sites: YouTube's identity lives in the URL, YouTube Music's lives in the persistent player bar. When two sources share an extractor, any gate written for one should name the sources it binds (here `RULES.eligibility`) rather than sit unqualified in `readUnsafe`. Also watch for eligibility prose duplicated outside the table: fixing the sentence the brief names can leave an earlier doc sentence false, so the lead should sweep every "must carry" claim when a gate loosens.
