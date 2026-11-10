# Report: wdr-surfaces-artist

## Outcome

The popup's Music row now reads `A Song` / `An Artist — An Album` and the options Music row reads `A Song — An Artist — An Album`, both by resolving the artist from `activity.name` (already carried by activity.js 1.0.2) when that name is not a static source label and differs from `activity.state`. YouTube rows are untouched: popup still shows the title / channel and options still shows `title — channel`. Committed as `753bb81` with exactly the three owned files; version not bumped.

## Evidence

Red first — the new fixture and assertion, before the two surfaces changed:

```text
PS> node --test packages/web-discord-rpc/test/extension/ui.test.mjs
✖ Music rows read the artist from the activity name; YouTube rows still read only the channel (1.7763ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected

  + 'An Album'
  - 'An Artist — An Album'
         ^

      at TestContext.<anonymous> (file:///Q:/PROJECTS/PERSONAL/my-chromium-extensions/packages/web-discord-rpc/test/extension/ui.test.mjs:549:12)
ℹ tests 23
ℹ pass 22
ℹ fail 1
EXIT=1
```

Green — the brief's check, exactly, at the committed head:

```text
PS> node --test packages/web-discord-rpc/test/extension/ui.test.mjs && npm test
node-ui-exit=0 npm-test-exit=0
ℹ tests 196
ℹ pass 196
ℹ fail 0
ℹ tests 12
ℹ pass 12
ℹ fail 0
ℹ tests 229
ℹ pass 229
ℹ fail 0
```

`node --test` alone at the same head: 23 tests, 23 pass, 0 fail. Commit: `753bb81 web-discord-rpc: show the Music artist on the popup and options rows` — 3 files changed, 65 insertions(+), 2 deletions(-).

## Unverified

None of the claims about the shipped diff are unchecked: the assertions run the real controller modules over the real markup through `fake-ui.mjs`, and both exit codes were read. The brief's descriptive claim that BOTH `describeActivity` copies return `{title, detail}` is false — options.js returns one joined string and its caller renders one element. I applied the identical artist rule, not an identical return shape, because changing options' signature would have broken its existing tests and violated "nothing else in either file changes". Not verified: whether a real Chrome/Discord round-trip renders identically to the fake DOM; the seam has no browser check and the brief names none.

## Scope

- `packages/web-discord-rpc/popup.js` — artist resolution in `describeActivity`, detail becomes `artist — state` (or `artist` when state empty), otherwise state as before.
- `packages/web-discord-rpc/options.js` — the same artist block, joined as `details — detail` by the existing parts/join.
- `packages/web-discord-rpc/test/extension/ui.test.mjs` — one `MUSIC` fixture after `CONNECTED` and one cross-surface test at the end; no existing assertion changed.
- Committed only those three paths. `.stack/ledger.md` and `.stack/briefs/wdr-surfaces-artist.md` were already dirty/untracked before this seam and were left alone.

## Lesson

The two `describeActivity` functions were never textually identical, so "keep them textually identical" can only mean the artist rule — copy that block exactly and let each function keep its own return contract. The discriminator is `activity.name`, not the source: the state payload carries no source key by the time the UI sees it, so the static labels `YouTube` and `YouTube Music` plus the `name !== state` guard are the whole test. A one-fixture, cross-surface test catches both surfaces in one red; splitting popup and options would let one drift green.
