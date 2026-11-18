<h1 align="center">my-chromium-extensions</h1>
<p align="center"><strong>Four Chromium extensions for loudness levelling, slowed reverb, and Discord presence in Crunchyroll and YouTube Music.</strong></p>

## Install

```bash
git clone https://github.com/nathwn12/my-chromium-extensions.git
```

Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select `packages/<name>` — the folder that holds that extension's `manifest.json`. There is no build step and no store listing.

The two presence extensions reach Discord through a local native messaging host. Register it once from the repository root:

```bash
node packages/crunchy-presence/scripts/install-host.mjs
node packages/youtube-music-presence/scripts/install-host.mjs
```

Add `--check` to either command to verify a registration without writing.

## Use it

Four Chromium extensions, loaded unpacked from this repository. Nothing is published to a store.

| Extension | What it does | Version |
| --- | --- | --- |
| [Audio Normalizer](packages/audio-normalizer) | Brings every site you switch on to one target loudness through a local audio graph. | 5.6.4 |
| [Slowed Reverb](packages/slowed-reverb) | Slows YouTube Music playback and adds plate reverb in a local audio graph. | 1.2.7 |
| [Crunchy Presence](packages/crunchy-presence) | Reports the Crunchyroll episode you are watching as Discord rich presence. | 1.2.3 |
| [YouTube Music Presence](packages/youtube-music-presence) | Reports YouTube Music only to Discord desktop rich presence. | 1.1.11 |

Then, per extension:

- **Audio Normalizer** — open a page that plays audio, click the icon, and switch **Active** on for that site. The gain slider runs -12 to +12 dB; Speech, Music and Boost are presets.
- **Slowed Reverb** — start a track on YouTube Music, then click the icon. Speed runs 0.7x to 1.3x, reverb 0 to 100 percent.
- **Crunchy Presence** — with Discord desktop running, open an episode; the popup shows bridge status.
- **YouTube Music Presence** — with Discord desktop running, open YouTube Music and turn presence on with the popup switch. The choice persists across refreshes and Discord reconnects.

## Requirements

- A Chromium browser: Chrome, Edge or Brave.
- Node 26, the version in `.nvmrc` and the root `engines` field, to run the host installers, the native hosts and the tests.
- Windows 10 or 11 for the two presence extensions: their hosts write registry entries and talk to Discord's local named pipe.
- Discord desktop installed, signed in and running, for the two presence extensions only.
- Chrome 120 or newer for the two presence extensions; both pin `minimum_chrome_version`. The two audio extensions declare no minimum.

## Development

```bash
bun install
bun run test                          # every workspace suite
node scripts/verify-integration.mjs   # wiring check, reads the tree and installs nothing
bun run lint                          # slowed-reverb ESLint
bun run typecheck                     # audio-normalizer tsc
```

Tests run in Node on `node --test`, never in a browser: no Playwright dependency exists here, and `verify-integration.mjs` fails if one is added. CI runs those commands per package and adds the audio QA scripts (`qa/feed-transition-qa.cjs`, `qa/program-boundary-qa.cjs`) plus both native host selftests.

## Status

**Experimental** — pre-release; interfaces may change.

## Links

- [Issues](https://github.com/nathwn12/my-chromium-extensions/issues)
- [Releases](https://github.com/nathwn12/my-chromium-extensions/releases) — one packaged zip per extension.
- [MIT](LICENSE)
