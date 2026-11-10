# Digest — 2026-11-11 05:57

Rewritten by the lead. Newest first. An empty section is a true statement.

**Objective** — YouTube Presence (YouTube + YouTube Music, YouTube Music first, per-site toggles both/one) publishes to the installed Discord desktop over IPC; web/arRPC is deferred; all four extensions, docs, versions and the Playwright-free tree must be green and pushed

## Needs you

_Nothing. The owner has no open decision._

## New

- **LANDED** · just now · site-disable-cancels-queue d5a9a4a: disable resets the source limiter before the clear; regression watched red 34/35 then green; ready GO; 528/528 in a clean full run
- **LANDED** · just now · site-disable-cancels-queue
- **LANDED** · just now · site-disable-cancels-queue behind 2026-11-10T21:55:15.614Z
- **READY** · 2m · site-disable-cancels-queue: GO
- **RED** · 2m · check red at d5a9a4a: test
- **RED** · 6m · audit finding: background.js setSiteEnabled clears without limiter.reset(); a queued non-null payload can publish after a site is disabled. New seam site-disable-cancels-queue
- **RULING** · 8m · youtube-presence-ui force-landed: ready NO-GO'd on two false positives. (1) range b632283..b1d36cc includes sibling commit 51b5797 (sort-root-docs, own landed brief); b1d36cc itself touches exactly its 12 Files (git show --name-only). (2) .stack/config.json gained the stricter proving checks (web-selftest, crp-selftest, web-e2e, verify) before this seam; ready flags any config change, and it cannot be both kept and satisfied because committing it would put it in the range. Recorded GREEN at b1d36cc: 7/7 configured checks, 528 tests.
- **LANDED** · 8m · youtube-presence-ui b1d36cc: YouTube Presence name, per-site toggles (YT Music first), docs true; 217/217 package, 528 total, verifier 15/15, both selftests, 7/7 configured checks

## In progress

_No briefed seam is open._

## Stall watch

_No seam is older than six hours._

## Landed, unaudited

- wdr-scaffold landed without a recorded verdict. Run `stacked-audit` and log it.
- wdr-extract landed without a recorded verdict. Run `stacked-audit` and log it.
- wdr-host landed without a recorded verdict. Run `stacked-audit` and log it.
- wdr-state landed without a recorded verdict. Run `stacked-audit` and log it.
- crp-arrpc landed without a recorded verdict. Run `stacked-audit` and log it.
- wdr-ipc landed without a recorded verdict. Run `stacked-audit` and log it.
- wdr-transport landed without a recorded verdict. Run `stacked-audit` and log it.
- wdr-arrpc-query landed without a recorded verdict. Run `stacked-audit` and log it.
- wdr-ui landed without a recorded verdict. Run `stacked-audit` and log it.
- wdr-docs landed without a recorded verdict. Run `stacked-audit` and log it.
- wdr-root landed without a recorded verdict. Run `stacked-audit` and log it.
- wdr-e2e-arrpc landed without a recorded verdict. Run `stacked-audit` and log it.
- remove-playwright landed without a recorded verdict. Run `stacked-audit` and log it.
- playwright-residuals landed without a recorded verdict. Run `stacked-audit` and log it.
- desktop-rpc-default landed without a recorded verdict. Run `stacked-audit` and log it.
- crunchy-1-2-0 landed without a recorded verdict. Run `stacked-audit` and log it.
- youtube-presence-settings landed without a recorded verdict. Run `stacked-audit` and log it.
- youtube-presence-ui landed without a recorded verdict. Run `stacked-audit` and log it.
- sort-root-docs landed without a recorded verdict. Run `stacked-audit` and log it.
- site-disable-cancels-queue landed without a recorded verdict. Run `stacked-audit` and log it.
