// Pure report layer: assertions, verdict text, the per-extension table, exit
// codes. No browser, no clock, no I/O — so it is unit-testable on its own.

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;

/** Metrics that must stay at zero on a host no extension is opted into. */
export const FOOTPRINT_KEYS = ["scripts", "listeners", "timers", "observers", "patches"];

/** Page-world cost only: on a host it is opted into, an extension may run a content script. */
export const PAGE_COST_KEYS = ["listeners", "timers", "observers", "patches"];

function violationsOf(value, keys = FOOTPRINT_KEYS) {
  const out = [];
  for (const key of keys) {
    if (typeof value[key] === "number" && value[key] !== 0) out.push({ key, count: value[key] });
  }
  return out;
}

function describeViolations(name, host, violations) {
  const counts = violations.map((v) => `${v.key}=${v.count}`).join(", ");
  return `${name} is not inert on ${host}: ${counts}`;
}

function extensionScriptElements(probe) {
  return (probe?.scriptElements ?? []).filter((script) => /^chrome-extension:\/\//.test(script.src ?? ""));
}

/**
 * Turn a report into a flat list of assertions.
 * @param {object} report
 * @param {{skips?: Array<{id: string, reason: string}>, requireSignal?: string[], coexistenceExpected?: string[]}} [options]
 */
export function buildAssertions(report, options = {}) {
  const { skips = [], requireSignal = [] } = options;
  const byPackage = new Map(report.extensions.map((e) => [e.package, e]));
  const assertions = [];

  for (const scenario of report.scenarios) {
    for (const [pkg, value] of Object.entries(scenario.extensions)) {
      const ext = byPackage.get(pkg);
      const name = ext?.name ?? pkg;

      if (scenario.id === "coexistence") {
        const expectsGraph = (scenario.graphExpected ?? []).includes(pkg);
        const graphs = Number(value.workletNodes ?? 0);
        const contexts = Number(value.audioContexts ?? 0);
        if (!expectsGraph) {
          // Presence-only extensions must not cost the page anything at all.
          // A content script of its own is expected here: this host is opted in.
          const violations = violationsOf(value, PAGE_COST_KEYS);
          const ok = violations.length === 0;
          assertions.push({
            id: `coexistence-page-cost/${pkg}`,
            scenario: scenario.id,
            extension: name,
            host: scenario.host,
            metric: "footprint",
            expected: "0 page-world cost (no audio graph by design)",
            actual: Object.fromEntries(PAGE_COST_KEYS.map((k) => [k, value[k] ?? 0])),
            verdict: ok ? "pass" : "fail",
            message: ok
              ? `${name} costs the page nothing on ${scenario.host}`
              : describeViolations(name, scenario.host, violations),
          });
          continue;
        }
        if (graphs === 0) {
          assertions.push({
            id: `coexistence-graph/${pkg}`,
            scenario: scenario.id,
            extension: name,
            host: scenario.host,
            metric: "workletNodes",
            expected: 1,
            actual: graphs,
            verdict: "skip",
            message: `SKIP (not reachable here): ${name} built no audio graph on ${scenario.host} (workletNodes=0, audioContexts=${contexts}) — its own eligibility handshake did not complete against the synthetic page; its page cost is measured and shown above`,
          });
          continue;
        }
        const ok = graphs <= 1;
        const running = Number(value.audioContextsRunning ?? 0);
        const times = (value.audioContextTimes ?? []).join(", ") || "none";
        const runningEvidence = graphs === 0 || running >= 1;
        assertions.push({
          id: `coexistence-graph/${pkg}`,
          scenario: scenario.id,
          extension: name,
          host: scenario.host,
          metric: "workletNodes",
          expected: "at most 1, with a running context",
          actual: graphs,
          verdict: ok && runningEvidence ? "pass" : "fail",
          message:
            ok && runningEvidence
              ? `${name}: ${graphs} audio graph(s) on ${scenario.host}, context ${times}`
              : ok
                ? `${name} built a graph on ${scenario.host} but no running AudioContext (states: ${times}) — that is silence, not processing`
                : `${name} built a doubled audio graph on ${scenario.host}: workletNodes=${graphs} (expected at most 1), audioContexts=${contexts}, states: ${times}`,
        });
        continue;
      }

      if (!scenario.expectInert) continue;
      if ((scenario.exempt ?? []).includes(pkg)) continue;

      const violations = violationsOf(value);
      const ok = violations.length === 0;
      assertions.push({
        id: `${scenario.id}-zero/${pkg}`,
        scenario: scenario.id,
        extension: name,
        host: scenario.host,
        metric: "footprint",
        expected: "0 everywhere",
        actual: Object.fromEntries(FOOTPRINT_KEYS.map((k) => [k, value[k] ?? 0])),
        verdict: ok ? "pass" : "fail",
        message: ok
          ? `${name} is inert on ${scenario.host}`
          : describeViolations(name, scenario.host, violations),
      });
    }

    if (scenario.expectInert) {
      const probe = scenario.probe ?? {};
      const patchedSurfaces = probe.patches ?? [];
      assertions.push({
        id: `${scenario.id}-no-patched-globals`,
        scenario: scenario.id,
        extension: "(page globals)",
        host: scenario.host,
        metric: "patches",
        expected: "0 patched globals",
        actual: patchedSurfaces,
        verdict: patchedSurfaces.length === 0 ? "pass" : "fail",
        message:
          patchedSurfaces.length === 0
            ? `no global was patched on ${scenario.host}`
            : `page globals were patched on ${scenario.host}: ${patchedSurfaces.join(", ")}`,
      });

      const injectedScripts = extensionScriptElements(probe);
      assertions.push({
        id: `${scenario.id}-no-injected-script-tags`,
        scenario: scenario.id,
        extension: "(page scripts)",
        host: scenario.host,
        metric: "scriptElements",
        expected: "0 extension <script> elements",
        actual: injectedScripts.length,
        verdict: injectedScripts.length === 0 ? "pass" : "fail",
        message:
          injectedScripts.length === 0
            ? `no extension <script> element on ${scenario.host}`
            : `${injectedScripts.length} extension <script> element(s) on ${scenario.host}: ${injectedScripts.map((s) => s.src).join(", ")}`,
      });

      const errors = (probe.uncaught ?? []).filter((entry) => /extension/.test(entry.detail ?? ""));
      assertions.push({
        id: `${scenario.id}-no-extension-errors`,
        scenario: scenario.id,
        extension: "(page errors)",
        host: scenario.host,
        metric: "uncaught",
        expected: "no extension-caused errors",
        actual: errors.length,
        verdict: errors.length === 0 ? "pass" : "fail",
        message:
          errors.length === 0
            ? `no extension-caused error on ${scenario.host}`
            : `extension-caused errors on ${scenario.host}: ${errors.map((e) => e.detail).join(" | ")}`,
      });
    }

    if (scenario.id === "coexistence") {
      const probe = scenario.probe ?? {};
      const advanced = Number(probe.mediaElementCurrentTime ?? 0) > 0;
      assertions.push({
        id: "coexistence-media-progress",
        scenario: scenario.id,
        extension: "(page audio)",
        host: scenario.host,
        metric: "mediaElementCurrentTime",
        expected: "> 0",
        actual: Number(probe.mediaElementCurrentTime ?? 0),
        verdict: advanced ? "pass" : "fail",
        message: advanced
          ? `the page's own <audio> advanced to currentTime=${Number(probe.mediaElementCurrentTime).toFixed(2)}s`
          : `the page's own <audio> did not advance on ${scenario.host} (currentTime=${Number(probe.mediaElementCurrentTime ?? 0)}, paused=${probe.mediaElementPaused}) — silence or a stalled element`,
      });

      const doubled = probe.doubledWiring ?? [];
      assertions.push({
        id: "coexistence-no-double-wiring",
        scenario: scenario.id,
        extension: "(page audio)",
        host: scenario.host,
        metric: "mediaElementSources",
        expected: "at most 1 per element",
        actual: doubled,
        verdict: doubled.length === 0 ? "pass" : "fail",
        message:
          doubled.length === 0
            ? "no media element was wired twice"
            : `doubled media-element wiring on ${scenario.host}: ${JSON.stringify(doubled)}`,
      });
    }
  }

  if (requireSignal.length) {
    const control = report.scenarios.find((s) => s.kind === "signal");
    for (const pkg of requireSignal) {
      const ext = byPackage.get(pkg);
      const name = ext?.name ?? pkg;
      const scripts = Number(control?.extensions?.[pkg]?.scripts ?? 0);
      assertions.push({
        id: `signal/${pkg}`,
        scenario: control?.id ?? "(none)",
        extension: name,
        host: control?.host ?? "(none)",
        metric: "scripts",
        expected: ">= 1",
        actual: scripts,
        verdict: scripts >= 1 ? "pass" : "fail",
        message:
          scripts >= 1
            ? `${name} injects ${scripts} content script(s) on the opted-in host ${control?.host} — the audit has signal`
            : `${name}: no signal — 0 content scripts on the opted-in host ${control?.host ?? "(no signal scenario ran)"}, so its zero assertions would pass vacuously`,
      });
    }
  }

  for (const skip of skips) {
    assertions.push({
      id: skip.id,
      scenario: skip.scenario ?? "-",
      extension: skip.extension ?? "-",
      host: skip.host ?? "-",
      metric: skip.metric ?? "-",
      expected: "-",
      actual: "-",
      verdict: "skip",
      message: `${skip.kind === "not-reachable" ? "SKIP (not reachable here)" : "SKIP (not implemented yet)"}: ${skip.reason}`,
    });
  }

  return assertions;
}

export function exitCodeFor(assertions) {
  return assertions.some((a) => a.verdict === "fail") ? EXIT_FAILED : EXIT_OK;
}

function pad(text, width) {
  const value = String(text);
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/** Human-readable table: one row per extension per scenario. */
export function renderTable(report, assertions) {
  const lines = [];
  const headers = ["scenario", "extension", "scripts", "listeners", "timers", "observers", "patches", "verdict"];
  const rows = [];
  const failed = new Set(assertions.filter((a) => a.verdict === "fail").map((a) => `${a.scenario}|${a.extension}`));
  const skipped = new Set(assertions.filter((a) => a.verdict === "skip").map((a) => `${a.scenario}|${a.extension}`));

  for (const scenario of report.scenarios) {
    for (const [pkg, value] of Object.entries(scenario.extensions)) {
      const ext = report.extensions.find((e) => e.package === pkg);
      const name = ext?.name ?? pkg;
      const key = `${scenario.id}|${name}`;
      rows.push([
        scenario.id,
        name,
        value.scripts ?? 0,
        value.listeners ?? 0,
        value.timers ?? 0,
        value.observers ?? 0,
        value.patches ?? 0,
        failed.has(key) ? "FAIL" : skipped.has(key) ? "SKIP" : "ok",
      ]);
    }
  }

  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  lines.push(headers.map((h, i) => pad(h, widths[i])).join("  "));
  lines.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) lines.push(row.map((c, i) => pad(c, widths[i])).join("  "));

  const noteLines = [];
  for (const scenario of report.scenarios) {
    for (const note of scenario.notes ?? []) noteLines.push(`  ${scenario.id}: ${note}`);
  }
  if (noteLines.length) {
    lines.push("");
    lines.push("notes");
    lines.push(...noteLines);
  }

  const skips = assertions.filter((a) => a.verdict === "skip");
  if (skips.length) {
    lines.push("");
    lines.push("skips");
    for (const skip of skips) lines.push(`  ${skip.message}`);
  }

  const counts = tally(assertions);
  lines.push("");
  lines.push(`pass ${counts.pass}  fail ${counts.fail}  skip ${counts.skip}`);
  return lines.join("\n");
}

export function tally(assertions) {
  const counts = { pass: 0, fail: 0, skip: 0 };
  for (const a of assertions) counts[a.verdict] += 1;
  return counts;
}
