# Seam verify-scans-tracked-source: the Playwright guard scans tracked source without silent skips

**Owner of this seam:** one `employee` employee. **Written by:** the lead. **State:** briefed.

## Why now

The independent audit found the walker swallows readdir/stat failures and scans only .js/.ts while the claim says every source path, so the no-Playwright guard is narrower than advertised.

## Out

The Playwright guard walks the tree with no silent failure paths, scans every text-like file (not just .js/.ts), keeps named exclusions for .git, node_modules and .stack state, and fails by name when a file or directory cannot be read; --prove-red plants a specifier in a file type the old walker missed.

## Check

```text
node scripts/verify-integration.mjs && node scripts/verify-integration.mjs --prove-red
```

It passes only when the command exits 0 and the output shows the new behaviour.
A check that cannot go red is not a check.

## Owns

- `scripts/verify-integration.mjs`

## Files (exact, exclusive)

- `scripts/verify-integration.mjs`

No other seam may touch these. No other file is yours.

## Do not touch

- `packages/**`
- `README.md`
- `.github/**`
- `package.json`
- `package-lock.json`

## Read first

- `scripts/verify-integration.mjs`
- `.stack/goal.md`

## Tier

standard. Multi-file coordination, ordinary care.

The archetype names the seat, and `routing.json` pins its model at install. The tier says how much judgement the brief expects, not which model runs: an expert seam is designed by the lead before it reaches you.

## Rules that bind this seam

1. Name the unknown before writing code. If this brief is wrong, say so in one message and stop; do not reinterpret it.
2. The smallest change that closes Out. No speculative flexibility.
3. Every changed line traces to Out. Orphans you created, you delete. Pre-existing dead code, you report.
4. Paste the command and its output in the report. A claim without a command is `Unverified`.
5. Never merge, never push a shared branch, never dispatch another agent. Two failures of the same command: stop and report.

## Report

Write `.stack/reports/verify-scans-tracked-source.md` with these five headings, all mandatory:

```text
## Outcome     what shipped, two or three sentences
## Evidence    the command and the real output at the head you hand back
## Unverified  every claim you did not check, and why; "none" is a claim
## Scope       paths touched, each inside Owns, or why not
## Lesson      one paragraph the next employee should know
```

Then return one paragraph: outcome, commits, check result, concerns.

## Known gap (from the independent audit)

In scripts/verify-integration.mjs, walk() catches eaddirSync and returns silently, and catches statSync and continues silently, so an unreadable directory is a pass. collectPlaywrightSurface() scans only SOURCE_FILE = /\.(?:c|m)?js$|\.(?:c|m)?ts$/ plus .github/workflows/, so an import in .html, .jsx, .vue or another text file is invisible. The exclusions 
ode_modules, .git and .stack are sensible but must be named constants with a comment saying why each is not source.

Required shape: no silent catch anywhere in the walk (a failure throws and fails the check by path); scan every file except a named binary/asset deny list (png, ico, jpg, jpeg, gif, webp, woff, woff2, ttf, zip, pdf) and the named exclusions; keep the manifests and workflows data the other predicates rely on. --prove-red must add a fixture in a file type the old walker missed (e.g. an .html with a quoted specifier), watch the guard fail by name, then leave the tree as it found it. Keep spelling the banned name in pieces so the guard passes its own scan, and keep the script dependency-free and runnable with no 
pm install.