# Seam site-disable-cancels-queue: switching a site off cancels its queued update

**Owner of this seam:** one `employee` employee. **Written by:** the lead. **State:** briefed.

## Why now

The independent audit found that setSiteEnabled sends a clear without resetting the source limiter, so a previously queued non-null payload can flush and republish after the site is off.

## Out

When a site is switched off, its coalescing limiter is reset before the clear is delivered, so an activity already queued in that site's window can never be published after the clear; a regression test proves the queued payload does not resurface.

## Check

```text
node --test packages/web-discord-rpc/test/extension/background.test.mjs
```

It passes only when the command exits 0 and the output shows the new behaviour.
A check that cannot go red is not a check.

## Owns

- `packages/web-discord-rpc/background.js`
- `packages/web-discord-rpc/test/extension/background.test.mjs`

## Files (exact, exclusive)

- `packages/web-discord-rpc/background.js`
- `packages/web-discord-rpc/test/extension/background.test.mjs`

No other seam may touch these. No other file is yours.

## Do not touch

- `packages/web-discord-rpc/config.js`
- `packages/web-discord-rpc/options.*`
- `packages/web-discord-rpc/popup.*`
- `packages/web-discord-rpc/native/**`
- `packages/web-discord-rpc/README.md`
- `packages/web-discord-rpc/docs/**`

## Read first

- `.stack/goal.md`
- `packages/web-discord-rpc/background.js`
- `packages/web-discord-rpc/test/extension/background.test.mjs`
- `.stack/reports/youtube-presence-settings.md`

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

Write `.stack/reports/site-disable-cancels-queue.md` with these five headings, all mandatory:

```text
## Outcome     what shipped, two or three sentences
## Evidence    the command and the real output at the head you hand back
## Unverified  every claim you did not check, and why; "none" is a claim
## Scope       paths touched, each inside Owns, or why not
## Lesson      one paragraph the next employee should know
```

Then return one paragraph: outcome, commits, check result, concerns.

## Known defect (from the independent audit)

setSiteEnabled(source, false) in ackground.js sets desired to null, persists, and calls deliver(source, null) straight down the port. It does not touch that source's coalescing limiter. The limiter created by limiterFor(source) may still hold a deferred payload and a timer from earlier push calls, so after the clear it can flush a non-null activity and publish presence for a site that is off. The incoming-message filter (if (!siteEnabled.get(source)) return;) does not help: the limiter's send callback calls deliver directly.

Required fix: reset that source's limiter as part of disabling, before the clear is delivered (const limiter = limiters.get(source); if (limiter) limiter.reset();). eset() already drops the pending payload, the history, and the timer.

Required test (watched red first): with injected 
ow/schedule/cancel, push enough updates to exhaust MAX_UPDATES and leave one payload pending; disable the site; fire the pending timer callback; assert the last delivered activity is the clear (ctivity: null) and no non-null activity is posted after it.