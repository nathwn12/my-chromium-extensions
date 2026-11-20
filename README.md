<h1 align="center">my-chromium-extensions</h1>
<p align="center"><strong>Four Chromium extensions for loudness levelling, slowed reverb, and Discord presence in Crunchyroll and YouTube Music.</strong></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/nathwn12/my-chromium-extensions" alt="License" /></a>
  <img src="https://img.shields.io/github/languages/top/nathwn12/my-chromium-extensions" alt="Language" />
  <img src="https://img.shields.io/badge/platform-chrome--brave-2b3137?logo=googlechrome&logoColor=white" alt="Platform" />
</p>

## Why

Four focused extensions, loaded unpacked from this repository. Nothing is published to a store. The two audio extensions work through a local audio graph on the pages you choose. The two presence extensions reach Discord through a local native messaging host, so no browser-to-cloud bridge is involved. There is no build step for the extensions themselves.

## Install

```sh
git clone https://github.com/nathwn12/my-chromium-extensions.git
```

Open `chrome://extensions`, turn on Developer mode, click Load unpacked, and select `packages/<name>` — the folder that holds that extension's `manifest.json`.

The two presence extensions need a native messaging host. Register each once from the repository root:

```sh
node packages/crunchy-presence/scripts/install-host.mjs
node packages/youtube-music-presence/scripts/install-host.mjs
```

Add `--check` to either command to verify a registration without writing.

## Use

| Extension | What it does | Version |
| --- | --- | --- |
| [Audio Normalizer](packages/audio-normalizer) | Brings every site you switch on to one target loudness through a local audio graph. | 5.6.4 |
| [Slowed Reverb](packages/slowed-reverb) | Slows YouTube Music playback and adds plate reverb in a local audio graph. | 1.2.8 |
| [Crunchy Presence](packages/crunchy-presence) | Reports the Crunchyroll episode you are watching as Discord rich presence. | 1.2.3 |
| [YouTube Music Presence](packages/youtube-music-presence) | Reports YouTube Music to Discord desktop rich presence. | 1.1.12 |

Then, per extension:

- **Audio Normalizer** — open a page that plays audio, click the icon and switch Active on for that site.
- **Slowed Reverb** — start a track on YouTube Music, then click the icon.
- **Crunchy Presence** — with Discord desktop running, open an episode; the popup shows bridge status.
- **YouTube Music Presence** — with Discord desktop running, open YouTube Music and turn presence on with the popup switch. The choice persists across refreshes and Discord reconnects.

## Configure

- **Audio Normalizer** — the gain slider runs -12 to +12 dB; Speech, Music and Boost are presets. The setting is per site.
- **Slowed Reverb** — speed runs 0.7x to 1.3x and reverb runs 0 to 100 percent.
- **Native hosts** — `install-host.mjs` writes the registration for one presence extension. `--check` verifies it without writing. Re-run the installer after a host update.
- **Wiring check** — `node scripts/verify-integration.mjs` reads the tree and installs nothing.

## Requirements

- A Chromium browser: Chrome, Edge or Brave.
- Node 26, the version in `.nvmrc` and the root `engines` field, to run the host installers, the native hosts and the tests.
- Windows 10 or 11 for the two presence extensions: their hosts write registry entries and talk to Discord's local named pipe.
- Discord desktop, signed in and running, for the two presence extensions only.
- Chrome 120 or newer for the two presence extensions; both pin `minimum_chrome_version`. The two audio extensions declare no minimum.

## Links

- [Issues](https://github.com/nathwn12/my-chromium-extensions/issues)
- [Releases](https://github.com/nathwn12/my-chromium-extensions/releases) — one packaged zip per extension.
- [MIT](LICENSE)

<p align="center">Built by nathwn12</p>
