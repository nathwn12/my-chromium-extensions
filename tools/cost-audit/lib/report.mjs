// Pure report layer: assertions, verdict text, the per-extension table, exit
// codes. No browser, no clock, no I/O — so it is unit-testable on its own.
//
// Three verdicts:
//   pass   - measured and true
//   fail   - measured and false, OR a precondition was empty (vacuous)
//   limit  - the environment cannot reach the question; carries the probe used
// A vacuous assertion is a failure, never a pass and never a limit: a zero that
// was satisfied by an empty registration or by an extension that never injected
// proves nothing, and must say so.

import { patternsCoverHost } from "./source.mjs";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;

/** Metrics that must stay at zero on a host no extension is opted into. */
export const FOOTPRINT_KEYS = ["scripts", "listenerRegistrations", "timers", "observers", "patches"];

/** Page-world cost only: on a host it is opted into, an extension may run a content script. */
export const PAGE_COST_KEYS = ["listenerRegistrations", "timers", "observers", "patches"];

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

/** `source grep "token": file:line (+n more)` — or the count of files searched. */
export function grepEvidence(source) {
  if (!source) return "no source grep was run";
  const files = source.filesScanned ?? 0;
  const matches = source.matches ?? [];
  if (!matches.length) {
    return `source grep "${source.token}": 0 matches in ${files} file(s)`;
  }
  const head = matches[0];
  const more = matches.length > 1 ? ` (+${matches.length - 1} more)` : "";
  return `source grep "${source.token}": ${head.file}:${head.line}${more}`;
}

function vacuous(base, why) {
  return {
    ...base,
    expected: base.expected ?? "measured",
    actual: base.actual ?? "precondition empty",
    verdict: "fail",
    vacuous: true,
    message: `FAIL (vacuous: ${why})`,
  };
}

function limit(base, why) {
  return {
    ...base,
    expected: base.expected ?? "measured",
    actual: base.actual ?? "not reachable",
    verdict: "limit",
    message: `LIMIT: ${why}`,
  };
}

/** Packages that demonstrably injected somewhere in this run. */
function signalMap(report) {
  const map = new Map();
  for (const signal of report.signals ?? []) {
    map.set(signal.package, Math.max(map.get(signal.package) ?? 0, Number(signal.scripts) || 0));
  }
  return map;
}

/**
 * Registration assertions, built from snapshot phases taken between storage
 * writes. The sequence is causal on one host: enabled -> excluded -> restored,
 * with a second host that was never configured as the negative control.
 */
export function registrationAssertions(report) {
  const registration = report.registration;
  if (!registration?.phases?.length) return [];
  const out = [];
  const evidence = grepEvidence(registration.source);
  const registeredEntries = (phase) => phase.registered ?? [];
  const anythingRegistered = () => registration.phases.some((phase) => registeredEntries(phase).length > 0);
  const base = (phase, extra) => ({
    scenario: `registration:${phase.id}`,
    extension: registration.name ?? registration.package,
    host: phase.host,
    ...extra,
  });

  for (const phase of registration.phases) {
    const entries = registeredEntries(phase);
    const arrays = { registered: entries };

    if (phase.expect === "covers-host") {
      const covered = entries.some((entry) => patternsCoverHost(entry.matches, phase.host));
      const id = `registration-covers/${phase.id}`;
      const common = base(phase, { id, metric: "matches", expected: `${phase.host} covered by matches`, actual: arrays });
      if (!entries.length) {
        out.push(
          vacuous(
            common,
            `${phase.id}: getRegisteredContentScripts() returned 0 entries while ${phase.host} ran ${phase.scripts} content script(s); ${evidence}`,
          ),
        );
        continue;
      }
      out.push({
        ...common,
        verdict: covered ? "pass" : "fail",
        message: covered
          ? `${phase.host} is registered in matches, and injects ${phase.scripts} content script(s)`
          : `${phase.host} injects ${phase.scripts} content script(s) but is in no registered matches: ${JSON.stringify(entries.map((e) => e.matches))}`,
      });
      continue;
    }

    if (phase.expect === "host-excluded") {
      const inMatches = entries.some((entry) => patternsCoverHost(entry.matches, phase.host));
      const inExclude = entries.some((entry) => (entry.excludeMatches ?? []).some((pattern) => patternsCoverHost([pattern], phase.host)));
      const ids = {
        notInMatches: base(phase, {
          id: `registration-not-in-matches/${phase.id}`,
          metric: "matches",
          expected: `${phase.host} absent from every matches`,
          actual: arrays,
        }),
        inExclude: base(phase, {
          id: `registration-in-exclude/${phase.id}`,
          metric: "excludeMatches",
          expected: `${phase.host} in some excludeMatches, or the registration torn down entirely`,
          actual: arrays,
        }),
      };
      if (!entries.length) {
        // An extension may answer exclusion by registering nothing at all. That
        // is stronger than an excludeMatches entry, but it is only evidence if
        // an earlier phase in the same run saw a registration and this phase saw
        // no injection.
        const provenEarlier = registration.phases.some(
          (other) =>
            other !== phase &&
            other.expect === "covers-host" &&
            (other.registered ?? []).some((entry) => patternsCoverHost(entry.matches, other.host)),
        );
        if (provenEarlier && phase.scripts === 0) {
          out.push({
            ...ids.notInMatches,
            verdict: "pass",
            message: `${phase.host} is in no matches: while it is excluded the extension holds no registration at all (0 entries) and injects nothing`,
          });
          out.push({
            ...ids.inExclude,
            verdict: "pass",
            message: `no excludeMatches is needed for ${phase.host}: the registration is torn down entirely (0 entries) while it is excluded, which excludes it harder than a pattern would`,
          });
          continue;
        }
        out.push(
          vacuous(
            ids.notInMatches,
            `${phase.id}: getRegisteredContentScripts() returned 0 entries, so "absent from matches" is unfalsifiable; ${evidence}`,
          ),
        );
        out.push(
          vacuous(
            ids.inExclude,
            `${phase.id}: getRegisteredContentScripts() returned 0 entries, so there is no excludeMatches to inspect; ${evidence}`,
          ),
        );
        continue;
      }
      out.push({
        ...ids.notInMatches,
        verdict: inMatches ? "fail" : "pass",
        message: inMatches
          ? `${phase.host} is still covered by a registered matches list after exclusion: ${JSON.stringify(entries.map((e) => e.matches))}`
          : `${phase.host} is absent from every registered matches list`,
      });
      out.push({
        ...ids.inExclude,
        verdict: inExclude ? "pass" : "fail",
        message: inExclude
          ? `${phase.host} is registered in excludeMatches`
          : `${phase.host} is in no registered excludeMatches: ${JSON.stringify(entries.map((e) => e.excludeMatches ?? []))}`,
      });
      continue;
    }

    if (phase.expect === "host-unknown") {
      const mentioned = entries.some(
        (entry) =>
          patternsCoverHost(entry.matches, phase.host) ||
          (entry.excludeMatches ?? []).some((pattern) => patternsCoverHost([pattern], phase.host)),
      );
      const id = `registration-negative/${phase.id}`;
      const common = base(phase, {
        id,
        metric: "matches+excludeMatches",
        expected: `${phase.host} in no registration at all`,
        actual: arrays,
      });
      if (!anythingRegistered()) {
        out.push(
          vacuous(
            common,
            `${phase.id}: no phase in this run ever saw a registered script, so "never configured host is not registered" is unfalsifiable; ${evidence}`,
          ),
        );
        continue;
      }
      out.push({
        ...common,
        verdict: mentioned || phase.scripts !== 0 ? "fail" : "pass",
        message:
          mentioned || phase.scripts !== 0
            ? `${phase.host} was never configured but appears in a registration (scripts=${phase.scripts}): ${JSON.stringify(entries.map((e) => ({ matches: e.matches, excludeMatches: e.excludeMatches ?? [] })))}`
            : `${phase.host} was never configured: no registration mentions it and it injects nothing (while other hosts are registered)`,
      });
      continue;
    }

    if (phase.expect === "no-registration") {
      const id = `registration-empty/${phase.id}`;
      const common = base(phase, {
        id,
        metric: "getRegisteredContentScripts",
        expected: "0 entries when nothing is enabled",
        actual: arrays,
      });
      if (!anythingRegistered()) {
        out.push(
          vacuous(
            common,
            `${phase.id}: registration never appeared in this run, so "it is torn down" cannot be distinguished from "it never existed"; ${evidence}`,
          ),
        );
        continue;
      }
      out.push({
        ...common,
        verdict: entries.length === 0 ? "pass" : "fail",
        message:
          entries.length === 0
            ? `with no host enabled the extension leaves no registration behind (0 entries), so no page can be reached by it`
            : `with no host enabled the extension still holds ${entries.length} registration(s): ${JSON.stringify(entries.map((e) => e.matches))}`,
      });
    }
  }

  return out;
}

/**
 * Turn a report into a flat list of assertions.
 * @param {object} report
 * @param {{limits?: Array<{id: string, scenario: string, extension?: string, host?: string, reason: string}>}} [options]
 */
export function buildAssertions(report, options = {}) {
  const { limits = [] } = options;
  const byPackage = new Map(report.extensions.map((e) => [e.package, e]));
  const signals = signalMap(report);
  const assertions = [];

  for (const scenario of report.scenarios) {
    for (const [pkg, value] of Object.entries(scenario.extensions)) {
      const ext = byPackage.get(pkg);
      const name = ext?.name ?? pkg;

      if (scenario.kind === "seen-off") {
        // A host the user has enabled before, currently off: the content script
        // must be there (registration matches `seen || enabled`, and that is what
        // makes a later enable live) while the page pays NOTHING — no listener,
        // no timer, no observer, no patched global, no audio graph. "Excluded is
        // zero" is asserted separately and is unchanged.
        const scripts = Number(value.scripts ?? 0);
        const violations = violationsOf(value, PAGE_COST_KEYS);
        const graphs = Number(value.workletNodes ?? 0);
        const contexts = Number(value.audioContexts ?? 0);
        const ok = scripts >= 1 && violations.length === 0 && graphs === 0 && contexts === 0;
        assertions.push({
          id: `seen-off/${pkg}`,
          scenario: scenario.id,
          extension: name,
          host: scenario.host,
          metric: "footprint",
          expected: ">= 1 content script, 0 page-world cost, 0 audio graphs",
          actual: { scripts, workletNodes: graphs, audioContexts: contexts, ...Object.fromEntries(PAGE_COST_KEYS.map((k) => [k, value[k] ?? 0])) },
          verdict: ok ? "pass" : "fail",
          message: ok
            ? `${name} runs ${scripts} content script(s) on the seen-but-off ${scenario.host} with no page cost and no audio graph`
            : (scripts < 1
              ? `${name} has no content script on ${scenario.host}, which was seen earlier and is off — a later enable could not be live`
              : `${name} costs the seen-but-off ${scenario.host}: ${describeViolations(name, scenario.host, violations)}${graphs || contexts ? `, workletNodes=${graphs}, audioContexts=${contexts}` : ""}`),
        });
        continue;
      }

      if (scenario.kind === "coexistence") {
        const expectsGraph = (scenario.graphExpected ?? []).includes(pkg);
        const graphs = Number(value.workletNodes ?? 0);
        const contexts = Number(value.audioContexts ?? 0);

        if (!expectsGraph) {
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

        const running = Number(value.audioContextsRunning ?? 0);
        const times = (value.audioContextTimes ?? []).join(", ") || "none";
        const base = {
          id: `coexistence-graph/${pkg}`,
          scenario: scenario.id,
          extension: name,
          host: scenario.host,
          metric: "workletNodes",
          expected: "at most 1, with a running context",
          actual: graphs,
        };
        if (graphs === 0) {
          assertions.push(
            limit(
              base,
              `${name} built no audio graph on ${scenario.host} (workletNodes=0, audioContexts=${contexts}); probe: ${scenario.extensionProbes?.[pkg] ?? "none"} — its page cost is measured and shown above`,
            ),
          );
          continue;
        }
        if (graphs > 1) {
          assertions.push({
            ...base,
            verdict: "fail",
            message: `${name} built a doubled audio graph on ${scenario.host}: workletNodes=${graphs} (expected at most 1), audioContexts=${contexts}, states: ${times}`,
          });
          continue;
        }
        assertions.push({
          ...base,
          verdict: running >= 1 ? "pass" : "fail",
          message:
            running >= 1
              ? `${name}: ${graphs} audio graph(s) on ${scenario.host}, context ${times}`
              : `${name} built a graph on ${scenario.host} but no running AudioContext (states: ${times}) — that is silence, not processing`,
        });
        continue;
      }

      if (!scenario.expectInert) continue;

      const violations = violationsOf(value);
      const base = {
        id: `${scenario.id}-zero/${pkg}`,
        scenario: scenario.id,
        extension: name,
        host: scenario.host,
        metric: "footprint",
        expected: "0 everywhere",
        actual: Object.fromEntries(FOOTPRINT_KEYS.map((k) => [k, value[k] ?? 0])),
      };
      // A zero is only evidence when this extension was seen injecting somewhere
      // in the run. Without a signal the zero is either unfalsifiable (it could
      // have run here) or unreachable (its manifest never matches this host).
      if ((signals.get(pkg) ?? 0) === 0) {
        const reach = report.reach?.[pkg];
        const reachable = reach?.patterns?.length ? patternsCoverHost(reach.patterns, scenario.host) : false;
        if (!reachable) {
          assertions.push(
            limit(
              base,
              `${name} never ran in this run and its manifest (${JSON.stringify(reach?.patterns ?? [])}) cannot match ${scenario.host}, so its zero there is untested — not a pass`,
            ),
          );
        } else {
          assertions.push(
            vacuous(
              base,
              `${name} injected nothing anywhere in this run although its manifest matches ${scenario.host}, so "${scenario.id} is inert on ${scenario.host}" cannot be distinguished from "the extension never ran"`,
            ),
          );
        }
        continue;
      }
      const ok = violations.length === 0;
      assertions.push({
        ...base,
        verdict: ok ? "pass" : "fail",
        message: ok ? `${name} is inert on ${scenario.host}` : describeViolations(name, scenario.host, violations),
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

    if (scenario.kind === "coexistence") {
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

  for (const scenario of report.scenarios) {
    if (scenario.kind !== "signal") continue;
    const injected = Object.entries(scenario.extensions).filter(([, value]) => (value.scripts ?? 0) > 0);
    for (const [pkg, value] of injected) {
      const ext = byPackage.get(pkg);
      assertions.push({
        id: `signal/${scenario.id}/${pkg}`,
        scenario: scenario.id,
        extension: ext?.name ?? pkg,
        host: scenario.host,
        metric: "scripts",
        expected: ">= 1",
        actual: value.scripts,
        verdict: "pass",
        message: `${ext?.name ?? pkg} injects ${value.scripts} content script(s) on ${scenario.host} — this is what makes the zeros elsewhere evidence`,
      });
    }
    if (scenario.expectInject && !injected.some(([pkg]) => pkg === scenario.expectInject)) {
      const ext = byPackage.get(scenario.expectInject);
      assertions.push({
        id: `signal/${scenario.id}/${scenario.expectInject}`,
        scenario: scenario.id,
        extension: ext?.name ?? scenario.expectInject,
        host: scenario.host,
        metric: "scripts",
        expected: ">= 1",
        actual: 0,
        verdict: "fail",
        message: `${ext?.name ?? scenario.expectInject}: no signal — 0 content scripts on ${scenario.host}, which was opted in, so no zero in this report is evidence`,
      });
    }
  }

  assertions.push(...registrationAssertions(report));

  for (const entry of limits) {
    assertions.push(
      limit(
        {
          id: entry.id,
          scenario: entry.scenario,
          extension: entry.extension ?? "-",
          host: entry.host ?? "-",
          metric: entry.metric ?? "-",
        },
        entry.reason,
      ),
    );
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
  const headers = ["scenario", "extension", "scripts", "listenerRegistrations", "timers", "observers", "patches", "verdict"];
  const rows = [];
  const failed = new Set(assertions.filter((a) => a.verdict === "fail").map((a) => `${a.scenario}|${a.extension}`));
  const limited = new Set(assertions.filter((a) => a.verdict === "limit").map((a) => `${a.scenario}|${a.extension}`));

  for (const scenario of report.scenarios) {
    for (const [pkg, value] of Object.entries(scenario.extensions)) {
      const ext = report.extensions.find((e) => e.package === pkg);
      const name = ext?.name ?? pkg;
      const key = `${scenario.id}|${name}`;
      rows.push([
        scenario.id,
        name,
        value.scripts ?? 0,
        value.listenerRegistrations ?? 0,
        value.timers ?? 0,
        value.observers ?? 0,
        value.patches ?? 0,
        failed.has(key) ? "FAIL" : limited.has(key) ? "LIMIT" : "ok",
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

  const registration = report.registration;
  if (registration?.phases?.length) {
    lines.push("");
    lines.push(`registration: ${registration.name ?? registration.package} (${grepEvidence(registration.source)})`);
    for (const phase of registration.phases) {
      const entries = phase.registered ?? [];
      lines.push(
        `  ${pad(phase.id, 26)} host=${pad(phase.host, 22)} scripts=${phase.scripts} entries=${entries.length} matches=${JSON.stringify(entries.flatMap((e) => e.matches ?? []))} excludeMatches=${JSON.stringify(entries.flatMap((e) => e.excludeMatches ?? []))}`,
      );
    }
  }

  const vacuousOnes = assertions.filter((a) => a.vacuous);
  if (vacuousOnes.length) {
    lines.push("");
    lines.push("vacuous (counted as failures)");
    for (const entry of vacuousOnes) lines.push(`  ${entry.message}`);
  }

  const limitedOnes = assertions.filter((a) => a.verdict === "limit");
  if (limitedOnes.length) {
    lines.push("");
    lines.push("limits (not passes)");
    for (const entry of limitedOnes) lines.push(`  ${entry.message}`);
  }

  const counts = tally(assertions);
  lines.push("");
  lines.push(`pass ${counts.pass}  fail ${counts.fail}  limit ${counts.limit}`);
  return lines.join("\n");
}

export function tally(assertions) {
  const counts = { pass: 0, fail: 0, limit: 0 };
  for (const a of assertions) counts[a.verdict] += 1;
  return counts;
}
