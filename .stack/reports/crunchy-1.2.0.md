# Report: crunchy-1-2-0

## Outcome

Crunchy Presence is 1.2.0 in both `manifest.json` and `package.json`, and the arRPC bullet that sat under `## [Unreleased]` now sits under `## [1.2.0] - 2026-11-11` with a fresh empty `## [Unreleased]` above it. `README.md` and `docs/ARCHITECTURE.md` now name Discord IPC over the desktop pipe as the primary transport and arRPC as the optional web fallback for a browser Discord client, with no third transport; the README's embedded stack-internal `UNVERIFIED here: ... .stack/contracts.md` sentence was replaced by the plain dated claim it pointed at. No code, manifest key, or transport behaviour changed. Out of scope and reported to the lead: the root `README.md` version table still says `1.0.1` for this package (stale before this seam, owned by another) and `scripts/release.mjs` dates its changelog heading in UTC, not local time (pre-existing, not in Files).

## Evidence

**1. The bump is the minor the brief asks for** (repo tool tooling, preview only so it does not touch the dirty shared tree):

```text
$ node scripts/release.mjs crunchy-presence 1.2.0 --dry-run
release: note: tree is dirty, a real run would refuse; preview only
package: crunchy-presence
current: 1.1.0
next: 1.2.0
would write packages/crunchy-presence/manifest.json: "version": "1.1.0" -> "1.2.0"
would write packages/crunchy-presence/package.json: "version": "1.1.0" -> "1.2.0"
would update packages/crunchy-presence/CHANGELOG.md: promote ## [Unreleased] to ## [1.2.0] - 2026-11-10
run:
git add packages/crunchy-presence/manifest.json packages/crunchy-presence/package.json packages/crunchy-presence/CHANGELOG.md
git commit -m "crunchy-presence: release 1.2.0"
git tag v1.2.0
git push origin HEAD
git push origin v1.2.0
EXIT=0
```

A real run refuses on this tree because `.stack/*` and `packages/web-discord-rpc/**` carry other seams' uncommitted work, so the three version lines were written by hand exactly as the preview prints them.

**2. The check can go red — manifest bumped alone, before the changelog was promoted:**

```text
$ node --test packages/crunchy-presence/test/
  '1.2.0' !== '1.1.0'
      at TestContext.<anonymous> (file:///Q:/PROJECTS/PERSONAL/my-chromium-extensions/packages/crunchy-presence/test/extension/manifest.test.mjs:74:10)
  AssertionError [ERR_ASSERTION]: version equals newest released changelog heading
  actual: '1.2.0',
  expected: '1.1.0',
EXIT=1
```

`manifest.test.mjs:74` asserts `manifest.version === newestReleasedVersion(CHANGELOG)`, so the version pair is coupled to the changelog heading and cannot drift silently.

**3. The brief's check at the hand-back head `fd249f3`:**

```text
$ node --test packages/crunchy-presence/test/
✔ verifyHost fails when a registry default points somewhere else (4.9109ms)
ℹ tests 196
ℹ suites 0
ℹ pass 196
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 677.1526
EXIT_TESTS=0

$ node packages/crunchy-presence/native/host.mjs --selftest
ok: true checks: 17 all-ok: true
transport-auto-prefers-ipc => {"t":"status","state":"connected","transport":"discord-ipc","appName":"Discord","user":"selftest"}
transport-auto-falls-back-to-arrpc => {"t":"status","state":"connected","transport":"arrpc","appName":"Discord","user":"arrpc"}
transport-arrpc-never-falls-back => {"t":"status","state":"waiting","transport":"arrpc","reason":"arrpc-closed","detail":"arrpc is not listening on 127.0.0.1"}
transport-ipc-skips-arrpc => {"t":"status","state":"connected","transport":"discord-ipc","appName":"Discord","user":"selftest"}
transport-ipc-never-falls-back => {"t":"status","state":"waiting","transport":"discord-ipc","reason":"discord-closed","detail":"connect ENOENT \\\\.\\pipe\\discord-ipc-0"}
transport-auto-reports-the-primary-absence => {"t":"status","state":"waiting","transport":"discord-ipc","reason":"discord-closed","detail":"connect ENOENT \\\\.\\pipe\\discord-ipc-0"}
EXIT_SELFTEST=0
```

The selftest output is the "new behaviour" the brief asks for: `auto` connects over `discord-ipc`, falls back to `transport: "arrpc"` only when no pipe answers, and forced transports never cross over.

**4. The manifest key and derived ID survived the version edit (no `allowed_origins` drift):**

```text
$ node packages/crunchy-presence/scripts/extension-key.mjs --print
afghbfidjjlgnhaacaiiakmknffnmiom
key: MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAkBEsjck6wg0NeN69lz2i+d9K4KzEA7nvkvbIwlE1C7zkhycKSG9UyStn0WQPHJH76yvcEl28UORDEg/DLGJoCr/Ws7tRMOyl1BodD04MeNfUoJyGfHjvHTr9dCXdBbd3vxU63R4gAJ+jFbgqkq9zz42l0QumBdpS0xWym37kHIVva5GfQg9Zrs/DlnGfhLumPkg9OFEk+05LnHVS/KF8oqhRKoLgi/gmCa098Y8rFgXmMQMgzSTvWai7oxqlwoJzdZEnGEs7kcu3Nq5WononrhnvT6k0pm2ziAxQXpvR5u7Bg6PIjdVtWlKjPOS9YiqDO4DF1Bk2CBZALPxBi3og5QIDAQAB
EXIT=0
reused key in Q:\PROJECTS\PERSONAL\my-chromium-extensions\packages\crunchy-presence\manifest.json
```

**5. Commit and tree state:**

```text
$ git commit ...
[main fd249f3] crunchy-presence 1.2.0 ships the arRPC web fallback
 5 files changed, 15 insertions(+), 5 deletions(-)

$ git log --oneline -1
fd249f3 crunchy-presence 1.2.0 ships the arRPC web fallback

$ git status --porcelain -- packages/crunchy-presence
(empty)
```

## Unverified

- **The heading date.** I wrote `2026-11-11` (local today, per the environment clock `2026-11-11 05:24 +08:00`) because every prior entry in this CHANGELOG matches its release commit's local date — `1.1.0 - 2026-11-10` landed at `2026-11-10 06:11 +0800`. `scripts/release.mjs` computes `new Date().toISOString().slice(0,10)`, so the same run at this hour would have stamped `2026-11-10`. One of the two conventions is wrong for this repo; I did not change the script (not in Files). If the lead prefers the tool's output, the heading is a one-line edit.
- **Live behaviour.** No browser, Discord client or Vencord instance was exercised; the arRPC path is proven only by the in-process selftest and the unit suite. Nothing in this seam changed transport code, so no new live proof is claimed — the README's `Dated 2026-11-10` marker on the transport section remains accurate.
- **Repo-wide suite.** I ran the brief's Check only. `npm test` at the root would exercise `packages/web-discord-rpc/**`, which is mid-edit by another seam in this same tree, so a red there would not have been mine to read.
- **Root `README.md`.** Its table says `Crunchy Presence ... 1.0.1` — already stale at 1.1.0, now two minor versions stale. `scripts/verify-integration.mjs:164` only asserts the web-discord-rpc row's version, so nothing goes red; the fix is outside my Files.

## Scope

Five paths touched, each inside `Owns` and inside `Files (exact, exclusive)`:

| Path | Change |
| --- | --- |
| `packages/crunchy-presence/manifest.json` | `version` `1.1.0` → `1.2.0` |
| `packages/crunchy-presence/package.json` | `version` `1.1.0` → `1.2.0` |
| `packages/crunchy-presence/CHANGELOG.md` | inserted `## [1.2.0] - 2026-11-11` under an empty `## [Unreleased]`; bullet text unchanged |
| `packages/crunchy-presence/README.md` | intro, Discord requirement row, transport section: IPC primary, arRPC optional web fallback; removed the `.stack` placeholder sentence |
| `packages/crunchy-presence/docs/ARCHITECTURE.md` | one sentence under `## Framing` naming IPC primary and arRPC the optional web fallback |

Not touched: `packages/web-discord-rpc/**`, root `README.md`, `packages/audio-normalizer/**`, `packages/slowed-reverb/**`, `packages/crunchy-presence/native/**`, `background.js`, `scripts/**`. One commit: `fd249f3`. No merge, no push, no tag, no dispatch.

Read and deliberately set aside: this package's `AGENTS.md` says "A code change does not move a version, cut a dated heading, or edit `version`". That rule governs ordinary code changes; this seam's Out *is* the release act, and the lead's brief is the higher authority here. Flagging it so the next reader does not read the rule as violated.

## Lesson

The version and the changelog heading are one fact in two files, and `manifest.test.mjs:74` is the only thing holding them together — bump either alone and the suite goes red, which is why the red step is cheap and worth taking before the docs. Two things to know next time: `scripts/release.mjs` refuses on any dirty tree and this repo's stack work leaves the tree permanently dirty during a wave, so a release here is hand-written against the script's `--dry-run` output rather than run; and this package's README had a worker artifact (`UNVERIFIED here: ... recorded in .stack/contracts.md`) leaked into a shipping doc, so when a brief says "the docs say X", check whether the docs already say X in a shape the owner would accept instead of adding X a second time. Dates in this CHANGELOG follow local release-commit days, not the UTC day the release script would pick — settle that before the next release, because a heading is history and history should not be retro-fixed.
