# Crunchyroll Discord Presence

Shows the Crunchyroll episode you are watching as Discord rich presence. Local only: a Chrome MV3 extension reads the page, a small Node native host forwards the activity to Discord over its local IPC pipe, and nothing is uploaded anywhere.

## What Discord shows

- Activity type **WATCHING**.
- Line 1: the series name (the episode title when the series is unknown); with a synopsis, `Frieren · S1 E5` when both numbers are known.
- Line 2: the episode synopsis when it exists and the setting is on, otherwise `S1 E5 · 12:34 / 24:00` - season, episode, position and duration.
- A timer: elapsed on the left, remaining on the right, driven by start/end timestamps. Omitted while paused.
- Artwork: the episode image from Crunchyroll, handed to Discord as an external `https` URL.
- Up to two buttons: **Watch Episode** and **View Series**, pointing at the episode and series pages. A lone episode link is labelled **Watch on Crunchyroll**, and the phase-1 button remains when no direct link is found.

The card's title is the name of the Discord application behind the presence: `Crunchyroll` by default, and whatever application the options page points at.

## Requirements

| | |
| --- | --- |
| Windows | 10 or 11 (registry entries and named pipes) |
| Chrome | 156 or newer (`minimum_chrome_version` in the manifest) |
| Node | 22 or newer, to run the installer and the native host |
| Discord | Desktop app running and signed in; Canary is fine |

## Install

### 1. Install the native messaging host

From the repository root:

```
node scripts/install-host.mjs
```

This writes `%LOCALAPPDATA%\crunchyroll-discord-presence\host.cmd` and `host-manifest.json`, registers the host for Chrome (and for Edge and Brave, which share the installer), then prints a PASS/FAIL line per check and the extension ID it registered against. `node scripts/install-host.mjs --check` verifies without writing.

### 2. Load the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked**, then select the `extension` folder in this repository.

The manifest carries a fixed `key`, so the extension keeps the same ID across reloads and machines. The host's `allowed_origins` names exactly that ID.

## The built-in application

Discord only accepts `SET_ACTIVITY` from an IPC connection that identifies a Discord application (`client_id`); there is no anonymous presence path, so every card is titled by an application. This repository bundles the owner's local application `Crunchyroll` (id `1566530911514923188`), so there is no setup step: install the host, load the extension, and presence works. The ID is a public identifier, not a secret — it is the number on an application's General Information page and grants nothing by itself.

## Changing the application

The options page carries one **Application ID** field, pre-filled with the built-in ID. Saving a different 17 to 20 digit ID stores an override and reconnects the bridge to that application. The card's title is the application's name, so the name follows whichever ID is in force. Saving the built-in value, or clearing the field and saving, removes the override and restores the built-in application.

## Privacy

- The extension makes no network requests of its own. It reads the Crunchyroll tab you have open and talks to the native host over Chrome native messaging.
- The native host makes no network requests. It only writes `SET_ACTIVITY` frames to Discord's local named pipe.
- No telemetry, no analytics, no remote config, no update check.
- Settings and the last extracted page state stay in `chrome.storage.local` / `chrome.storage.session` on this machine. The diagnostics on the options page are local text that you copy yourself.
- Artwork URLs are handed to Discord, which fetches them. That request is Discord's, not the extension's.
- The page is read, never modified. The DRM video is never inspected or captured; only element state (position, duration, paused, playback rate) is read.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Discord shows the wrong app name | The options page holds an override naming another Discord application; the card is titled by that application | Clear the field and save to return to the built-in `Crunchyroll`, or save the intended application's ID |
| Presence never appears | Discord is not running, activity sharing is off, or the host is not registered | Discord → Settings → Activity Privacy → turn on **Share your detected activities**; confirm the desktop app (not the browser) is running and signed in; run `node scripts/install-host.mjs --check` and expect PASS on every line |
| Host not found | The folder moved after install, or Chrome still holds the old host registration | Re-run `node scripts/install-host.mjs`, then reload the extension on `chrome://extensions` |
| Stops after the tab sleeps | Chrome suspends background tabs and the service worker, so no new state arrives | The 30 s watchdog alarm reconnects the worker, and the host republishes the last activity on reconnect; wake the tab and the next media event restores live state |
| Ads or no video | An ad break has no episode metadata | Presence clears while the ad runs and returns when the episode resumes |

## Checks

```
node --test test/
node native/host.mjs --selftest
```

The first runs the test suite. The second exercises the host end to end against an in-process fake Discord pipe and prints JSON with an `ok` flag.

## Remove

```
node scripts/uninstall-host.mjs
```

Then remove the extension from `chrome://extensions`.

## More

- `docs/ARCHITECTURE.md` — data flow, message contract, framing, rate guard, extraction layers.
- `docs/RESEARCH.md` — dated sources behind the protocol and selector choices.
- `AGENTS.md` — repository rules.
