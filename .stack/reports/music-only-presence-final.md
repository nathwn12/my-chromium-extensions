## Outcome

Completed the Music-only extension path, persistent accessible toggle, artist-state payload, timestamp extraction/builder guards, aligned docs/tests, and the single 1.0.4 version bump. Fixed the coalescing timer candidate defect so deferred latest-song updates flush at the actual rolling-window boundary. No actual Discord rendering claim is made.

## Evidence

Check command: `npm test --workspace=packages/web-discord-rpc`

Actual output excerpt from that command:

```text
npm notice run web-discord-rpc@1.0.4 test
npm notice run node ../../scripts/run-tests.mjs test
✔ timestamp documentation requires real media position and duration (0.328ms)
✔ timestamps need playing, a duration and a real position (0.2873ms)
✔ timestamps clamp the position into the duration (0.1535ms)
✔ elapsed/end come from the real media clock: audio-backed playback still stamps time (0.1248ms)
✔ four sends per 20 s, newest wins: rapid skips collapse to the latest song (1.1235ms)
✔ the outgoing SET_ACTIVITY frame carries artist state, display type 1 and real timestamps (0.2729ms)
✔ audio playback extraction preserves its real position and duration for timestamps (0.5473ms)
✔ e2e-arrpc drives the native host over a real WebSocket (268.4578ms)
✔ e2e-ipc drives the native host over a real named pipe (189.8803ms)
ℹ tests 212
ℹ suites 0
ℹ pass 212
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 889.7907
```

Exit status: 0. A watched red preceded the timer correction: `node --test packages/web-discord-rpc/test/extension/background.test.mjs` produced `✖ four sends per 20 s...` / `one deferred send after the window, newest wins` / `4 !== 5` (exit 1). After correction the same test command printed `ℹ tests 34`, `ℹ pass 34`, `ℹ fail 0`, `ℹ duration_ms 90.482` (exit 0). The package check also proves `status_display_type: 1` and exact real timestamp values in the outgoing activity frame.

`oc-stacked scope` reported `31 in, 1 out`, naming only root `package-lock.json` as out. The brief explicitly lists root `package-lock.json` in both Owns and Files (lines 51 and 90); it is included for the required 1.0.4 lockfile bump, not as scope widening.

## Unverified

- Discord's actual member-list rendering of `state` with `status_display_type: 1`; only the outgoing payload was tested, as required.
- Live YouTube Music DOM behavior on a real playback session; extraction and media-event coverage uses the local fake-page harness. The regression guard verifies audio element values through the extraction unit and timestamps through the IPC e2e fixture, not a live browser-to-Discord session.
- Windows actual Discord desktop rendering/connection; the named-pipe e2e uses a local fake named pipe.

## Scope

Changed paths, all expressly within the brief's exact Files list (except the separately mandated report):

- `README.md`
- `package-lock.json`
- `packages/web-discord-rpc/CHANGELOG.md`
- `packages/web-discord-rpc/README.md`
- `packages/web-discord-rpc/activity.js`
- `packages/web-discord-rpc/background.js`
- `packages/web-discord-rpc/config.js`
- `packages/web-discord-rpc/content.js`
- `packages/web-discord-rpc/docs/ARCHITECTURE.md`
- `packages/web-discord-rpc/docs/INSTALL.md`
- `packages/web-discord-rpc/docs/RESEARCH.md`
- `packages/web-discord-rpc/extract-youtube.js`
- `packages/web-discord-rpc/manifest.json`
- `packages/web-discord-rpc/options.html`
- `packages/web-discord-rpc/options.js`
- `packages/web-discord-rpc/package.json`
- `packages/web-discord-rpc/popup.html`
- `packages/web-discord-rpc/popup.js`
- `packages/web-discord-rpc/scripts/e2e-arrpc.mjs`
- `packages/web-discord-rpc/scripts/e2e-ipc.mjs`
- `packages/web-discord-rpc/test/docs.test.mjs`
- `packages/web-discord-rpc/test/extension/activity.test.mjs`
- `packages/web-discord-rpc/test/extension/background.test.mjs`
- `packages/web-discord-rpc/test/extension/config.test.mjs`
- `packages/web-discord-rpc/test/extension/content.test.mjs`
- `packages/web-discord-rpc/test/extension/extract-youtube.test.mjs`
- `packages/web-discord-rpc/test/extension/helpers/fake-page.mjs`
- `packages/web-discord-rpc/test/extension/manifest.test.mjs`
- `packages/web-discord-rpc/test/extension/ui.test.mjs`
- `packages/web-discord-rpc/test/integration/arrpc-e2e.test.mjs`
- `packages/web-discord-rpc/test/integration/ipc-e2e.test.mjs`
- `packages/web-discord-rpc/test/native/transport.test.mjs`
- `.stack/reports/music-only-presence-final.md` (required report)

Pre-existing `.stack/digest.md`, `.stack/ledger.md`, other untracked `.stack/briefs/*`, and `.stack/fix-extract.mjs` were not edited or staged.

## Lesson

Treat extracted elapsed time as required input, not a defaultable value: `Number(null)` silently becomes zero and creates a plausible but fabricated timer, so null/undefined/empty input must be rejected before conversion. Also assert a rate limiter at the actual boundary time; a loose later assertion can hide a timer scheduled almost a full window too late. The Music audio element needs both extraction and content-event coverage, since a test that only feeds synthetic state to the activity builder cannot catch either break.
