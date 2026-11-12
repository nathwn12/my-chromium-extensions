# cost-audit — what the four extensions actually cost a page

Zero-dependency, network-free browser harness. It loads all four unpacked
extensions into one throwaway profile and measures what each one does to a page,
instead of asserting that it does nothing.

    node tools/cost-audit/run.mjs --json tools/cost-audit/last-report.json
    node tools/cost-audit/run.mjs --assert          # exit 1 on any violation
    node tools/cost-audit/run.mjs --silent-check    # prove every launch is muted
    node tools/cost-audit/run.mjs --package slowed-reverb   # one extension only
    node --test tools/cost-audit/test/              # unit tests, no browser

Exit codes: `0` clean (skips are allowed, and printed), `1` an assertion failed
(only with `--assert`), `2` the harness could not run at all — no browser, no
extension, CDP failure.

## Silence is not optional

Every launch carries `--headless=new --mute-audio
--autoplay-policy=no-user-gesture-required`. `--mute-audio` is present in the
headed path too: if headless cannot load the unpacked extensions, the fallback
is a **visible but muted** window, recorded as a limitation in the report.
`buildArgs` has no branch that omits it, `silentArgvProblems` refuses to launch
an argv that could be audible, and `--silent-check` asserts both argv forms so
this cannot regress. No assertion here reads a sound device: audio is judged
from instrumented node graphs, `AudioContext.state` and `currentTime`.

## Scenarios and what each one asserts

| scenario | host | assertion |
|---|---|---|
| `control` | `http://127.0.0.1:<port>/control` | every extension: 0 content script executions, 0 page listeners, 0 timers, 0 observers, 0 patched globals, 0 injected `<script>` elements, 0 extension-caused errors |
| `enabled` | same host, `site:127.0.0.1` written with `enabled:true` | the **positive control**: the extension must inject here, or every zero above is vacuous and `--assert` fails with `no signal` |
| `control-excluded` | same host, `enabled:true, excluded:true` | the exclusion outranks enablement: back to all zeros |
| `excluded-subdomain` | `http://sub.excluded.test:<port>` with `site:excluded.test` excluded | the contract rule: an excluded key covers its subdomains |
| `coexistence` | `https://music.youtube.com/watch`, all three opt-in extensions seeded active | at most one audio graph per extension, at least one `running` AudioContext when there is a graph, no element wired twice, and the page's own `<audio>` still advances |
| `registration` | audio-normalizer service worker | `chrome.scripting.getRegisteredContentScripts()`: the excluded host is in some `excludeMatches` and in no `matches` |

"Content script executions" is counted at the source: CDP
`Runtime.executionContextCreated` events whose origin is
`chrome-extension://<id>` and whose `auxData.type` is `isolated`. Page-world
cost — listeners, timers, observers, patched globals, audio graphs — is counted
by an instrument installed with `Page.addScriptToEvaluateOnNewDocument`, which
runs before every page script and before every content script. Each registration
records a stack frame, so counts are attributed per extension.

## Environment facts this harness depends on

- **Browser:** probed in order Brave → Chrome → Edge under `Program Files`.
  This machine has Chrome `157.0.8103.51`; Brave is absent.
- **Loading route:** Chrome 157 **silently ignores `--load-extension`** (probed:
  no unpacked extension appears in `Target.getTargets`, and
  `--disable-features=DisableLoadExtensionCommandLineSwitch` does not restore
  it). The harness loads through the CDP `Extensions.loadUnpacked` command and
  reads the assigned ids back from `Extensions.getExtensions`.
- **Host-pinned extensions:** `slowed-reverb` and `web-discord-rpc` match
  `https://music.youtube.com/*`, so their real origin cannot be exercised from
  `127.0.0.1`. The harness mints a throwaway self-signed cert (openssl, into a
  temp dir that is deleted), serves the same fixture page over https and maps
  the host with `--host-resolver-rules`. Nothing external is contacted; the cert
  is trusted only because the browser was launched for this throwaway profile.
  If openssl is missing, the coexistence scenario is skipped loudly.
- **Profile:** `C:\Users\nathan\AppData\Local\Temp\opencode\cx\profile-*`,
  created per run and deleted, with the cert directory beside it. The owner's
  browser profile is never opened. Any browser process still holding that
  profile path is killed by path, and the PIDs are recorded in the report.

## Skips

A skip is printed as a loud line with its reason and is never counted as a pass:

- `SKIP (not implemented yet): …` — the package's own source does not contain
  the contract feature yet (e.g. no `registerContentScripts`, no `excluded`
  field). The harness reads the package to tell "not built yet" from "built
  wrong"; the second one fails.
- `SKIP (not reachable here): …` — the extension is present but cannot engage
  against a synthetic page (its own eligibility handshake never completes). Its
  page cost is still measured and shown.

## What it cannot prove

- Nothing about sound reaching a device: the browser is muted, and no assertion
  reads audible output. Processing is inferred from graph shape, `AudioContext`
  state and `currentTime`.
- Isolated-world listener/timer/observer registrations are invisible to
  page-world instrumentation — an isolated world has its own
  `EventTarget.prototype`. Those are counted as isolated worlds instead.
- The fixture pages carry no site code, so this measures presence and graph
  shape, not the fidelity of any site's playback.
- Patch detection compares function source text against a document-start
  baseline; a patch that restored identical text would evade it.
- `getRegisteredContentScripts` proves the *registration* layer only. The
  backstop gate in the content script is proved by the `control-excluded` row,
  and the main-world refusal is proved by `patches` staying empty there.
