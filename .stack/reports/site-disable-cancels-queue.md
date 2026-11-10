# site-disable-cancels-queue report

## Outcome

`setSiteEnabled(source, false)` now resets that source's coalescing limiter before it delivers the clear, so a payload already queued in the site's send window cannot flush and republish presence after the site is switched off. One regression test exhausts the per-source budget, leaves a deferred frame armed, disables the site, fires the leftover timer and asserts no YouTube frame follows the clear.

## Evidence

Re-run by the lead at the handed-back tree, exit 0:

```text
$ node --test packages/web-discord-rpc/test/extension/background.test.mjs
ℹ tests 35
ℹ pass 35
ℹ fail 0
EXIT=0
```

Red was watched first by the employee at the same command: `tests 35 / pass 34 / fail 1`, the failure being a non-null activity frame (`youtube:6`) surfacing after the clear, before the fix. The wider directory guard was `node --test packages/web-discord-rpc/test/extension/` at 128/128.

## Unverified

- The full `npm test` has not been run since this change; the package suite is the next gate.
- The burst-then-toggle scenario was not replayed live in a browser against Discord; the limiter clock is injected in the test.
- Multi-tab races inside one site's window were not exercised.

## Scope

Exactly two files, both inside the brief's Files: `packages/web-discord-rpc/background.js` (+4 lines: the limiter lookup and reset) and `packages/web-discord-rpc/test/extension/background.test.mjs` (+33 lines: the regression test and the `MAX_UPDATES` import).

## Lesson

A clear that bypasses the send budget does not cancel the budget's queue. Any path that publishes past a limiter must reset that limiter, or the deferred payload it left behind becomes the last word.
