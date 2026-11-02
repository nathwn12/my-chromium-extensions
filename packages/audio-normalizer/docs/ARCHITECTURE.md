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
