# ARCHITECTURE — Audio Normalizer (injection + worklet URL contract)

## Frame-targeted injection

- `content-script.js` runs in every frame (`all_frames`). Its `INJECT_PAGE_HOOK`
  sender carries the originating `frameId`.
- `background.js` injects `page-hook.js` (MAIN world) into exactly that frame:
  `target: { tabId, frameIds: [sender.frameId] }`. A call with no sender frame
  (tab-level) defaults to frame 0 only. A frame that disappears mid-call
  returns `{ ok: false, error }` — it never throws.
- Result: a video inside a cross-origin iframe gets its own MAIN-world hook
  in its own frame; the top frame is no longer the only normalized context.

## Worklet URL contract

- The ONLY trusted worklet URL source is the START message from the ISOLATED
  content script, which derives it via
  `chrome.runtime.getURL('audio/normalizer-worklet.js')` and sends it as
  `workletUrl` on every `START`.
- The page-writable DOM attribute `data-tn-worklet-url` is ONLY the
  pending-start fallback (set just before injection so the hook can auto-start
  before the first START arrives). It is consumed once at hook load and
  removed immediately.
- Origin pinning: the hook pins the exact origin of the content-script-set
  attribute value at load. A candidate URL validates only when its origin
  equals the pinned origin AND its path is exactly
  `/audio/normalizer-worklet.js`. A page START naming any other
  `chrome-extension://` id fails closed, as does a missing pinned origin.
  There is no page-relative fallback anymore.
- The hook echoes `gainDb` on every `HOOK_STATUS`/`HOOK_STARTED` and
  re-applies `state.gainDb` to live worklets before reporting; the content
  script corrects any drift with its stored truth, so a page-forged SET_GAIN
  cannot persist past one status cycle.
- A page-defined `window.__tabNormalizerHookV5` never blocks the real hook:
  the hook always installs/overwrites and early-returns only when its own
  `AudioNode.prototype.__tnConnect` patch is already present.
- After `STOP` the DOM pending fallback is ignored (`state.stopped`) until a
  real `START` arrives; the content script additionally posts STOP when a
  disabled tab reports an active hook.

## Site keys (injection contract)

- The canonical site key is the FULL normalized hostname:
  `alice.github.io` and `bob.github.io` are different sites. `getSiteKey`
  no longer collapses subdomains.
- The old collapsed (eTLD+1, ccTLD-aware) form survives ONLY as
  `getLegacySiteKey`: a read-only fallback consulted when no full-key record
  exists (legacy maps, legacy `site:<collapsed>` records). The first write
  migrates to the full key. Broadcast tab matching accepts the full key or
  the legacy key.

## Frame targeting (opaque origins)

- `content_scripts` sets `match_origin_as_fallback: true`, so the content
  script also runs in `about:blank`/srcdoc/opaque-origin iframes; MAIN-world
  injection still targets the sender frame (`frameIds: [sender.frameId]`).

## Live enable/disable (no reload)

The toggle must act on the document that is already playing, so "off" can no
longer mean "nothing is installed".

- **`seen`.** A per-site record carries `seen`, set on the first enable and
  never cleared by a disable. It is derived on read (`seen || enabled`), so no
  data migration is needed: a record written before the field existed is seen
  exactly when it is enabled.
- **Registration.** `deriveContentScriptRegistration` matches `seen || enabled`,
  minus `excluded`. A host that was never enabled and is off stays at zero
  cost (no content script, no hook, no registration entry). A seen host keeps
  the `document_start` pair so a later enable needs no navigation.
- **Reservation mode.** On a seen-but-off document the content script injects
  `page-hook.js` (MAIN) and starts nothing: no `AudioContext`, no worklet, no
  observer, no media capture, no listener. The hook is *present and idle* —
  which is all the one-`MediaElementSource`-per-element rule and the
  page-graph patches require, because both must exist before the page creates
  them. The page plays natively and the audio graph is untouched while off.
- **Enable.** `SET_SITE_STATE { enabled: true }` records the flag (and `seen`),
  the background answers `activation: { state: 'live' }`, and its
  `TOGGLE_CHANGED` broadcast makes the content script `START` the hook that is
  already there: `attachExistingMediaElements` captures the playing elements,
  the pre-warmed session routes through the worklet, and one program
  generation is minted. No navigation; `currentTime` is never touched.
- **Disable.** `STOP` is a bypass: `input → output` at 0 dB, the worklet is
  disconnected, the observer stops, and the sessions, sources and dispatcher
  are **kept**. `destroy` is reserved for exclusion and uninstall, and is the
  only path that releases captures — after which the element cannot be
  recaptured in that document and only a reload restores it.
- **First-ever enable.** A host with no hook in the loaded document is the one
  residual reload case, and it is **automatic**: the background records `seen`,
  answers `activation: { state: 'reloading' }`, waits ~500 ms so the popup can
  paint, and calls `chrome.tabs.reload(tabId)` exactly once (a disable, a live
  enable or an exclusion never reloads). If the tab id is missing, the platform
  refuses, or the API is absent, it falls back to the notice
  (`activation: { state: 'reload' }`) and no reload is attempted. This is the
  only navigation the extension ever performs.
- **Verdicts, not silence.** A page-claimed element throws `InvalidStateError`
  on capture and is left unmuted and unmanaged (`__tnWebAudio`), never retried
  in a loop; a suspended context defers capture to the next gesture/play
  event rather than routing into a suspended graph.

## Session liveness (related)

- Autoplay-policy `resume()` is raced with a 300 ms timeout; click/touch/key
  retry listeners register before the await, and session creation proceeds
  without waiting on a pending resume.
- An injected-but-dead hook (`state.injected && !state.hookAlive`) re-syncs
  through the capped activation retry (`scheduleLivenessResync`), never a busy
  loop.
- The silence-until-routed guard restores the pre-guard muted value only while
  the element is still guard-muted.
- Re-enabling (inactive → active with a prior program) mints one fresh program
  generation and broadcasts exactly one `reset-program`; attach paths never
  mint. Open shadow roots are observed (`attachShadow` patched); closed roots
  are still caught by the `play()` patch.
