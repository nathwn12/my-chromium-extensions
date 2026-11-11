# Seam presence-ui-design: minimal durable presence UI design

**Owner of this seam:** one `employee` employee. **Written by:** the lead. **State:** briefed.

## Why now

Owner narrowed the product to a single durable toggle and asked to suppress redundant metadata; design seam establishes exact states and renderable geometry.

## Out

Specify a renderable YouTube Presence UI design with exactly one on/off control, duplicate-value display rules, and all user-visible states with numeric geometry.

## Check

```text
node --test packages/web-discord-rpc/test/extension/ui.test.mjs
```

It passes only when the command exits 0 and the output shows the new behaviour.
A check that cannot go red is not a check.

## Owns

- `packages/web-discord-rpc/popup.html`
- `packages/web-discord-rpc/popup.css`
- `packages/web-discord-rpc/options.html`
- `packages/web-discord-rpc/options.css`

## Files (exact, exclusive)

- `packages/web-discord-rpc/popup.html`
- `packages/web-discord-rpc/popup.css`
- `packages/web-discord-rpc/options.html`
- `packages/web-discord-rpc/options.css`

No other seam may touch these. No other file is yours.

## Do not touch

- Anything outside Owns and Files.

## Read first

- `Q:/PROJECTS/PERSONAL/oc-collections/packages/oc-stacked/roles/ui-designer.md`
- `Q:/PROJECTS/PERSONAL/oc-collections/packages/oc-stacked/skills/stacked-employee/SKILL.md`

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

Write `.stack/reports/presence-ui-design.md` with these five headings, all mandatory:

```text
## Outcome     what shipped, two or three sentences
## Evidence    the command and the real output at the head you hand back
## Unverified  every claim you did not check, and why; "none" is a claim
## Scope       paths touched, each inside Owns, or why not
## Lesson      one paragraph the next employee should know
```

Then return one paragraph: outcome, commits, check result, concerns.
