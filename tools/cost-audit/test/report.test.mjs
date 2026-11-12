// Unit tests for the pure layer of the cost audit: assertion building, verdict
// text, table rendering and the exit code. No browser, no network, no clock.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAssertions,
  renderTable,
  exitCodeFor,
  EXIT_OK,
  EXIT_FAILED,
} from "../lib/report.mjs";

const EXTENSIONS = [
  { package: "audio-normalizer", id: "phcngmelnemgjdncncndlnpfcoknfhma", name: "Audio Normalizer", version: "5.4.3" },
  { package: "slowed-reverb", id: "ajbnohgeoaoajfgojnjbmclfjjcpnhjp", name: "Slowed Reverb", version: "1.1.0" },
  { package: "web-discord-rpc", id: "mnmmfbjinpokfnendlbhbbdmfjidgikf", name: "YouTube Music Presence", version: "1.1.7" },
  { package: "crunchy-presence", id: "afghbfidjjlgnhaacaiiakmknffnmiom", name: "Crunchy Presence", version: "1.2.0" },
];

function zeroFootprint() {
  return { scripts: 0, listeners: 0, timers: 0, observers: 0, patches: 0, workletNodes: 0, audioContexts: 0, mediaElementSources: 0 };
}

function scenario(overrides = {}) {
  const extensions = {};
  for (const ext of EXTENSIONS) extensions[ext.package] = zeroFootprint();
  return {
    id: "control",
    label: "control host, nothing opted in",
    url: "http://127.0.0.1:5555/control",
    host: "127.0.0.1",
    extensions,
    expectInert: true,
    probe: { patches: [], scriptElements: [], uncaught: [], mediaElementCurrentTime: 0 },
    notes: [],
    ...overrides,
  };
}

function report(overrides = {}) {
  return {
    schema: "cost-audit/1",
    browser: { name: "Chrome", path: "C:\\chrome.exe", version: "157.0.8103.51", headless: true },
    extensions: EXTENSIONS,
    foreignExtensions: [],
    hostAccess: { origins: ["<all_urls>"] },
    scenarios: [scenario()],
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
  const dirty = scenario();
  dirty.extensions["audio-normalizer"].listeners = 2;
  const assertions = buildAssertions(report({ scenarios: [dirty] }));
  const failed = assertions.filter((a) => a.verdict === "fail");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].extension, "Audio Normalizer");
  assert.equal(failed[0].host, "127.0.0.1");
  assert.match(failed[0].message, /Audio Normalizer/);
  assert.match(failed[0].message, /127\.0\.0\.1/);
  assert.match(failed[0].message, /listeners=2/);
  assert.equal(exitCodeFor(assertions), EXIT_FAILED);
});

test("a zero signal is a harness failure, not a pass", () => {
  // The positive control: on a host the extension IS enabled for, it must show
  // at least one content script. Zero there means the audit measured nothing.
  const enabled = scenario({
    id: "enabled",
    kind: "signal",
    expectInert: false,
    label: "opted-in host",
    extensions: { ...scenario().extensions, "audio-normalizer": zeroFootprint() },
  });
  const assertions = buildAssertions(report({ scenarios: [enabled] }), { requireSignal: ["audio-normalizer"] });
  const signal = assertions.find((a) => a.id === "signal/audio-normalizer");
  assert.ok(signal, "a signal assertion must exist when a positive control is required");
  assert.equal(signal.verdict, "fail");
  assert.match(signal.message, /no signal/);
});

test("a package exempted for a missing feature is not failed, and its skip is loud", () => {
  const dirty = scenario({
    id: "control-excluded",
    label: "excluded host",
    expectInert: true,
    exempt: ["audio-normalizer"],
  });
  dirty.extensions["audio-normalizer"] = { ...zeroFootprint(), scripts: 1 };
  const assertions = buildAssertions(report({ scenarios: [dirty] }), {
    skips: [{ id: "excluded-host/control-excluded", scenario: "control-excluded", reason: "no `excluded` field in the package" }],
  });
  assert.equal(assertions.filter((a) => a.verdict === "fail").length, 0);
  const skip = assertions.find((a) => a.id === "excluded-host/control-excluded");
  assert.equal(skip.verdict, "skip");
  assert.match(skip.message, /^SKIP \(not implemented yet\): /);
  // The other three packages are still asserted inert on that host.
  assert.ok(assertions.some((a) => a.id === "control-excluded-zero/slowed-reverb" && a.verdict === "pass"));
});

test("a presence-only extension in the coexistence run is asserted to cost nothing", () => {
  const coexist = scenario({
    id: "coexistence",
    host: "music.youtube.com",
    expectInert: false,
    graphExpected: ["audio-normalizer"],
    probe: { patches: [], scriptElements: [], uncaught: [], mediaElementCurrentTime: 0.8, doubledWiring: [] },
  });
  coexist.extensions["web-discord-rpc"] = { ...zeroFootprint(), scripts: 1, listeners: 2 };
  const assertions = buildAssertions(report({ scenarios: [coexist] }));
  const cost = assertions.find((a) => a.id === "coexistence-page-cost/web-discord-rpc");
  assert.equal(cost.verdict, "fail");
  assert.match(cost.message, /listeners=2/);

  // A content script of its own is expected on a host it is opted into.
  const clean = scenario({
    id: "coexistence",
    host: "music.youtube.com",
    expectInert: false,
    graphExpected: [],
  });
  clean.extensions["web-discord-rpc"] = { ...zeroFootprint(), scripts: 1 };
  const ok = buildAssertions(report({ scenarios: [clean] })).find(
    (a) => a.id === "coexistence-page-cost/web-discord-rpc",
  );
  assert.equal(ok.verdict, "pass");
});

test("a graph with no running context is reported as silence, not processing", () => {
  const coexist = scenario({
    id: "coexistence",
    host: "music.youtube.com",
    expectInert: false,
    graphExpected: ["audio-normalizer"],
    probe: { patches: [], scriptElements: [], uncaught: [], mediaElementCurrentTime: 0.5, doubledWiring: [] },
  });
  coexist.extensions["audio-normalizer"] = {
    ...zeroFootprint(),
    scripts: 1,
    workletNodes: 1,
    audioContexts: 1,
    audioContextsRunning: 0,
    audioContextTimes: ["suspended@0.00s"],
  };
  const graph = buildAssertions(report({ scenarios: [coexist] })).find(
    (a) => a.id === "coexistence-graph/audio-normalizer",
  );
  assert.equal(graph.verdict, "fail");
  assert.match(graph.message, /no running AudioContext/);
  assert.match(graph.message, /suspended@0\.00s/);
});

test("a skip is never rendered or counted as a pass", () => {
  const assertions = buildAssertions(report(), { skips: [{ id: "coexistence", reason: "extension not loaded" }] });
  const skip = assertions.find((a) => a.id === "coexistence");
  assert.equal(skip.verdict, "skip");
  assert.equal(skip.message, "SKIP (not implemented yet): extension not loaded");
  const table = renderTable(report(), assertions);
  assert.match(table, /SKIP \(not implemented yet\): extension not loaded/);
  assert.equal(exitCodeFor(assertions), EXIT_OK);
});

test("the table carries one row per extension per scenario with all five counts", () => {
  const table = renderTable(report(), buildAssertions(report()));
  assert.match(table, /scenario/);
  assert.match(table, /Audio Normalizer/);
  assert.match(table, /scripts/);
  assert.match(table, /listeners/);
  assert.match(table, /timers/);
  assert.match(table, /observers/);
  assert.match(table, /patches/);
});

test("coexistence fails when one extension builds two audio graphs", () => {
  const coexist = scenario({
    id: "coexistence",
    label: "three extensions active on one host",
    host: "music.youtube.com",
    expectInert: false,
    graphExpected: ["audio-normalizer"],
    probe: { patches: [], scriptElements: [], uncaught: [], mediaElementCurrentTime: 1.4, doubledWiring: [] },
    extensions: {
      ...scenario().extensions,
      "audio-normalizer": { ...zeroFootprint(), scripts: 1, workletNodes: 2, audioContexts: 1 },
    },
  });
  const assertions = buildAssertions(report({ scenarios: [coexist] }));
  const failed = assertions.filter((a) => a.verdict === "fail");
  assert.equal(failed.length, 1);
  assert.match(failed[0].message, /workletNodes=2/);
});

test("coexistence skips loudly for an extension that never engaged", () => {
  const coexist = scenario({
    id: "coexistence",
    host: "music.youtube.com",
    expectInert: false,
    graphExpected: ["slowed-reverb"],
  });
  coexist.extensions["slowed-reverb"] = { ...zeroFootprint(), scripts: 1 };
  const assertions = buildAssertions(report({ scenarios: [coexist] }));
  const skip = assertions.find((a) => a.id === "coexistence-graph/slowed-reverb");
  assert.equal(skip.verdict, "skip");
  assert.match(skip.message, /SKIP \(not reachable here\)/);
  assert.match(skip.message, /workletNodes=0/);
});
