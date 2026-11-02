<p align="center">
  <img src="audio/icon-128.png" width="120" height="120" alt="Slowed Reverb Audio icon" />
</p>
<h1 align="center">Slowed Reverb Audio</h1>
<p align="center"><strong>Slow a YouTube track and wash it in plate reverb, right in your browser.</strong></p>

## Install

Clone the repo, then load it as an unpacked extension:

```sh
git clone https://github.com/nathwn12/slowed-reverb-audio.git
```

Open `chrome://extensions`, switch on Developer mode, choose Load unpacked, and select the repo folder holding `manifest.json`.

Once it loads, open a YouTube or YouTube Music tab, start playback, and click the extension icon. You need Chrome or Brave on desktop before any of this works.

### Offline or pinned

Pin one exact commit for a repeatable install:

```sh
git clone https://github.com/nathwn12/slowed-reverb-audio.git
git -C slowed-reverb-audio checkout 4efc3c2a25b2cd1b6e3dd9e9e81ec55f822dca71
```

There is no hosted page, so the repo folder itself is the install source. Reload the extension from `chrome://extensions` after you pull new commits.

## Use it

Start a video or song on YouTube or YouTube Music, then click the extension icon.

Drag the large slider to set speed from 0.7x to 1.3x.

Drag the smaller slider to set reverb from 0 percent to 100 percent.

Switch Active off to hear the raw mix again without losing your settings.

Press the reset arrow to return to 1.00x and 0 percent.

Your per-site speed, reverb, and Active state persist across restart and apply again on first play.

## What you get

- You slow audio from 0.7x to 1.3x in 0.01 steps without pitch distortion.
- You dial Dattorro plate reverb from 0 to 100 percent.
- You keep per-site memory: speed, reverb, and Active state persist.
- You read a dark popup with a live tab-status indicator.
- You stay local: audio never leaves your machine, with no uploads and no accounts.

## Requirements

- You run Chrome or Brave on desktop with Developer mode access.
- You listen on `youtube.com`, `www.youtube.com`, or `music.youtube.com`.
- You skip the build step: there is none, and you need no account.
- You install Node.js with npm only if you want the optional `npm run lint` check.

## Links

- Repository: https://github.com/nathwn12/slowed-reverb-audio
- Privacy policy: PRIVACY_POLICY.md
- Changelog: CHANGELOG.md
- License: MIT, see [LICENSE](LICENSE)

<!-- nathwn12 house footer: identical in every repo. Do not edit. -->
<p align="center">
  <a href="https://github.com/nathwn12"><img src="assets/signature.svg" width="96" alt="nathwn12" /></a>
</p>
<p align="center">
  <sub>Built by <a href="https://github.com/nathwn12">nathwn12</a> · <a href="https://github.com/nathwn12?tab=repositories">All projects</a></sub>
</p>
