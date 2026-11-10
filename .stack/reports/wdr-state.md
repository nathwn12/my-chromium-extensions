## Outcome

Shipped the web-discord-rpc state worker: `activity.js` builds one Discord payload per source (`buildActivity(source, state, now)` — WATCHING type 3 for YouTube, LISTENING type 2 for YouTube Music, contract text limits, source-hosted button, whole-second timestamps), `background.js` keeps per-source tab state, picks the freshest playing tab, coalesces to four sends per 20 s **per source**, owns the single native port (hello/activity/ping), and replays the desired activity for both sources after a reconnect; `bridge-status.js` owns the status vocabulary from the contracts (`connected|waiting|error`, `arrpc-closed|host-missing|rejected|hung`, friendly copy, `presentStatus`, `presentSources`) and the `wdrStatus` storage key the popup will read. Thirty-five tests cover the builder, the worker through its real listener wiring with a fake chrome, and the status presenter. No commit was made: other seams' files are uncommitted in this shared worktree, so landing is the lead's.

## Evidence

Red first — the tests existed before the modules, and the command failed for the right reason:

```text
node --test packages/web-discord-rpc/test/extension/activity.test.mjs packages/web-discord-rpc/test/extension/background.test.mjs packages/web-discord-rpc/test/extension/bridge-status.test.mjs

Error [ERR_MODULE_NOT_FOUND]: Cannot find module '...\web-discord-rpc\activity.js'
✖ packages\web-discord-rpc\test\extension\activity.test.mjs
```

Green at the handed-back head (exit 0):

```text
✔ a YouTube watch page becomes a WATCHING card (1.3611ms)
✔ a YouTube Music track becomes a LISTENING card (0.1732ms)
✔ the album is optional and the artist falls back to the source label (0.1538ms)
✔ the channel falls back to the source label for YouTube (0.1125ms)
✔ no title, unknown source or no state means no activity (0.1378ms)
✔ details cap at 128 characters (0.1601ms)
✔ assets are omitted without an https artwork URL (0.1673ms)
✔ buttons are omitted unless the page URL is https on the source host (0.3285ms)
✔ timestamps need playing, a duration and a real position (0.2458ms)
✔ timestamps clamp the position into the duration (0.2035ms)
✔ clampText collapses whitespace, rejects short text and caps length (0.1022ms)
✔ boot opens one native port with the built-in application id and arRPC transport (1.6577ms)
✔ one tab per source produces two simultaneous activities, WATCHING and LISTENING (0.9749ms)
✔ a playing tab wins over a paused tab for the same source (0.3113ms)
✔ four sends per 20 s per source, newest wins, per source independently (1.3458ms)
✔ a port loss keeps the desired state and replays it after the reconnect (0.9855ms)
✔ a tab-scoped gone clears that source only (0.316ms)
✔ a closed tab drops its state (0.2686ms)
✔ foreign senders, untrusted frames and cross-source URLs are ignored (0.1929ms)
✔ status frames classify a closed arRPC as waiting and a rejected id as error (0.2824ms)
✔ the status payload carries both activities and is persisted for the popup (0.2905ms)
✔ a stored application id replaces the built-in one and reconnects (0.1645ms)
✔ a stale tab state is pruned by the watchdog and clears presence (0.2352ms)
✔ pickBestTab prefers playing, then the fresher report (0.0987ms)
✔ the reason vocabulary is the one the host puts on the wire (0.625ms)
✔ a connected status frame is available with no reason (0.1676ms)
✔ an absent arRPC is waiting, never an error, and keeps the raw detail (0.2967ms)
✔ a missing native host is waiting with installer copy (0.1439ms)
✔ a rejected application ID is the only plain error (0.1762ms)
✔ an exhausted hang becomes an error, a fresh hang stays waiting (0.1776ms)
✔ a host-declared transient error is never promoted to a permanent one (0.0983ms)
✔ classifyBridgeFailure recognises raw diagnostics without a reason hint (0.1093ms)
✔ presentStatus turns a payload into the four things a surface renders (0.5235ms)
✔ copyForReason always returns friendly copy for an unknown kind (0.1605ms)
✔ presentSources labels the host's per-source map and tolerates junk (0.1985ms)
ℹ tests 35
ℹ pass 35
ℹ fail 0
```

The rate test can go red: with `MAX_UPDATES` temporarily set to 5 the same command failed exactly there and only there.

```text
✖ four sends per 20 s per source, newest wins, per source independently (2.0263ms)
ℹ fail 1
EXIT=1
```

The pre-existing package tests still pass: `npm test --workspace=web-discord-rpc` → 27/27, exit 0.

## Unverified

- Unpacked load in Chrome: not run; no browser in this seat. The worker's module-level `if (hasChrome)` branch, `chrome.runtime.connectNative`, `lastError` on disconnect and `alarms.get` are exercised only against a fake chrome.
- The callback-style `alarms.get` branch is untested; the fake returns `undefined` synchronously and the tests take the create path.
- The native host's exact per-source label set was read from the in-flight `packages/web-discord-rpc/native/host.mjs` (`sources: {youtube: "idle"|"waiting"|"connected"|"error"}`) but that seam is still red and may change; the worker carries the map opaquely and `presentSources` falls back to "Not connected" for anything unknown.
- MV3 suspension is handled only as far as `storage.session` allows: the tab map is mirrored and restored (see Persistence below), but a suspended worker still loses the native port and relies on the reconnect replay; the real Chrome suspension cycle was not exercised.
- `{t:"wdr-get-status"}` is my own extension-internal message (contracts only fix the native wire); the popup seam must use that name, or we change it in one place before popup lands.
- No commit: `git status` shows other seams' files in this worktree.

## Scope

Created, all inside Owns:

- `packages/web-discord-rpc/activity.js`
- `packages/web-discord-rpc/background.js`
- `packages/web-discord-rpc/bridge-status.js`
- `packages/web-discord-rpc/test/extension/activity.test.mjs`
- `packages/web-discord-rpc/test/extension/background.test.mjs`
- `packages/web-discord-rpc/test/extension/bridge-status.test.mjs`

Plus this report (`.stack/reports/wdr-state.md`, required by the brief). No other file was written; `git status` shows no modification outside the six paths and the report.

## Lesson

The contract's field list is not the whole design: `buildActivity` needed a decision for a title that is one character (Discord rejects details under 2, so it is treated as no title), an empty channel (falls back to the source label so `state` is always valid), and a per-source `pageUrl` (music URL under the YouTube source emits no button). My one deviation worth naming: the worker accepts reports from the top frame only, because content runs `all_frames` and a nested YouTube embed would otherwise overwrite the page it sits in. The next employee writing `popup.js` should import `presentStatus` and `presentSources` from `bridge-status.js` and read `storage.local.wdrStatus` or ask the worker for `{t:"wdr-get-status"}`; the host already emits per-source states in the same vocabulary.

## Persistence

MV3 suspension no longer loses desired state inside the two owned files.

- `background.js` mirrors the per-source tab map to `chrome.storage.session` under `wdrTabs` on every change (state report, `wdr-gone`, tab close, TTL prune), deduped by the serialised snapshot so an idle watchdog tick writes nothing.
- `start()` reads that snapshot before it opens the port, hydrates with per-field validation, and lets a fresher live report win on the same tab (`existing.at >= entry.at`). If at least one tab was restored it reconciles **both** sources: the source with a tab replays its activity, the source without one replays a clear.
- Writes stay off until the read settles (`!restored` in `persistTabs`), so a content report that lands while the startup read is in flight cannot replace the stored map with the one tab it has seen. The read-failure path also disables writes rather than clobbering a good snapshot.
- An alarm that fires before the restore resolves waits for it (`void restore().then(...)`) instead of recomputing from an empty map and clearing presence.
- The rate limiter and the `wdrStatus` persistence are unchanged; the restored path goes through the same limiter and the same post-connect replay.

Evidence, same command, at the handed-back head (exit 0):

```text
✔ tab state is mirrored to storage.session on every change (0.3416ms)
✔ a fresh worker restores both sources and replays them after the port connects (0.5408ms)
✔ a corrupt or missing session value is ignored without breaking the worker (0.503ms)
✔ a report that lands before the restore resolves does not clobber the stored map (0.4009ms)
✔ a restored snapshot reconciles a source with no tab to a clear (0.4403ms)
ℹ tests 40
ℹ pass 40
ℹ fail 0
```

The new tests can go red. Deleting `await restore()` and the `persistTabs()` call failed exactly:

```text
not ok 12 - a stale tab state is pruned by the watchdog and clears presence
not ok 14 - tab state is mirrored to storage.session on every change
not ok 15 - a fresh worker restores both sources and replays them after the port connects
```

Dropping `!restored` from the write guard failed only `a report that lands before the restore resolves does not clobber the stored map`; dropping `restoredAny` from the reconcile loop failed only `a restored snapshot reconciles a source with no tab to a clear` and that same race test. `npm test --workspace=web-discord-rpc` stays green at 27/27.

Unverified for this section: the real Chrome suspension and `storage.session` lifetime were not exercised — the tests run the same worker factory against a fake `storage.session` that keeps its map across worker instances. `storage.session` quota and its availability without `unlimitedStorage` are not measured.
