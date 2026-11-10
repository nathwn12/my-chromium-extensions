# Digest — 2026-11-11 06:29

Rewritten by the lead. Newest first. An empty section is a true statement.

**Objective** — YouTube Presence (YouTube + YouTube Music, YouTube Music first, per-site toggles both/one) publishes to the installed Discord desktop over IPC; web/arRPC is deferred; all four extensions, docs, versions and the Playwright-free tree must be green and pushed

## Needs you

_Nothing. The owner has no open decision._

## New

- **NOTE** · 14m · check green at fcd3d20: test, typecheck, lint, web-selftest, crp-selftest, web-e2e, verify
- **LANDED** · 19m · verify-scans-tracked-source a052c90: guard reads the commit surface with no silent catch, 16/16 green and 16/16 prove-red, planted .html caught by name; ready GO
- **LANDED** · 19m · verify-scans-tracked-source
- **LANDED** · 19m · verify-scans-tracked-source behind 2026-11-10T22:09:40.239Z
- **NOTE** · 20m · deleted two git-ignored stale package-level lockfiles that still named Playwright (audio-normalizer 4 refs, slowed-reverb 5 refs); untracked and generated, so the commit surface was never dirty, but npm ci inside those packages would have installed it
- **READY** · 20m · verify-scans-tracked-source: GO
- **NOTE** · 20m · check green at a052c90: test, typecheck, lint, web-selftest, crp-selftest, web-e2e, verify
- **LANDED** · 33m · site-disable-cancels-queue d5a9a4a: disable resets the source limiter before the clear; regression watched red 34/35 then green; ready GO; 528/528 in a clean full run

## In progress

_No briefed seam is open._

## Stall watch

_No seam is older than six hours._
