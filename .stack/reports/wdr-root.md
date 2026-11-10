## Outcome

The root workspace now includes web-discord-rpc: the root `test` script runs its
workspace, the README tables and layouts it, CI has a `web-discord-rpc` job, and
the release zips it and attaches the fourth zip. The package `test` script runs
every test under `test/` via the shared `run-tests.mjs` runner instead of an
explicit four-file list, and `scripts/verify-integration.mjs` proves all eight
wiring points with a `--prove-red` mode that fails each check against a broken
fixture.

## Evidence

Brief check (exit 0):

```text
$ node scripts/verify-integration.mjs && node --test packages/web-discord-rpc/test/extension/config.test.mjs
PASS: workspaces cover packages/*
PASS: root test script runs the web-discord-rpc workspace
PASS: package test script runs every test under test/
PASS: package test/ holds at least one test file
PASS: README names the package with its version
PASS: CI defines a web-discord-rpc job that runs tests
PASS: release zips the package and attaches the zip
PASS: every file in the release zip step exists

verify-integration: 8/8 wiring points hold
# tests 10, pass 10, fail 0 (config.test.mjs, duration_ms 181)
```

Verifier goes red on broken fixtures (exit 0 means every check failed as required):

```text
$ node scripts/verify-integration.mjs --prove-red
prove-red: workspaces cover packages/* -> red as expected
prove-red: root test script runs the web-discord-rpc workspace -> red as expected
prove-red: package test script runs every test under test/ -> red as expected
prove-red: package test/ holds at least one test file -> red as expected
prove-red: README names the package with its version -> red as expected
prove-red: CI defines a web-discord-rpc job that runs tests -> red as expected
prove-red: release zips the package and attaches the zip -> red as expected
prove-red: every file in the release zip step exists -> red as expected
prove-red: 8/8 checks can go red
```

New package test entry, full suite (exit 0):

```text
$ npm test --workspace=web-discord-rpc
# tests 173, pass 173, fail 0, duration_ms 1344
```

Devops return:

```text
Stage:      ci job web-discord-rpc (`npm test` in packages/web-discord-rpc) run locally: 173 pass, 0 fail;
            release stage "Zip loadable extensions" file list zipped locally with bsdtar: 12 files, OK.
Artifact:   dist/web-discord-rpc.zip did not exist before; local smoke zip after: 24345 bytes,
            SHA256 B350B55156916B9395DB02341CAB48AC93CD2604C5D4C1E9A7710509FF8B958A
            (bsdtar bytes, not CI Info-ZIP bytes — identity is for the file list, not the hash).
Secrets:    workflows read only secrets.GITHUB_TOKEN, passed as env GH_TOKEN to `gh release create`;
            never echoed, no secret in logs or workflow files.
Reproducible: clean clone needs node 26 (.nvmrc), npm, Info-ZIP `zip` (present on ubuntu CI image,
            absent on this Windows machine — hence bsdtar for the local smoke), and `npm ci` from the root lockfile.
```

## Unverified

- The `web-discord-rpc` CI job never ran on GitHub Actions; only the identical
  commands ran locally on Windows (node v26.13.0). YAML was checked by eye, not
  a parser (no js-yaml/PyYAML on this machine).
- The exact release zip bytes CI will produce (Info-ZIP on ubuntu) were not
  reproduced; this machine has no `zip` binary.
- `scripts/release.mjs` support for web-discord-rpc (CHANGELOG, version bump)
  was not touched: the package has no CHANGELOG.md and release.mjs is outside
  this seam's Owns.

## Scope

Touched, all inside Owns:

- `package.json` (root test script gains the web-discord-rpc workspace)
- `README.md` (table row, dev command, four zips, layout line)
- `.github/workflows/ci.yml` (new web-discord-rpc job)
- `.github/workflows/release.yml` (wdr zip step plus release asset)
- `scripts/verify-integration.mjs` (new verifier with --prove-red)
- `packages/web-discord-rpc/package.json` (test runs every test under test/)

Not touched: `packages/web-discord-rpc/README.md` (untracked, another seam's),
popup/options UI files (do not exist yet), `.stack/*` (pre-existing lead edits).

## Lesson

A verifier that only passes cannot protect wiring: every predicate here has a
broken-fixture twin run by `--prove-red`, and two predicates first shipped
unable to go red (one read the real filesystem, one was satisfied by its own
red fixture). The `--prove-red` run caught both before CI ever saw them. Any
future wiring check should be born with its red case, not granted one later.
