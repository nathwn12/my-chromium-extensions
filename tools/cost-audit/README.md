# cost-audit — what the four extensions actually cost a page

Zero-dependency, network-free browser harness. It loads all four unpacked
extensions into one throwaway profile and measures what each one does to a page,
instead of asserting that it does nothing.

    node tools/cost-audit/run.mjs --json tools/cost-audit/last-report.json
    node tools/cost-audit/run.mjs --assert          # exit 1 on any violation
    node tools/cost-audit/run.mjs --silent-check    # prove every launch is muted
    node tools/cost-audit/run.mjs --package slowed-reverb   # one extension only
    node --test tools/cost-audit/test/              # unit tests, no browser

Exit codes: `0` clean (limits are printed, never counted as passes), `1` an
assertion failed (only with `--assert`), `2` the harness could not run — no
browser, no extension, CDP failure, or a scenario that produced no assertion.

## Verdicts

| verdict | meaning |
|---|---|
| `pass` | measured and true |
| `fail` | measured and false, **or the precondition was empty** — printed as `FAIL (vacuous: …)` |
| `limit` | the environment cannot reach the question; printed as `LIMIT: …` with the probe used |

A vacuous assertion is a failure, never a pass and never a limit: a zero that was
satisfied by an empty registration, or by an extension that never ran, proves
nothing and says so. The harness also refuses to finish if any scenario produced
no assertion at all — silence is a bug, not a pass.

## Silence is not optional

Every launch carries `--headless=new --mute-audio
--autoplay-policy=no-user-gesture-required`. `--mute-audio` is present in the
headed path too: if headless cannot load the unpacked extensions, the fallback is
a **visible but muted** window, recorded as a limitation in the report.
`buildArgs` has no branch that omits it, `silentArgvProblems` refuses to spawn an
argv that could be audible, and `--silent-check` asserts both argv forms. No
assertion reads a sound device: audio is judged from instrumented node graphs,
`AudioContext.state` and `currentTime`.

## Scenarios

| scenario | host | what is asserted |
|---|---|---|
| `control` | `127.0.0.1` | every extension: 0 content-script executions, 0 page listeners, 0 timers, 0 observers, 0 patched globals, 0 injected `<script>` elements, 0 extension-caused errors |
| `enabled` | `excluded.test` | **positive control**: audio-normalizer must inject here, or every zero in the report is vacuous |
| `subdomain-enabled` | `sub.excluded.test` | the same, for the host that will later be excluded through its parent key |
| `A-excluded` | `excluded.test` | record `{enabled:true, excluded:true}`: back to all zeros |
| `S-excluded-by-parent` | `sub.excluded.test` | still `enabled:true`, but its parent key is excluded: all zeros |
| `A-restored` | `excluded.test` | `excluded:false`: injection returns |
| `B-never-configured` | `never-configured.test` | never seeded: no injection and no mention in any registration |
| `coexistence` | `https://music.youtube.com/watch` | one audio graph per engine, a `running` AudioContext when there is a graph, no element wired twice, the page's own `<audio>` still advances |

"Content-script executions" is counted at the source: CDP
`Runtime.executionContextCreated` events whose origin is
`chrome-extension://<id>` and whose `auxData.type` is `isolated`. Page-world
cost — listeners, timers, observers, patched globals, audio graphs — comes from
an instrument installed with `Page.addScriptToEvaluateOnNewDocument`, which runs
before every page script and every content script. Each registration records a
stack frame, so counts are attributed per extension.

## The registration proof

One sequence, one host, registration snapshots between the storage writes, so the
before/after is causal and never satisfied by an empty array. Three hosts are kept
in play: `A` (the key that gets excluded), `S` (its subdomain), `B` (never
configured), plus one unrelated opted-in host so a registration stays alive while
`A` is excluded.

| phase | storage | `matches` | `excludeMatches` | scripts on A |
|---|---|---|---|---|
| A-enabled | A, S, other enabled | A, S, other | — | 1 |
| A-excluded | A excluded, rest enabled | other only | `*://*.excluded.test/*` | 0 |
| A-restored | A un-excluded | A, S, other | — | 1 |
| B-never-configured | B never seeded | A, S, other | — | 0 on B |
| nothing-enabled | all disabled | — (0 entries) | — | — |

Assertions built from it: the excluded host must be absent from every `matches`
and present in some `excludeMatches`; the never-configured host must appear in no
registration at all while another host *is* registered; with nothing enabled the
extension must leave no registration behind. Any of these that would be satisfied
by an empty registration is reported as `FAIL (vacuous: …)` with the source grep
that proves the code exists.

The report prints the actual arrays for every phase, not just a verdict.

## Environment facts this harness depends on

- **Browser:** probed in order Brave → Chrome → Edge under `Program Files`.
  This machine has Chrome `157.0.8103.51`; Brave is absent.
- **Loading route:** Chrome 157 **silently ignores `--load-extension`** (probed:
  no unpacked extension appears in `Target.getTargets`, and
  `--disable-features=DisableLoadExtensionCommandLineSwitch` does not restore
  it). The harness loads through CDP `Extensions.loadUnpacked` and reads the
  assigned ids back from `Extensions.getExtensions`.
- **Host-pinned extensions:** `slowed-reverb` and `web-discord-rpc` match
  `https://music.youtube.com/*`, so their real origin cannot be exercised from
  `127.0.0.1`. The harness mints a throwaway self-signed cert (openssl, into a
  temp dir that is deleted), serves the same fixture over https and maps the host
  with `--host-resolver-rules`. Nothing external is contacted. If openssl is
  missing, the coexistence scenario becomes a printed limit.
- **Profile:** `C:\Users\nathan\AppData\Local\Temp\opencode\cx\profile-*`,
  created per run and deleted, with the cert directory beside it. The owner's
  browser profile is never opened. Any browser process still holding that profile
  path is killed by path and the PIDs are recorded in the report.

## Limits, and what it cannot prove

- `LIMIT` lines carry a reason and, for a silent extension, the probe that was
  used — e.g. Slowed Reverb's own isolated-world state (`hookReady`,
  `hookToken`, media count, `captureStream`) plus the page-world markers.
- A package whose manifest cannot match a host never ran there, so its zero on
  that host is a `LIMIT`, not a pass (`crunchy-presence` against any local host).
- Nothing about sound reaching a device: the browser is muted, and no assertion
  reads audible output.
- Isolated-world listener/timer/observer registrations are invisible to
  page-world instrumentation — an isolated world has its own
  `EventTarget.prototype`. They are counted as isolated worlds instead.
- The fixture pages carry no site code, so this measures presence and graph
  shape, not the fidelity of any site's playback.
- Patch detection compares function source text against a document-start
  baseline; a patch that restored identical text would evade it.
