# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Nothing yet.

## [1.0.2] - 2026-10-02

### Added

- Pitch-safe YouTube slowdown from 0.7x to 1.3x without pitch distortion.
- Local Dattorro plate reverb implemented as an AudioWorkletProcessor in `dattorro-worklet.js`, with adjustable intensity (0-100%).
- Primed reverb tank for instant wet output with no wind-up (primed t90 13ms vs cold 303ms), plus a rebuild guard and safe unmute ramp.
- Per-site speed, reverb intensity, and Active state persisted in `chrome.storage.local`, surviving restart and refresh with auto-apply on first play.
