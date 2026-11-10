# Seam wdr-ui: report

## Outcome

Added the two surfaces the manifest already declared. `popup.html/css/js` shows the bridge pill, the friendly reason in its own live region, one row per source (YouTube and YouTube Music) and the presence switch, and opens Settings through `chrome.runtime.openOptionsPage`. `options.html/css/js` holds the application ID form (validated by `clientIdToPersist`, empty clears the override), the `auto|ipc|arrpc` transport select, the presence switch, a status card that renders the same `presentStatus` vocabulary plus the host's per-source states via `presentSources`, the two `node scripts/install-host.mjs` commands, and a read-only diagnostics block that is the only place `status.detail` appears. Both controllers import `config.js` and `bridge-status.js` directly — no build step, no new dependency, no remote URL, no inline script.

## Evidence

Red first, on the empty tree (surfaces absent):

```text
> node --test test/extension/ui.test.mjs
✖ the manifest points at popup and options, and both ship as local files
✖ ... 16 more
ℹ tests 17
ℹ pass 0
ℹ fail 17
AssertionError [ERR_ASSERTION]: popup.html ships beside the manifest
```

First implementation run, 13/17 — the failures were real, not harness noise. `popup renders the bridge and both source activities` exposed a production bug: the popup rendered the pill from stored `enabled` but never wrote it back to the checkbox, so the switch always showed off. Fixed in `popup.js` (`enabledEl.checked = enabled`). The other two were harness/test mismatches: the id scan did not know the `el("...")` helper, and the live-status test asked a static stub to change. The stub gained `setStatus` and the test now models the real path (worker persists, announces, popup re-reads the live status).

The brief's check, at the head handed back (`287b01c`):

```text
> node --test packages/web-discord-rpc/test/extension/ui.test.mjs
✔ the manifest points at popup and options, and both ship as local files (1.6622ms)
✔ each surface loads only its own local code: no remote URL, no inline script (7.5614ms)
✔ every control has an accessible name and every label resolves (5.6511ms)
✔ every id the controllers ask for exists in the shipped markup (2.9644ms)
✔ popup renders the bridge and both source activities (11.6859ms)
✔ popup reads the persisted status when the worker cannot answer (3.2121ms)
✔ popup treats Discord's absence as waiting copy, never an error, and keeps the raw detail off the surface (5.1421ms)
✔ popup marks a rejected application ID as an assertive error (2.7101ms)
✔ popup toggle writes the presence preference and renders presence off (4.9933ms)
✔ popup follows worker status changes while it is open (4.0855ms)
✔ popup Settings opens the options page instead of leaving the popup (2.6051ms)
✔ options renders the bridge, the chosen transport, the application and both activities (4.9911ms)
✔ options saves a valid application ID and clears back to the built-in one (7.0591ms)
✔ options refuses an application ID that is not 17 to 20 digits and writes nothing (3.7311ms)
✔ options offers exactly auto, ipc and arrpc, persists a change, and falls back to auto (8.0991ms)
✔ options toggle persists presence (6.4131ms)
✔ options shows the install commands and keeps the raw detail in diagnostics only (7.5548ms)
ℹ tests 17
ℹ pass 17
ℹ fail 0
continue
ℹ duration_ms 238.4564
EXIT=0
```

Whole package, same tree:

```text
> node --test packages/web-discord-rpc/test/
ℹ tests 202
ℹ pass 202
ℹ fail 0
```

Commit:

```text
> git show --stat HEAD
287b01c web-discord-rpc: add popup and options surfaces over the bridge status vocabulary
 packages/web-discord-rpc/options.css               | 323 +++++++++++
 packages/web-discord-rpc/options.html              | 120 ++++
 packages/web-discord-rpc/options.js                | 251 +++++++++
 packages/web-discord-rpc/popup.css                 | 203 +++++++
 packages/web-discord-rpc/popup.html                |  51 ++
 packages/web-discord-rpc/popup.js                  | 131 +++++
 .../web-discord-rpc/test/extension/ui.test.mjs     | 438 ++++++++++++++++
 .../web-discord-rpc/test/ui/helpers/fake-ui.mjs    | 603 ++++++++++++++++++++++++
 8 files changed, 2120 insertions(+)
```

The check can go red for the right reason: the 17-fail run above, plus four intermediate failures that were production and harness defects rather than assertions on absent files.

## Unverified

- Not opened in Chrome. The harness parses the shipped HTML and imports the shipped modules for real, so wiring, ids, labels and render behaviour are proven, but MV3 CSP acceptance and visual layout are not. `Unverified: Chrome loads and draws both pages`.
- `popup.html` references `icons/icon24.png` and `options.html` references `icons/icon48.png`. Both exist on disk (verified by `ls icons`), and `manifest.test.mjs` proves their PNG shape, but no test in my seam asserts those two references resolve. `Unverified: the img src paths are correct in a loaded extension`.
- Keyboard traversal was checked structurally (native controls, no `tabindex`, every label resolves, live regions present). No focus-order assertion in a real browser.

## Scope

Touched exactly the eight Files in the brief, all inside `packages/web-discord-rpc/`:

- `popup.html`, `popup.css`, `popup.js`
- `options.html`, `options.css`, `options.js`
- `test/extension/ui.test.mjs`
- `test/ui/helpers/fake-ui.mjs`

Nothing else is modified. `.stack/*` dirty entries in `git status` predate this seam and were left alone; only the eight paths above were staged.

One thing outside my Files needs the lead: `packages/web-discord-rpc/package.json`'s `test` script enumerates files and does not list `test/extension/ui.test.mjs`, so `npm test` in this package will not run the new check. I did not edit it (not mine). Add it in a seam that owns `package.json`.

## Lesson

A UI seam in this repo can be proven without jsdom: parse the shipped HTML with a ~60-line tag parser, install it plus a storage/sendMessage stub as globals, and `import()` the real controller with a cache-busting query. That combination catches the failures that matter here — an id typo the tests never touch (static scan of `el("...")` against the markup), a label pointing at nothing, a raw native diagnostic leaking onto a card, and a render that forgets to write stored state back into its control. The one place this harness is weaker than a browser is ordering: a static `sendMessage` stub makes "re-read live status on change" look broken, so the stub needs `setStatus` to model the worker's answer moving. When a test disagrees with the production path, check which one is lying before changing either.
