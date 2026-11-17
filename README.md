<h1 align="center">my-chromium-extensions</h1>

**Even loudness, slower playback with reverb, and Discord presence, loaded unpacked from this repository.**

## Install

1. Clone this repository.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Choose **Load unpacked** and select the folder of the extension you want under `packages/`.

Nothing is published to a store. Each package folder carries its own `manifest.json`, and there is no build step.

Every release also attaches the four extension zips, if you would rather download one than clone: [Releases](https://github.com/nathwn12/my-chromium-extensions/releases).

### Wire it yourself

Crunchy Presence and YouTube Presence reach Discord through a native messaging host, because a browser cannot open a Discord named pipe. Register it from the repository root:

```sh
node packages/crunchy-presence/scripts/install-host.mjs
node packages/web-discord-rpc/scripts/install-host.mjs
```

Each script registers its host for Chrome, Edge and Brave. Verify the registration without writing anything:

```sh
node packages/crunchy-presence/scripts/install-host.mjs --check
node packages/web-discord-rpc/scripts/install-host.mjs --check
```

## Use it

Four Chromium extensions, one folder each:

| Extension | What it does | Version |
| --- | --- | --- |
| [Audio Normalizer](packages/audio-normalizer) | Applies one target loudness to every site through a local audio graph. | 5.6.3 |
| [Slowed Reverb](packages/slowed-reverb) | Slows YouTube Music playback and adds plate reverb in a local audio graph. | 1.2.2 |
| [Crunchy Presence](packages/crunchy-presence) | Reports the Crunchyroll episode being watched as Discord rich presence. | 1.2.2 |
| [YouTube Presence](packages/web-discord-rpc) | Reports YouTube Music to Discord desktop rich presence only. | 1.1.10 |

Load the extension, then switch it on in its popup. The two presence extensions keep their own on/off switch, and the choice survives refreshes and Discord reconnects.

## Requirements

- Chrome or Brave on desktop, with Manifest V3 and access to turn on Developer mode. Chrome 120 or newer for the two presence extensions; the audio pair set no floor beyond MV3.
- Windows 10 or 11 and Node 22 or newer for the native messaging host the presence extensions use.
- Discord desktop installed, running and signed in, for the presence extensions.
- An account in the tab you use: YouTube Music for Slowed Reverb and YouTube Presence, Crunchyroll for Crunchy Presence.

## Development

```sh
bun install --frozen-lockfile
bun run test
bun run typecheck
bun run lint
```

`bun run test` runs every package's tests through the root plan, `typecheck` covers Audio Normalizer and `lint` covers Slowed Reverb. `node scripts/verify-integration.mjs` re-reads the tree and fails when this table drifts from the manifests.

To bump one extension and cut its release:

```sh
node scripts/release.mjs <package> patch
```

The script writes `manifest.json`, `package.json` and that package's CHANGELOG, then prints the commit and tag commands without running them. Pushing the `v*` tag makes CI attach the four extension zips to a GitHub release.

## Status

**Experimental** — pre-release; interfaces may change.

## Links

- [Issues](https://github.com/nathwn12/my-chromium-extensions/issues)
- [Releases](https://github.com/nathwn12/my-chromium-extensions/releases)
- [MIT licence](LICENSE)
