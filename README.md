<h1 align="center">my-chromium-extensions</h1>
<p align="center"><strong>Four Chromium extensions for loudness levelling, slowed reverb, and Discord presence in Crunchyroll and YouTube Music.</strong></p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-chrome%20brave-blue" alt="platform">
  <img src="https://img.shields.io/badge/extensions-4-brightgreen" alt="4 extensions">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT">
</p>

## Why

Four Chromium extensions, loaded unpacked from stable folders the installer creates. Nothing is published to a store. The two audio extensions work through a local audio graph on the pages you choose. The two presence extensions reach Discord through a local native messaging host, so no browser-to-cloud bridge is involved. There is no build step for the extensions themselves.

## Install

```sh
git clone https://github.com/nathwn12/my-chromium-extensions.git
cd my-chromium-extensions
```

Install the runtime for each extension you want:

```sh
node scripts/install-extension.mjs audio-normalizer
node scripts/install-extension.mjs slowed-reverb
node scripts/install-extension.mjs crunchy-presence
node scripts/install-extension.mjs youtube-music-presence
```

Each command copies only the files that extension needs at runtime into `%LOCALAPPDATA%\<name>\extension` and prints the exact folder:

```
Load unpacked: C:\Users\<you>\AppData\Local\<name>\extension
```

Open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and select that printed path. Chrome keeps an unpacked extension as a folder path, not a copy. Loading it from `packages/<name>` would break as soon as you move or delete the checkout. The stable target exists so the browser never follows the checkout. Re-run the installer after pulling changes, then reload the extension in `chrome://extensions`.

Add `--check` to verify the installed files against the installer's recorded hashes without writing. Add `--uninstall` to remove only that extension's stable folder.

The two presence extensions need a native messaging host. Register each once from the repository root:

```sh
node packages/crunchy-presence/scripts/install-host.mjs
node packages/youtube-music-presence/scripts/install-host.mjs
```

Add `--check` to either command to verify a registration without writing.

## Use it

| Extension | What it does | Version |
| --- | --- | --- |
| [Audio Normalizer](packages/audio-normalizer) | Brings every site you switch on to one target loudness through a local audio graph. | 5.6.6 |
| [Slowed Reverb](packages/slowed-reverb) | Slows YouTube Music playback and adds plate reverb in a local audio graph. | 1.2.12 |
| [Crunchy Presence](packages/crunchy-presence) | Reports the Crunchyroll episode you are watching as Discord rich presence. | 1.2.7 |
| [YouTube Music Presence](packages/youtube-music-presence) | Reports YouTube Music only to Discord desktop rich presence. | 1.1.22 |

Then, per extension:

- **Audio Normalizer** — open a page that plays audio, click the icon and switch Active on for that site.
- **Slowed Reverb** — start a track on YouTube Music, then click the icon.
- **Crunchy Presence** — with Discord desktop running, open an episode; the popup shows bridge status.
- **YouTube Music Presence** — with Discord desktop running, open YouTube Music and turn presence on with the popup switch. The choice persists across refreshes and Discord reconnects.

## Configure it

- **Audio Normalizer** — the gain slider runs -12 to +12 dB; Speech, Music and Boost are presets. The setting is per site.
- **Slowed Reverb** — speed runs 0.7x to 1.3x and reverb runs 0 to 100 percent.
- **Extension installs** — `scripts/install-extension.mjs` writes the stable runtime folder. `--check` verifies it without writing; `--uninstall` removes it.
- **Native hosts** — `install-host.mjs` writes the registration for one presence extension. `--check` verifies it without writing. Re-run the installer after a host update.
- **Wiring check** — `node scripts/verify-integration.mjs` reads the tree and installs nothing.

## Requirements

- A Chromium browser: Chrome, Edge or Brave.
- Node 26, the version in `.nvmrc` and the root `engines` field, to run the host installers, the native hosts and the tests.
- Windows 10 or 11 for the two presence extensions: their hosts write registry entries and talk to Discord's local named pipe.
- Discord desktop, signed in and running, for the two presence extensions only.
- Chrome 120 or newer for the two presence extensions; both pin `minimum_chrome_version`. The two audio extensions declare no minimum.

## Development

```sh
bun install
bun run test
bun run test:installer
node scripts/verify-integration.mjs
bun run lint
bun run typecheck
```

Tests run in Node on `node --test`, never in a browser. The installer test uses a temporary local-app-data root and never writes the live profile. `verify-integration.mjs` reads the tree and installs nothing.

```
my-chromium-extensions/
├── packages/    four extensions, each with tests and docs
├── scripts/     wiring check and host installers
├── tools/       cost audit
└── .github/     ci, release, supply-chain
```

## Status

**Experimental** - pre-release; interfaces may change.

## Links

- [Issues](https://github.com/nathwn12/my-chromium-extensions/issues)
- [Releases](https://github.com/nathwn12/my-chromium-extensions/releases)
- [MIT](LICENSE)

<p align="center"><sub>Built by nathwn12</sub></p>
