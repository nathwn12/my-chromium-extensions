# Goal

## Out

All four extensions are sorted and true: Audio Normalizer (global), Slowed Reverb (YouTube Music only), Crunchy Presence 1.2.0 (Crunchyroll, desktop IPC primary with an optional arRPC fallback), and YouTube Presence 1.0.0 (YouTube + YouTube Music, YouTube Music first, per-site toggles, installed desktop app over IPC; web/arRPC deferred). Playwright is gone, Gladius is the only browser tester, docs and versions match the code, and `main` is pushed.

## Check

```
npm test
node scripts/verify-integration.mjs
node --test packages/web-discord-rpc/test
node --test packages/crunchy-presence/test
node packages/web-discord-rpc/native/host.mjs --selftest
node packages/crunchy-presence/native/host.mjs --selftest
git status --short
git push origin main
```

Plus the desktop receipt already observed: a test activity over `\\.\pipe\discord-ipc-0` showed **Watching YouTube — Desktop RPC test / eyeball** in the Discord profile popout, then cleared.

## Constraints

- The web/arRPC RPC path is deferred: desktop IPC is the default, auto/arRPC remain optional.
- No Playwright dependency, import, QA script, lock entry or CI step.
- Local-only, no store publish, no telemetry, no new runtime dependency.
- One writer per file; every source change is a seam.

## Budget

This session. Stop on an owner gate or when the check and the independent audit are green.

## Assumption

"Focus on browser to desktop app" means the extension reads the browser media state and sends it to the installed Discord app over its local IPC pipe; Discord Web is not the target for this pass.
