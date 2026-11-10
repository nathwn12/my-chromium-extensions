# Seam youtube-presence-ui: YouTube Presence UI, name and per-site toggles

**Owner of this seam:** one `employee` employee. **Written by:** the lead. **State:** briefed.

## Why now

The owner named it YouTube Presence and wants either or both sites selectable, with YouTube Music first.

## Out

The extension is named YouTube Presence everywhere, options has independent YouTube Music and YouTube toggles backed by SITE_ENABLED_KEYS, the UI lists YouTube Music first, and README/docs/CHANGELOG describe desktop-first with web deferred.

## Check

```text
node --test packages/web-discord-rpc/test
```

It passes only when the command exits 0 and the output shows the new behaviour.
A check that cannot go red is not a check.

## Owns

- `packages/web-discord-rpc/manifest.json`
- `packages/web-discord-rpc/package.json`
- `packages/web-discord-rpc/popup.*`
- `packages/web-discord-rpc/options.*`
- `packages/web-discord-rpc/README.md`
- `packages/web-discord-rpc/CHANGELOG.md`
- `packages/web-discord-rpc/docs/**`
- `packages/web-discord-rpc/test/extension/manifest.test.mjs`
- `packages/web-discord-rpc/test/extension/ui.test.mjs`
- `packages/web-discord-rpc/test/docs.test.mjs`

## Files (exact, exclusive)

- `packages/web-discord-rpc/manifest.json`
- `packages/web-discord-rpc/package.json`
- `packages/web-discord-rpc/popup.html`
- `packages/web-discord-rpc/popup.css`
- `packages/web-discord-rpc/popup.js`
- `packages/web-discord-rpc/options.html`
- `packages/web-discord-rpc/options.css`
- `packages/web-discord-rpc/options.js`
- `packages/web-discord-rpc/README.md`
- `packages/web-discord-rpc/CHANGELOG.md`
- `packages/web-discord-rpc/docs/ARCHITECTURE.md`
- `packages/web-discord-rpc/docs/INSTALL.md`
- `packages/web-discord-rpc/docs/RESEARCH.md`
- `packages/web-discord-rpc/test/extension/manifest.test.mjs`
- `packages/web-discord-rpc/test/extension/ui.test.mjs`
- `packages/web-discord-rpc/test/docs.test.mjs`

No other seam may touch these. No other file is yours.

## Do not touch

- Anything outside Owns and Files.

## Read first

- The files in Owns, and nothing else until they are understood.

## Tier

standard. Multi-file coordination, ordinary care.

The archetype names the seat, and `routing.json` pins its model at install. The tier says how much judgement the brief expects, not which model runs: an expert seam is designed by the lead before it reaches you.

## Rules that bind this seam

1. Name the unknown before writing code. If this brief is wrong, say so in one message and stop; do not reinterpret it.
2. The smallest change that closes Out. No speculative flexibility.
3. Every changed line traces to Out. Orphans you created, you delete. Pre-existing dead code, you report.
4. Paste the command and its output in the report. A claim without a command is `Unverified`.
5. Never merge, never push a shared branch, never dispatch another agent. Two failures of the same command: stop and report.

## Continue (handoff, 2026-11-11)

The first employee stopped mid-seam: **nothing is committed**, the working tree holds its code and its new tests. Finish this list; do not rewrite what is green.

State read at handoff: `node --test packages/web-discord-rpc/test/extension/ui.test.mjs` = 21 passed, 1 failed.

1. **The one red UI test** — `ui.test.mjs:488` `options reports a site that is switched off instead of claiming it is idle` fails with `the flags are in the diagnostics block`. Cause: `options.js:160` builds diagnostics `sites` from `siteInputs[source].checked` (the stored preference) while the test mounts a status whose `sites` disagree with storage. The diagnostics must report the **effective** flags the worker reported (`status.sites`, i.e. the `sites` variable already read at `options.js:133`, treating only `false` as off), not the checkbox state. Keep the checkbox load path as it is. Re-run `ui.test.mjs` and confirm 22/22.
2. **Docs are red by design** (the tests pin them): `README.md:1` is still `# Discord RPC`; `docs/INSTALL.md:3` still says `Desktop-first install for Discord RPC`; `docs/ARCHITECTURE.md` and `docs/RESEARCH.md` carry the old string; `CHANGELOG.md:8` still narrates the old name. `test/docs.test.mjs` asserts the exact string `Discord RPC` appears **nowhere** in README, ARCHITECTURE, RESEARCH, INSTALL or CHANGELOG — so reword the historical 1.0.0 bullet too; it must not contain that string.
3. **README must gain** (per `docs.test.mjs:54-60`): `YouTube Music first`, `youtubeMusicEnabled`, `youtubeEnabled`, and `independent`; keep every existing pinned claim (desktop-first, `ipc` default, `deferred`, `client_id`, Vencord, `?v=1&client_id`, the mock user, types 3 and 2, name override, built-in id, 17-20 digit, `auto.*ipc.*arrpc`, privacy, all five reason strings).
4. **ARCHITECTURE** names `youtubeMusicEnabled` and the Music-first order.
5. **CHANGELOG** gets Unreleased entries for the YouTube Presence rename and the per-site toggles (both on by default, Music first, independent). If the 1.0.0 bullet still claims arRPC is used automatically when Discord is absent, correct it: the default is `ipc` and web is deferred.
6. Run the brief's check `node --test packages/web-discord-rpc/test` until it exits 0, paste the real tail in the report, then commit exactly the Files, then write the report.

## Report

Write `.stack/reports/youtube-presence-ui.md` with these five headings, all mandatory:

```text
## Outcome     what shipped, two or three sentences
## Evidence    the command and the real output at the head you hand back
## Unverified  every claim you did not check, and why; "none" is a claim
## Scope       paths touched, each inside Owns, or why not
## Lesson      one paragraph the next employee should know
```

Then return one paragraph: outcome, commits, check result, concerns.
