// Unit tests for the pure layer of the cost audit: assertions, verdict text,
// vacuity, registration phases, the table and the exit code. No browser.

import test from "node:test";
import assert from "node:assert/strict";

import { buildAssertions, renderTable, exitCodeFor, tally, grepEvidence, EXIT_OK, EXIT_FAILED } from "../lib/report.mjs";

const EXTENSIONS = [
  { package: "audio-normalizer", id: "phcngmelnemgjdncncndlnpfcoknfhma", name: "Audio Normalizer", version: "5.4.3" },
  { package: "slowed-reverb", id: "ajbnohgeoaoajfgojnjbmclfjjcpnhjp", name: "Slowed Reverb", version: "1.1.0" },
  { package: "web-discord-rpc", id: "mnmmfbjinpokfnendlbhbbdmfjidgikf", name: "YouTube Music Presence", version: "1.1.7" },
  { package: "crunchy-presence", id: "afghbfidjjlgnhaacaiiakmknffnmiom", name: "Crunchy Presence", version: "1.2.0" },
];

function zeroFootprint() {
  return { scripts: 0, listenerRegistrations: 0, timers: 0, observers: 0, patches: 0, workletNodes: 0, audioContexts: 0, mediaElementSources: 0 };
}

function extensionsAll(values = {}) {
  const out = {};
  for (const ext of EXTENSIONS) out[ext.package] = { ...zeroFootprint(), ...(values[ext.package] ?? {}) };
  return out;
}

function scenario(overrides = {}) {
  return {
    id: "control",
    label: "control host, nothing opted in",
    url: "http://127.0.0.1:5555/control",
    host: "127.0.0.1",
    expectInert: true,
    extensions: extensionsAll(),
    probe: { patches: [], scriptElements: [], uncaught: [], mediaElementCurrentTime: 0 },
    notes: [],
    ...overrides,
  };
}

function report(overrides = {}) {
  return {
    schema: "cost-audit/1",
    browser: { name: "Chrome", path: "C:\\chrome.exe", product: "Chrome/157", headless: true },
    extensions: EXTENSIONS,
    foreignExtensions: [],
    hostAccess: { origins: ["<all_urls>"] },
    scenarios: [scenario()],
    // Every zero is only evidence when the extension demonstrably injects
    // somewhere; the fixture supplies that signal by default.
    signals: EXTENSIONS.map((ext) => ({ package: ext.package, scenario: "enabled", host: "excluded.test", scripts: 1 })),
    // Manifest reach: by default every package could match the fixture hosts, so
    // a missing signal is a vacuous failure rather than an unreachable host.
    reach: Object.fromEntries(EXTENSIONS.map((ext) => [ext.package, { patterns: ["http://*/*", "https://*/*"] }])),
    registration: null,
    ...overrides,
  };
}

test("a clean control scenario passes with zero footprint for every extension", () => {
  const assertions = buildAssertions(report());
  const control = assertions.filter((a) => a.id.startsWith("control-zero/"));
  assert.equal(control.length, 4);
  assert.ok(control.every((a) => a.verdict === "pass"), "every extension must pass on the control host");
});

test("a single listener changes exactly one verdict and names extension, host and count", () => {
  const dirty = scenario({ extensions: extensionsAll({ "audio-normalizer": { listenerRegistrations: 2 } }) });
  const assertions = buildAssertions(report({ scenarios: [dirty] }));
  const failed = assertions.filter((a) => a.verdict === "fail");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].extension, "Audio Normalizer");
  assert.equal(failed[0].host, "127.0.0.1");
  assert.match(failed[0].message, /Audio Normalizer/);
  assert.match(failed[0].message, /127\.0\.0\.1/);
  assert.match(failed[0].message, /listenerRegistrations=2/);
  assert.equal(exitCodeFor(assertions), EXIT_FAILED);
});

test("a zero with no signal anywhere is a vacuous failure, not a pass", () => {
  const assertions = buildAssertions(report({ signals: [] }));
  const zeros = assertions.filter((a) => a.id.startsWith("control-zero/"));
  assert.equal(zeros.length, 4);
  for (const zero of zeros) {
    assert.equal(zero.verdict, "fail", `${zero.extension} must not pass vacuously`);
    assert.match(zero.message, /^FAIL \(vacuous: /);
    assert.equal(zero.vacuous, true);
  }
  assert.equal(exitCodeFor(assertions), EXIT_FAILED);
});

test("a zero signal is reported by name as well", () => {
  const enabled = scenario({
    id: "enabled",
    kind: "signal",
    host: "excluded.test",
    expectInert: false,
    expectInject: "audio-normalizer",
  });
  const assertions = buildAssertions(report({ scenarios: [enabled], signals: [] }));
  const signal = assertions.find((a) => a.id === "signal/enabled/audio-normalizer");
  assert.equal(signal.verdict, "fail");
  assert.match(signal.message, /no signal/);
  assert.equal(exitCodeFor(assertions), EXIT_FAILED);
});

test("a signal scenario records the injection it proved", () => {
  const enabled = scenario({
    id: "enabled",
    kind: "signal",
    host: "excluded.test",
    expectInert: false,
    expectInject: "audio-normalizer",
    extensions: extensionsAll({ "audio-normalizer": { scripts: 1 } }),
  });
  const assertions = buildAssertions(report({ scenarios: [enabled] }));
  const signal = assertions.find((a) => a.id === "signal/enabled/audio-normalizer");
  assert.equal(signal.verdict, "pass");
  assert.match(signal.message, /injects 1 content script/);
});

test("a seen-off scenario passes when the content script runs and the page costs nothing", () => {
  const seenOff = scenario({
    id: "seen-off",
    kind: "seen-off",
    host: "seen-off.test",
    expectInert: false,
    extensions: extensionsAll({ "audio-normalizer": { scripts: 1 } }),
  });
  const assertions = buildAssertions(report({ scenarios: [seenOff] }));
  const verdict = assertions.find((a) => a.id === "seen-off/audio-normalizer");
  assert.equal(verdict.verdict, "pass");
  assert.match(verdict.message, /1 content script\(s\) on the seen-but-off seen-off\.test/);

  // No content script on a seen host is a failure: registration is what makes a
  // later enable live.
  const absent = buildAssertions(report({
    scenarios: [scenario({ id: "seen-off", kind: "seen-off", host: "seen-off.test", expectInert: false, extensions: extensionsAll() })],
  })).find((a) => a.id === "seen-off/audio-normalizer");
  assert.equal(absent.verdict, "fail");
  assert.match(absent.message, /no content script .* could not be live/);

  // Page-world cost on a seen-but-off host is a failure of the reservation mode:
  // it must be idle, not merely unprocessed.
  const costly = buildAssertions(report({
    scenarios: [scenario({
      id: "seen-off",
      kind: "seen-off",
      host: "seen-off.test",
      expectInert: false,
      extensions: extensionsAll({ "audio-normalizer": { scripts: 1, observers: 1, workletNodes: 1 } }),
    })],
  })).find((a) => a.id === "seen-off/audio-normalizer");
  assert.equal(costly.verdict, "fail");
  assert.match(costly.message, /observers=1/);
});

test("a zero with no signal is a limit when the manifest cannot even match the host", () => {
  const pinned = scenario({ extensions: extensionsAll() });
  const assertions = buildAssertions(
    report({
      signals: [],
      reach: { "crunchy-presence": { patterns: ["https://*.crunchyroll.com/*"] } },
      scenarios: [pinned],
    }),
  );
  const crunchy = assertions.find((a) => a.id === "control-zero/crunchy-presence");
  assert.equal(crunchy.verdict, "limit");
  assert.match(crunchy.message, /cannot match 127\.0\.0\.1/);
  assert.match(crunchy.message, /crunchyroll/);

  // An extension that could have run here but did not is a vacuous failure.
  const reachable = buildAssertions(
    report({
      signals: [],
      reach: { "crunchy-presence": { patterns: ["http://*/*"] } },
      scenarios: [pinned],
    }),
  );
  const same = reachable.find((a) => a.id === "control-zero/crunchy-presence");
  assert.equal(same.verdict, "fail");
  assert.match(same.message, /^FAIL \(vacuous: /);
});

test("a limit is printed loudly, is never a pass, and does not fail the run", () => {
  const assertions = buildAssertions(report(), {
    limits: [{ id: "coexistence", scenario: "coexistence", reason: "no https origin on this machine" }],
  });
  const limit = assertions.find((a) => a.id === "coexistence");
  assert.equal(limit.verdict, "limit");
  assert.match(limit.message, /^LIMIT: no https origin/);
  const table = renderTable(report(), assertions);
  assert.match(table, /LIMIT: no https origin/);
  assert.equal(tally(assertions).limit, 1);
  assert.equal(exitCodeFor(assertions), EXIT_OK);
});

test("the table carries one row per extension per scenario with all five counts", () => {
  const table = renderTable(report(), buildAssertions(report()));
  for (const header of ["scenario", "extension", "scripts", "listenerRegistrations", "timers", "observers", "patches"]) {
    assert.match(table, new RegExp(header));
  }
  assert.match(table, /Audio Normalizer/);
});

test("coexistence fails when one extension builds two audio graphs", () => {
  const coexist = scenario({
    id: "coexistence",
    kind: "coexistence",
    host: "music.youtube.com",
    expectInert: false,
    graphExpected: ["audio-normalizer"],
    probe: { patches: [], scriptElements: [], uncaught: [], mediaElementCurrentTime: 1.4, doubledWiring: [] },
    extensions: extensionsAll({ "audio-normalizer": { scripts: 1, workletNodes: 2, audioContexts: 1 } }),
  });
  const failed = buildAssertions(report({ scenarios: [coexist] })).filter((a) => a.verdict === "fail");
  assert.equal(failed.length, 1);
  assert.match(failed[0].message, /workletNodes=2/);
});

test("a graph with no running context is reported as silence, not processing", () => {
  const coexist = scenario({
    id: "coexistence",
    kind: "coexistence",
    host: "music.youtube.com",
    expectInert: false,
    graphExpected: ["audio-normalizer"],
    probe: { patches: [], scriptElements: [], uncaught: [], mediaElementCurrentTime: 0.5, doubledWiring: [] },
    extensions: extensionsAll({
      "audio-normalizer": { scripts: 1, workletNodes: 1, audioContexts: 1, audioContextsRunning: 0, audioContextTimes: ["suspended@0.00s"] },
    }),
  });
  const graph = buildAssertions(report({ scenarios: [coexist] })).find((a) => a.id === "coexistence-graph/audio-normalizer");
  assert.equal(graph.verdict, "fail");
  assert.match(graph.message, /no running AudioContext/);
  assert.match(graph.message, /suspended@0\.00s/);
});

test("an extension that never built a graph gets a LIMIT carrying its probe", () => {
  const coexist = scenario({
    id: "coexistence",
    kind: "coexistence",
    host: "music.youtube.com",
    expectInert: false,
    graphExpected: ["slowed-reverb"],
    extensionProbes: { "slowed-reverb": '{"hookReady":false}' },
    probe: { patches: [], scriptElements: [], uncaught: [], mediaElementCurrentTime: 0.9, doubledWiring: [] },
    extensions: extensionsAll({ "slowed-reverb": { scripts: 1 } }),
  });
  const graph = buildAssertions(report({ scenarios: [coexist] })).find((a) => a.id === "coexistence-graph/slowed-reverb");
  assert.equal(graph.verdict, "limit");
  assert.match(graph.message, /^\s*LIMIT: /);
  assert.match(graph.message, /hookReady/);
});

test("a presence-only extension in the coexistence run is asserted to cost nothing", () => {
  const coexist = scenario({
    id: "coexistence",
    kind: "coexistence",
    host: "music.youtube.com",
    expectInert: false,
    graphExpected: [],
    probe: { patches: [], scriptElements: [], uncaught: [], mediaElementCurrentTime: 0.8, doubledWiring: [] },
    extensions: extensionsAll({ "web-discord-rpc": { scripts: 1, listenerRegistrations: 2 } }),
  });
  const assertions = buildAssertions(report({ scenarios: [coexist] }));
  const cost = assertions.find((a) => a.id === "coexistence-page-cost/web-discord-rpc");
  assert.equal(cost.verdict, "fail");
  assert.match(cost.message, /listenerRegistrations=2/);

  const clean = scenario({
    id: "coexistence",
    kind: "coexistence",
    host: "music.youtube.com",
    expectInert: false,
    graphExpected: [],
    probe: { patches: [], scriptElements: [], uncaught: [], mediaElementCurrentTime: 0.8, doubledWiring: [] },
    extensions: extensionsAll({ "web-discord-rpc": { scripts: 1 } }),
  });
  const ok = buildAssertions(report({ scenarios: [clean] })).find((a) => a.id === "coexistence-page-cost/web-discord-rpc");
  assert.equal(ok.verdict, "pass");
});

// ---- registration phases -------------------------------------------------

const SOURCE = {
  token: "registerContentScripts",
  filesScanned: 5,
  matches: [
    { file: "background.js", line: 406, text: "await chrome.scripting.registerContentScripts([descriptor]);" },
    { file: "background.js", line: 378, text: "if (!chrome.scripting || typeof chrome.scripting.registerContentScripts !== 'function') return;" },
  ],
};

const registration = (phases) => ({ package: "audio-normalizer", name: "Audio Normalizer", source: SOURCE, phases });

test("grep evidence names the file and line, never a bare boolean", () => {
  assert.equal(grepEvidence(SOURCE), 'source grep "registerContentScripts": background.js:406 (+1 more)');
  assert.equal(
    grepEvidence({ token: "nope", filesScanned: 7, matches: [] }),
    'source grep "nope": 0 matches in 7 file(s)',
  );
});

test("registration proves the excluded host moved out of matches into excludeMatches", () => {
  const phases = [
    { id: "A-enabled", host: "excluded.test", expect: "covers-host", scripts: 1, registered: [{ id: "cs", matches: ["*://excluded.test/*", "*://sub.excluded.test/*"], excludeMatches: [] }] },
    { id: "A-excluded", host: "excluded.test", expect: "host-excluded", scripts: 0, registered: [{ id: "cs", matches: ["*://sub.excluded.test/*"], excludeMatches: ["*://*.excluded.test/*"] }] },
    { id: "A-restored", host: "excluded.test", expect: "covers-host", scripts: 1, registered: [{ id: "cs", matches: ["*://excluded.test/*"], excludeMatches: [] }] },
  ];
  const assertions = buildAssertions(report({ registration: registration(phases) }));
  const byId = new Map(assertions.map((a) => [a.id, a]));
  assert.equal(byId.get("registration-covers/A-enabled").verdict, "pass");
  assert.equal(byId.get("registration-not-in-matches/A-excluded").verdict, "pass");
  assert.equal(byId.get("registration-in-exclude/A-excluded").verdict, "pass");
  assert.equal(byId.get("registration-covers/A-restored").verdict, "pass");
});

test("an excluded host may be excluded by tearing the registration down entirely", () => {
  const phases = [
    { id: "A-enabled", host: "excluded.test", expect: "covers-host", scripts: 1, registered: [{ id: "cs", matches: ["*://excluded.test/*"], excludeMatches: [] }] },
    { id: "A-excluded", host: "excluded.test", expect: "host-excluded", scripts: 0, registered: [] },
  ];
  const assertions = buildAssertions(report({ registration: registration(phases) }));
  const notIn = assertions.find((a) => a.id === "registration-not-in-matches/A-excluded");
  const inEx = assertions.find((a) => a.id === "registration-in-exclude/A-excluded");
  assert.equal(notIn.verdict, "pass");
  assert.match(notIn.message, /holds no registration at all/);
  assert.equal(inEx.verdict, "pass");
  assert.match(inEx.message, /torn down entirely/);
});

test("an empty registration cannot satisfy any registration assertion", () => {
  const phases = [
    { id: "A-enabled", host: "excluded.test", expect: "covers-host", scripts: 1, registered: [] },
    { id: "A-excluded", host: "excluded.test", expect: "host-excluded", scripts: 0, registered: [] },
  ];
  const assertions = buildAssertions(report({ registration: registration(phases) }));
  const registrationOnes = assertions.filter((a) => a.scenario.startsWith("registration:"));
  assert.ok(registrationOnes.length >= 3);
  for (const entry of registrationOnes) {
    assert.equal(entry.verdict, "fail", `${entry.id} must not pass on an empty registration`);
    assert.match(entry.message, /^FAIL \(vacuous: /);
    assert.match(entry.message, /background\.js:406/);
  }
});

test("the never-configured host assertion fails when nothing was ever registered", () => {
  const phases = [{ id: "B-never-configured", host: "never-configured.test", expect: "host-unknown", scripts: 0, registered: [] }];
  const assertions = buildAssertions(report({ registration: registration(phases) }));
  const negative = assertions.find((a) => a.id === "registration-negative/B-never-configured");
  assert.equal(negative.verdict, "fail");
  assert.match(negative.message, /^FAIL \(vacuous: /);
});

test("the never-configured host passes only while another host is registered", () => {
  const phases = [
    { id: "A-enabled", host: "excluded.test", expect: "covers-host", scripts: 1, registered: [{ id: "cs", matches: ["*://excluded.test/*"], excludeMatches: [] }] },
    { id: "B-never-configured", host: "never-configured.test", expect: "host-unknown", scripts: 0, registered: [{ id: "cs", matches: ["*://excluded.test/*"], excludeMatches: [] }] },
  ];
  const assertions = buildAssertions(report({ registration: registration(phases) }));
  assert.equal(assertions.find((a) => a.id === "registration-negative/B-never-configured").verdict, "pass");
});

test("the negative host fails if it ever appears in a registration", () => {
  const phases = [
    { id: "A-enabled", host: "excluded.test", expect: "covers-host", scripts: 1, registered: [{ id: "cs", matches: ["*://excluded.test/*"], excludeMatches: [] }] },
    { id: "B-never-configured", host: "never-configured.test", expect: "host-unknown", scripts: 1, registered: [{ id: "cs", matches: ["<all_urls>"], excludeMatches: [] }] },
  ];
  const assertions = buildAssertions(report({ registration: registration(phases) }));
  const negative = assertions.find((a) => a.id === "registration-negative/B-never-configured");
  assert.equal(negative.verdict, "fail");
  assert.match(negative.message, /never configured but appears in a registration/);
});

test("no registration survives when nothing is enabled", () => {
  const phases = [
    { id: "A-enabled", host: "excluded.test", expect: "covers-host", scripts: 1, registered: [{ id: "cs", matches: ["*://excluded.test/*"], excludeMatches: [] }] },
    { id: "nothing-enabled", host: "excluded.test", expect: "no-registration", scripts: 0, registered: [] },
  ];
  const assertions = buildAssertions(report({ registration: registration(phases) }));
  assert.equal(assertions.find((a) => a.id === "registration-empty/nothing-enabled").verdict, "pass");
});
