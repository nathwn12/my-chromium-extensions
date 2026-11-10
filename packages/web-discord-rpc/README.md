# Web Discord RPC

Show what you are watching on YouTube and YouTube Music as Discord rich presence. Local only: a Chrome MV3 extension reads the tabs you have open, a small Node native host forwards each activity to Discord, and nothing is uploaded anywhere.

> Dated 2026-11-10. Every command below was run from the repository root on this date; outputs quoted are the real shapes (extension ID, host name, and status field names are exact).

## Requirements

| | |
| --- | --- |
| Windows | 10 or 11 (registry entries and named pipes) |
| Chrome | 120 or newer (`minimum_chrome_version` in the manifest) |
| Node | 22 or newer, to run the installer and the native host |
| Discord | Desktop app running and signed in **first**; Discord Web via arRPC is the fallback |

Desktop-first: the host probes the local `\\.\pipe\discord-ipc-0` through `-9` first and only reaches the arRPC WebSocket when no pipe answers. You do not need arRPC, Vencord, or a browser tab open for the desktop path. When the desktop app is absent, arRPC itself can own that pipe, so IPC-first can still reach the Discord Web bridge without the WebSocket fallback.

## Install

### 1. Install the native messaging host

From the repository root:

```
node packages/web-discord-rpc/scripts/install-host.mjs
```

This writes `%LOCALAPPDATA%\web-discord-rpc\host.cmd` and `host-manifest.json`, registers host `com.nathwn12.web_discord_rpc` for Chrome (and for Edge and Brave, which share the installer), then prints a PASS/FAIL line per check and the extension ID it registered against. `node packages/web-discord-rpc/scripts/install-host.mjs --check` verifies without writing; `--json` prints the same result as JSON.

The shipped manifest key derives extension ID `mnmmfbjinpokfnendlbhbbdmfjidgikf` (`node packages/web-discord-rpc/scripts/extension-key.mjs --print`). The host's `allowed_origins` names exactly that ID.

### 2. Load the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked**, then select `packages/web-discord-rpc` (the folder holding `manifest.json`).

The manifest carries a fixed `key`, so the extension keeps the same ID across reloads and machines.

### 3. Start Discord desktop first

Sign in to the Discord desktop app before opening YouTube. With `transport: "auto"` (the default) the first `hello` makes the host probe `\\.\pipe\discord-ipc-0` through `-9`; only when no pipe answers does it probe the arRPC WebSocket on `127.0.0.1:6463-6472`. A pipe that answers may itself be owned by arRPC when the desktop app is absent, so IPC-first can carry Discord Web traffic too. A forced `ipc` never touches the network; a forced `arrpc` always uses `ws://127.0.0.1:<port>/?v=1&client_id=<id>` and never touches the pipes.

## arRPC / Vencord fallback

arRPC runs a WebSocket listener on `127.0.0.1:6463-6472` that speaks Discord's RPC commands, the same bridge Vencord's `WebRichPresence (arRPC)` plugin forwards to `LOCAL_ACTIVITY_UPDATE` in the Discord web client. The native host is an arRPC *client*: it opens `ws://127.0.0.1:<port>/?v=1&client_id=<id>` (the `client_id` query is required — without it arRPC stamps an empty application ID and Vencord cannot resolve the app or its assets), accepts only the arRPC mock user (`id 1045800378228281345`, username `arrpc`), sends one `SET_ACTIVITY` per source, and matches replies by `nonce`. No `Origin` header is set. Absence of arRPC is `waiting`, never an error.

`UNVERIFIED here: the Vencord forwarding (`socketId` → `LOCAL_ACTIVITY_UPDATE`, two connections stacking two activities) was proved live on 2026-11-10 and recorded in `.stack/contracts.md`; this repository did not re-observe it. The empty-`application_id` failure without the `client_id` query was observed live before `ea96742` (lead receipt) and the query fix is verified in `native/arrpc.mjs`.`

## What Discord shows: two stacked activities

One native port carries two independent sources, each with its own tab state, desired activity, and 4-per-20 s budget, so they publish side by side without evicting each other.

| Source | Type | `name` (app label override) | Button |
| --- | --- | --- | --- |
| YouTube (`www.youtube.com`, `youtube.com`, `m.youtube.com`) | 3 WATCHING | `YouTube` | `Watch on YouTube` |
| YouTube Music (`music.youtube.com`) | 2 LISTENING | `YouTube Music` | `Listen on YouTube Music` |

`activity.name` overrides the Discord application label, so one application ID serves both cards. Each activity carries `details` (title, 2–128 chars), `state` (channel, or `channel — album` on Music, 2–128 chars), `assets.large_image` (the page's `https` artwork; omitted without one), `assets.large_text`, at most one button (the page URL when it is `https` on the source host and ≤ 512 chars), and `timestamps` (`start = floor(now/1000)*1000 − floor(position)*1000`, `end = start + floor(duration)*1000`) only while the tab is playing with a positive duration. Without a readable title there is no activity. Only `https:` page URLs on the source's own host are trusted.

## Changing the application

A fresh install publishes under the built-in application `1566530911514923188` with no paste step. A stored 17–20 digit ID in `storage.local` key `clientId` overrides it; the worker resolves it with `resolveClientId` and the host rejects anything else with `rejected`. Saving the built-in value (or clearing the stored one) restores the built-in application. The card title stays `YouTube` / `YouTube Music` (the `name` override); the application ID controls which Discord application — and icon — the card belongs to. (Crunchy still titles its card with the application name because it sends no `name`.)

The popup and options surfaces edit `clientId`, `transport`, and `enabled` (`packages/web-discord-rpc/options.html`, `popup.html` and their scripts). This document describes the storage keys and the `hello` contract the worker and host implement.

The transport preference travels in `hello` as `transport: "auto" | "ipc" | "arrpc"` (`storage.local` key `transport`, default `"auto"`). `auto` prefers Discord IPC and falls back to arRPC, remembering the first success for the other source (`mixed` when the two sources land on different transports); forced values never fall back.

## Privacy

- The extension makes no network requests of its own. It reads the YouTube/YouTube Music tabs you have open and talks to the native host over Chrome native messaging.
- The native host makes no network requests on the desktop path: it writes `SET_ACTIVITY` frames to Discord's local named pipes. On the fallback path it opens a WebSocket to `127.0.0.1` (this machine only) for arRPC.
- No telemetry, no analytics, no remote config, no update check.
- Settings and the last extracted page state stay in `chrome.storage.local` / `chrome.storage.session` on this machine.
- Artwork URLs are handed to Discord, which fetches them. That request is Discord's, not the extension's.
- The page is read, never modified. The DRM stream is never inspected or captured; only element state (title, channel, position, duration, paused, playback rate) is read.

## Troubleshooting

`reason` is one of `discord-closed | arrpc-closed | host-missing | rejected | hung`. Absence of either transport is `waiting`, never `error`; only a rejected application ID (or a hang exhausted after 3 pong timeouts) is `error`.

| Symptom | Cause | Fix |
| --- | --- | --- |
| Presence never appears | Discord desktop is not running and no arRPC is listening | Start the Discord desktop app and sign in (preferred), or start arRPC/Vencord for the web path; no reload needed, the host reconnects and republishes |
| Status says `arrpc-closed` | Nothing answered on `127.0.0.1:6463-6472` | Start arRPC (or Vencord with the arRPC plugin) when you want the web path; otherwise keep the desktop app running and stay on `auto`/`ipc` |
| Status says `host-missing` | Chrome cannot launch the native host | Re-run `node packages/web-discord-rpc/scripts/install-host.mjs`, then reload the extension on `chrome://extensions` |
| Status says `rejected` | Discord rejected the application ID | Check the stored `clientId` (17–20 digits); clear it to return to the built-in `1566530911514923188` |
| One source missing | That source has no readable title, or its tab closed | Open a watch/player URL on that source; a tab that has not reported for 30 min is treated as closed and its activity clears |
| Timestamps frozen while paused | By design: timestamps attach only while `paused === false` with `duration > 0` | Resume playback; the timer reappears from the live position |

## Checks

```
node --test packages/web-discord-rpc/test/
node packages/web-discord-rpc/native/host.mjs --selftest
node packages/web-discord-rpc/scripts/install-host.mjs --check
node packages/web-discord-rpc/scripts/extension-key.mjs --print
```

The first runs the suite (extension, native, scripts). The second exercises the host end to end (framing, arRPC READY/nonce matching, IPC handshake, auto preference with two pipes, arRPC fallback, forced-transport isolation) and prints `selftest: PASS (10/10)` on success. The third verifies host files and registry entries. The fourth prints the pinned extension ID.

## Remove

```
node packages/web-discord-rpc/scripts/uninstall-host.mjs
```

Then remove the extension from `chrome://extensions`.

## More

- `docs/ARCHITECTURE.md` — data flow, message contract, framing, rate guard, extraction layers.
- `docs/RESEARCH.md` — dated sources behind the protocol and selector choices.
- `docs/INSTALL.md` — desktop-first install with verification output.
