# Goal

## Out

All four extensions are sorted and true: Audio Normalizer (global), Slowed Reverb (YouTube Music only), Crunchy Presence 1.2.0 (Crunchyroll, desktop IPC primary with an optional arRPC fallback), and YouTube Presence 1.0.0 (YouTube + YouTube Music, YouTube Music first, per-site toggles, installed desktop app over IPC; web/arRPC deferred). Playwright is gone, the guard that proves it scans the tracked source surface without silent skips, docs and versions match the code, and `origin/main` equals the audited HEAD.

## Check

```
npm test
node scripts/verify-integration.mjs
node scripts/verify-integration.mjs --prove-red
node packages/web-discord-rpc/native/host.mjs --selftest
node packages/crunchy-presence/native/host.mjs --selftest
node packages/web-discord-rpc/scripts/e2e-arrpc.mjs && node packages/web-discord-rpc/scripts/e2e-ipc.mjs
git status --short          # clean outside nothing: must print nothing
git rev-parse HEAD origin/main   # must be the same object after push
```

Plus the desktop receipt already observed: a test activity over `\\.\pipe\discord-ipc-0` showed **Watching YouTube — Desktop RPC test / eyeball** in the Discord profile popout, then cleared.

## Constraints

- The web/arRPC RPC path is deferred: desktop IPC is the default, auto/arRPC remain optional.
- No Playwright dependency, import, QA script, lock entry or CI step; the guard's coverage matches the sentence that sells it.
- Local-only, no store publish, no telemetry, no new runtime dependency.
- One writer per file; every source change is a seam.
- Procedural rules may bend when they produce a false negative: force-land with a logged `RULING`, substitute a whole-head audit for per-seam GO receipts. Evidence never bends: no fabricated receipt, no unrun check, no history rewrite, no forced push, no branch-protection bypass.

## Stop conditions

1. `stack check` is GREEN at the pushed HEAD, the tree is clean, `origin/main` equals local HEAD, and an independent audit returns PASS or PASS WITH NOTES.
2. An owner gate: an irreversible act, money above cap, a security-sensitive act, an outward side effect, or no path at all.
3. Two consecutive turns with no new evidence.
4. Budget spent: this session, at most three worker dispatches and two audit dispatches from now.

## Budget

This session. Three worker dispatches (one is the verifier seam), two audit dispatches. Each worker one commit; each audit one verdict.

## Assumption

"Focus on browser to desktop app" means the extension reads the browser media state and sends it to the installed Discord app over its local IPC pipe; Discord Web is not the target for this pass.
