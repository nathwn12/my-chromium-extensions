# my-chromium-extensions

Four Chromium extensions, loaded unpacked from this repository. Nothing is published to a store.

| Extension | What it does | Version |
| --- | --- | --- |
| [Audio Normalizer](packages/audio-normalizer) | Applies one target loudness to every site through a local audio graph. | 5.6.2 |
| [Slowed Reverb](packages/slowed-reverb) | Slows YouTube Music playback and adds plate reverb in a local audio graph. | 1.2.1 |
| [Crunchy Presence](packages/crunchy-presence) | Reports the Crunchyroll episode being watched as Discord rich presence. | 1.2.1 |
| [YouTube Presence](packages/web-discord-rpc) | Reports YouTube Music only to Discord desktop rich presence. | 1.1.8 |

## Install

1. Clone the repository.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select `packages/<name>`.

Each package folder holds its own `manifest.json`; there is no build step.

## Crunchy Presence

A browser cannot open a Discord named pipe, so the extension passes watch state to a native messaging host that connects to Discord IPC itself. From the repository root:

```
node packages/crunchy-presence/scripts/install-host.mjs
```

Verify the registration without writing:

```
node packages/crunchy-presence/scripts/install-host.mjs --check
```

The host scans `\\.\pipe\discord-ipc-0` through `-9`.

## Development

```
node --test packages/crunchy-presence/test/
node --test packages/web-discord-rpc/test/
cd packages/audio-normalizer && node --test tests/
cd packages/slowed-reverb && node test/mute-enforce.test.js
```

QA is browser-free and silent: no Playwright dependency is installed here, and
every check above runs in Node. Gladius is the only browser tester.

## Release

```
node scripts/release.mjs <package> <major|minor|patch|x.y.z> [--dry-run]
git commit -m "<package>: release <version>"
git tag v<version>
git push origin HEAD v<version>
```

The script bumps `manifest.json`, `package.json` and the `CHANGELOG`, and prints these exact commands without running them. Pushing the `v*` tag makes CI attach the four extension zips to a GitHub release.

## Layout

```
packages/
  audio-normalizer/   per-site loudness levelling
  crunchy-presence/   Crunchyroll watch state to Discord
  slowed-reverb/      YouTube slowdown and plate reverb
  web-discord-rpc/    YouTube watch state to Discord
```

## Scope

Local-first: unpacked loading only, no store listing, no npm release, no telemetry.

## Status

Experimental and still moving. It works today, but it is not a finished
product: interfaces may change, features may be improved or removed, and a
release can break the one before it. This is maintained by one person, not a
team. If it breaks, open an issue with the command you ran and what you saw.

## Links

- [MIT](LICENSE)
