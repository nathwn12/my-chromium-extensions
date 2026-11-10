# Digest — 2026-11-11 05:37

Rewritten by the lead. Newest first. An empty section is a true statement.

**Objective** — YouTube Presence (YouTube + YouTube Music, YouTube Music first, per-site toggles both/one) publishes to the installed Discord desktop over IPC; web/arRPC is deferred; all four extensions, docs, versions and the Playwright-free tree must be green and pushed

## Needs you

_Nothing. The owner has no open decision._

## New

- **LANDED** · 4m · youtube-presence-settings b632283: youtubeEnabled/youtubeMusicEnabled flags (both on), YT Music first, disabled site cleared, edge fallback ipc; 45/45
- **LANDED** · 4m · youtube-presence-settings
- **RULING** · 4m · youtube-presence-settings landed without a GO, forced by the lead
- **LANDED** · 10m · desktop-rpc-default c5bfab7 (205/205, selftest 10/10) and crunchy-1.2.0 fd249f3 (196 tests, selftest ok); desktop is default ipc
- **LANDED** · 10m · crunchy-1-2-0
- **RULING** · 10m · crunchy-1-2-0 landed without a GO, forced by the lead
- **LANDED** · 10m · desktop-rpc-default
- **RULING** · 10m · desktop-rpc-default landed without a GO, forced by the lead

## In progress

| Seam | Owns | State | Age |
| --- | --- | --- | --- |
| [youtube-presence-ui](.stack/briefs/youtube-presence-ui.md) | packages/web-discord-rpc/manifest.json<br>packages/web-discord-rpc/package.json<br>packages/web-discord-rpc/popup.* | briefed | 3m |
| [sort-root-docs](.stack/briefs/sort-root-docs.md) | README.md<br>scripts/verify-integration.mjs<br>packages/web-discord-rpc/scripts/install-host.mjs | briefed | 3m |

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
