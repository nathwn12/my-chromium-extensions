# Slowed Reverb Audio — Chrome Extension

Plain MV3 extension. No build/bundle. No TS. Vanilla ES2020. Files are the source.

## Product guardrails (user mandates — do not violate)

- **Chromium/Brave only. No Firefox, no WebKit.** Never add other-browser code back.
- **Fewer knobs is better.** Popup ships exactly: speed slider, reverb intensity slider, Active toggle, reset. Do not add controls.
- **As-is is already good; instant, low footprint, just works, zero headaches.** Don't refactor working code for polish.
- **Work on a dedicated branch (`dev2` style), never on `main`** — user: "at all costs." `main` stays stable until explicit merge.

## Entrypoints

| File | Loading | Role |
|------|---------|------|
| `background.js` | `importScripts('shared.js')` (service worker) | Storage, tab coordination, script injection |
| `content-script.js` | manifest `content_scripts` `js` array, `document_start` | AudioContext, media capture, rate watchdog |
| `shared.js` | `<script src>` in popup, `importScripts` in SW, manifest `js` in CS | `globalThis.SlowedReverbShared` helpers |
| `page-hook.js` | `chrome.scripting.executeScript` with `world: 'MAIN'` | Lifecycle signals via `postMessage` (`__slra: true`) |
| `popup.js` | `<script src>` in `popup.html` | Sliders, power toggle, live polling (1s interval) |
| `dattorro-worklet.js` | `chrome.runtime.getURL` → `audioWorklet.addModule` | Dattorro plate reverb `AudioWorkletProcessor` |

## Architecture

- **Content script is idempotent**: sentinel `globalThis.__slowedReverbAudioContent`; if present with `.refresh`, calls it and returns early. Prevents double-injection from SPA re-navigation.
- **`page-hook.js` runs in MAIN world** (separate JS realm from content script), signals via `window.postMessage` with `__slra: true`. Content script listens for `SLRA_PAGE_HOOK_READY`, `SLRA_PAGE_REVIVE`.
- **Audio pipeline**: `media.captureStream()` → `AudioContext.createMediaStreamSource()` → dry gain + Dattorro `AudioWorkletNode` → master gain → `destination`.
- **Mute semantics** (attach/teardown paths in `content-script.js`, keyed on `media.muted = controller.attached`): while the tab is active the audio graph (AudioContext + worklet + dry/master gains) stays attached and the reverb tank stays primed, including at neutral settings (`slow=1`, `intensity=0`) — only the wet output is zero, so raising the reverb slider is instant with no wind-up. `media.muted` is set to `controller.attached` while the pipeline is live to prevent double audio from element + destination, and restored to `false` on teardown. At neutral settings with an active tab the element is therefore **muted** while its captured stream is rendered. Bypass (power off for the tab) detaches the graph and unmutes the element.
- **Rate watchdog**: 2s `setInterval` corrects playback rate if it drifts >0.02 from target. Restarts on eligible/bypass transitions.
- **SPA navigation**: handles `yt-navigate-*`, `spfdone`, `popstate`, `hashchange`, `visibilitychange`, `pageshow`, `focus`, plus `MutationObserver` (50ms debounce). Both MAIN-world (`page-hook.js`) and ISOLATED-world (`content-script.js`) listen — intentional redundancy, not a duplicate.
- **`mozPreservesPitch`/`webkitPreservesPitch`** are set alongside `preservesPitch` in `readPitchState`/`applyPitchState`/`setPreservesPitch`. They are Chromium-exposed, writable aliases that YouTube's player reads/writes — **do not remove** (in-code comment explains).
- **Worklet modulation LFO**: modulated delays sweep a triangle of ±8 samples around `modDelay1.base`/`modDelay2.base` (fields `modDepth`, `modPhase`, `modDir`), stepped every 2048 samples. Deliberate shimmer; don't "simplify" it away. Rest of the worklet is a faithful Dattorro (delay constants match the 1997 paper).

## Activation

- **Supported hosts** (`shared.js:SUPPORTED_HOSTS`): `music.youtube.com` only (owner order 2026-11-02 — YouTube Music only).
- ~~`m.youtube.com`~~ removed (owner order 2026-11-02 — YouTube Music only): no longer in `manifest.json` `host_permissions` or `content_scripts.matches`, and never in `SUPPORTED_HOSTS`. Do not re-add any non-Music YouTube host without an explicit owner order.

## Storage

- `chrome.storage.local` only (no `session`). Persistent keys: `siteSettings`, `siteToggles`. Read-modify-write, not atomic (`getStoredSiteSettings`/`setStoredSiteSettings` do `get` then `set`).
- Tab bypass + per-tab session settings are **in-memory `Map`s** in `background.js` (`tabBypassById`, `tabSessionById`) — lost on service-worker restart. The `TAB_BYPASS_KEY`/`TAB_SESSION_KEY` consts are unused labels, not storage keys.
- `popup.js` sends `persist: true` in `SET_SITE_SETTINGS` messages; `background.js` never reads it. Dead field — harmless, leave it.

## Tab rehydration

- Service worker rehydrates all eligible tabs on `onStartup` / `onInstalled`.
- Concurrency limit: **5 tabs at once** (`CONCURRENCY` const in `background.js`). Sequential `pushTabState` per slot.

## Commands

```
npm run lint                          # eslint (flat config eslint.config.mjs) — expect 0 errors, 0 warnings; skips qa/ (ignored in config)
node --check <file>.js                # syntax check per script (no build step exists)
node qa/mute-test-quick.js            # headless QA: real Chromium + extension, routed YouTube fixture
node qa/mute-test.js                  # HEADED — user-invoked only; never run unattended
npx playwright install chromium       # one-time browser download for QA (cached after)
```

`npx playwright test --config qa/playwright.config.js` finds **0 tests** — no `*.spec.*`/`*.test.*` files exist; the standalone scripts above are the real QA (`qa-mute-check.js` doesn't match the runner's test pattern either).

## Verification safety

- **No audio playback in any test, ever.** Do not launch any Chromium that can produce sound: no autoplay, no headed browser, no chrome-devtools MCP audio, and no muted-playback "audio test" either. A browser-based audio check is not permitted; if one is ever truly unavoidable, STOP and get explicit user approval before running it — never run it first and report afterwards.
- Verification is **static and numeric only**: `npm run lint`, `node --check <file>.js`, unit tests, and offline numeric analysis of captured sample buffers that are never connected to a destination or device (`OfflineAudioContext`, or a worklet driven straight into a `Float32Array` from a plain Node harness with `AudioWorkletProcessor`/`registerProcessor`/`sampleRate` stubbed).
- CPU evidence is the **browser usage gauge** (Chrome/Brave Task Manager, `Shift+Esc`) — a human-read gauge, not a benchmark. Do not add or run a bespoke CPU benchmark harness.
- `qa/mute-test.js` (headed) and `qa/mute-test-quick.js` (headless) are browser audio checks and are **not run by agents**; user-invoked only.

## QA

- `qa/mute-test.js` (headed) and `qa/mute-test-quick.js` (headless) launch real Chromium with the extension loaded unpacked and route a synthetic WAV fixture page under `youtube.com`; they assert the graph is **attached** and the element **muted** at neutral settings, and **detached** with the element **unmuted** when the tab is bypassed, across fresh play, reload-play, and pause-reload-play. These scripts perform browser audio checks and must **not** be run by agents — user-invoked only, consistent with `## Verification safety`.
- `qa/headless-repro.js` is a fixture-driver module, not a standalone test.
- If the browser bundle is missing, run `npx playwright install chromium` first.

## Editing `.js` files — environment gotcha (important)

- The `edit`/`write` tools in this workspace **auto-reformat `.js` files on write** (single→double quotes, full-file re-wrap): a 3-line edit became a +200/−125 noise diff. Always check `git diff --stat` after touching a `.js` file.
- For surgical `.js` edits, apply them via shell (e.g., python). Git autocrlf keeps the working tree on CRLF: normalize `\r\n` → `\n` before string-matching, then write back (LF is fine; `git diff` normalizes).
- `popup.html`/`.md` files are not reformatted — the quirk is `.js` only.

## .gitignore quirks

- Ignores `*.md`, `*.json`, `*.zip`, `/qa`, `/.agnes/`, `/output/`, `/user-data/`, `/.dev`, `/.prod`. Do not commit these file types.
- `/qa` ignored means the QA scripts themselves are **untracked local-only** — edits there never show in `git status`.
- Already-tracked `.md` exceptions stay in git: `README.md`, `PRIVACY_POLICY.md`, `STORE_SUBMISSION.md`.
- **`package.json` IS tracked** — its changes appear in `git status`. `package-lock.json` and `AGENTS.md` itself are NOT tracked — their changes never appear in `git status` (force-add with `-f` if ever needed).
