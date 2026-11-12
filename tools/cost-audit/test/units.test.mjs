// Unit tests for the harness pieces that do not need a browser: the launch
// arguments, the DevToolsActivePort parser, match-pattern host extraction, the
// generated WAV fixture and the validity of the in-page instrument.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { buildArgs, findBrowser, parseDevToolsActivePort, wsUrlFor, BROWSER_CANDIDATES, silentArgvProblems, silentCheck } from "../lib/browser.mjs";
import { patternHost, patternsCoverHost, hostCovers, packageMentions, sourceGrep } from "../lib/source.mjs";
import { PROBE_SOURCE, sineWavDataUri } from "../lib/probe.mjs";
import { aggregate } from "../lib/measure.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

test("the browser probe order is Brave, Chrome, Edge and stops at the first hit", () => {
  assert.deepEqual(
    BROWSER_CANDIDATES.map((c) => c.name),
    ["Brave", "Chrome", "Edge"],
  );
  const onlyEdge = findBrowser({ exists: (p) => p.includes("msedge") });
  assert.equal(onlyEdge.name, "Edge");
  const none = findBrowser({ exists: () => false });
  assert.equal(none, null);
});

test("DevToolsActivePort is parsed and a broken file is rejected", () => {
  assert.deepEqual(parseDevToolsActivePort("9222\n/devtools/browser/abc\n"), { port: 9222, path: "/devtools/browser/abc" });
  assert.equal(parseDevToolsActivePort("9222"), null);
  assert.equal(parseDevToolsActivePort("nope\n/devtools/browser/abc"), null);
  assert.equal(parseDevToolsActivePort("9222\nno-slash"), null);
  assert.equal(wsUrlFor({ port: 9222, path: "/devtools/browser/abc" }), "ws://127.0.0.1:9222/devtools/browser/abc");
});

test("every launch argv is muted, headless or headed, and nothing else", () => {
  // The harness once made noise. This is the regression guard: no argv form may
  // omit --mute-audio, and a headed fallback is only acceptable while muted.
  for (const headless of [true, false]) {
    const argv = buildArgs({ profileDir: "C:\\Users\\nathan\\AppData\\Local\\Temp\\opencode\\cx\\profile-x", headless });
    assert.ok(argv.includes("--mute-audio"), `missing --mute-audio (headless=${headless})`);
    assert.ok(argv.includes("--autoplay-policy=no-user-gesture-required"), `missing autoplay policy (headless=${headless})`);
    assert.deepEqual(silentArgvProblems(argv, { headless }), []);
  }
  assert.deepEqual(silentCheck(), []);
});

test("the silent guard rejects an audible argv and a profile outside scratch", () => {
  const audible = ["--headless=new", "--user-data-dir=C:\\Users\\nathan\\AppData\\Local\\Temp\\opencode\\cx\\p"];
  const problems = silentArgvProblems(audible, { headless: true });
  assert.ok(problems.includes("missing --mute-audio"));
  assert.ok(problems.includes("missing --autoplay-policy=no-user-gesture-required"));

  const wrongProfile = [
    "--headless=new",
    "--mute-audio",
    "--autoplay-policy=no-user-gesture-required",
    "--user-data-dir=C:\\Users\\nathan\\AppData\\Local\\Google\\Chrome\\User Data",
  ];
  assert.ok(silentArgvProblems(wrongProfile, { headless: true }).some((p) => p.includes("outside the throwaway scratch root")));

  const mutedHeaded = buildArgs({ profileDir: "C:\\Users\\nathan\\AppData\\Local\\Temp\\opencode\\cx\\profile-y", headless: false });
  assert.deepEqual(silentArgvProblems(mutedHeaded, { headless: false }), []);
});

test("launch arguments keep the profile throwaway and the network off", () => {
  const args = buildArgs({
    profileDir: "C:\\temp\\profile-123",
    hostMapperRules: [{ host: "music.youtube.com", ip: "127.0.0.1", port: 8443 }],
  });
  assert.ok(args.includes("--headless=new"));
  assert.ok(args.includes("--remote-debugging-port=0"));
  assert.ok(args.includes("--user-data-dir=C:\\temp\\profile-123"));
  assert.ok(args.includes("--host-resolver-rules=MAP music.youtube.com 127.0.0.1:8443"));
  // --load-extension is dead on Chrome 157: it must not be relied on here.
  assert.ok(!args.some((a) => a.startsWith("--load-extension")));
  assert.ok(!args.some((a) => a.startsWith("--remote-allow-origins")), "no origin widening is needed");
});

test("match patterns yield a bare host", () => {
  assert.equal(patternHost("*://127.0.0.1/*"), "127.0.0.1");
  assert.equal(patternHost("*://*.tiktok.com/*"), "*.tiktok.com");
  assert.equal(patternHost("https://music.youtube.com/*"), "music.youtube.com");
  assert.equal(patternHost("<all_urls>"), null);
});

test("an excluded host is covered by a pattern for itself and by the wildcard", () => {
  assert.equal(patternsCoverHost(["*://excluded.test/*"], "excluded.test"), true);
  assert.equal(patternsCoverHost(["*://*.excluded.test/*"], "excluded.test"), true);
  assert.equal(patternsCoverHost(["*://excluded.test/*"], "sub.excluded.test"), true);
  assert.equal(patternsCoverHost(["*://other.test/*"], "excluded.test"), false);
  assert.equal(patternsCoverHost(["<all_urls>"], "excluded.test"), true);
  assert.equal(hostCovers("excluded.test", "sub.excluded.test"), true);
  assert.equal(hostCovers("excluded.test", "notexcluded.test"), false);
});

test("package source scanning finds and misses tokens", () => {
  const harness = join(HERE, "..");
  assert.equal(packageMentions(join(harness, "lib"), "PROBE_SOURCE"), true);
  assert.equal(packageMentions(join(harness, "lib"), "this token never appears in the package"), false);
  assert.equal(packageMentions(join(harness, "does-not-exist"), "anything"), false);
});

test("sourceGrep reports file and line, and counts the files it read", () => {
  const lib = join(HERE, "..", "lib");
  const hit = sourceGrep(lib, "PROBE_SOURCE");
  assert.ok(hit.matches.length > 0);
  assert.ok(hit.filesScanned > 0);
  for (const match of hit.matches) {
    assert.match(match.file, /\.mjs$/);
    assert.ok(Number.isInteger(match.line) && match.line >= 1);
  }
  const miss = sourceGrep(lib, "this token never appears in the package");
  assert.deepEqual(miss.matches, []);
  assert.ok(miss.filesScanned > 0);
  assert.equal(packageMentions(lib, "this token never appears in the package"), false);
});

test("the generated WAV is a decodable RIFF header with real samples", () => {
  const uri = sineWavDataUri({ seconds: 0.5, sampleRate: 8000 });
  assert.match(uri, /^data:audio\/wav;base64,/);
  const bytes = Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64");
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(bytes.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(bytes.readUInt16LE(22), 1, "mono");
  assert.equal(bytes.readUInt32LE(24), 8000, "8 kHz");
  assert.equal(bytes.length, 44 + 4000 * 2);
});

test("the in-page instrument is valid JavaScript and exposes read()", () => {
  assert.doesNotThrow(() => new Function(PROBE_SOURCE));
  const source = readFileSync(join(HERE, "..", "lib", "probe.mjs"), "utf8");
  assert.match(source, /__costProbe/);
  for (const key of ["listeners", "timers", "observers", "audioContexts", "workletNodes", "patches"]) {
    assert.match(PROBE_SOURCE, new RegExp(key), `the probe must collect ${key}`);
  }
});

// Run the real instrument in a stub page world: enough of window/document for
// it to install and count, with no browser involved.
function installProbe() {
  class FakeEventTarget {
    constructor() {
      this._handlers = [];
    }
    addEventListener(type, fn) {
      this._handlers.push({ type, fn });
    }
    removeEventListener(type, fn) {
      const index = this._handlers.findIndex((entry) => entry.type === type && entry.fn === fn);
      if (index !== -1) this._handlers.splice(index, 1);
    }
  }
  class FakeAudioContext {
    createMediaElementSource() {
      return { connect() {}, disconnect() {} };
    }
  }
  class FakeWorkletNode {}
  const window = new FakeEventTarget();
  window.setTimeout = (fn) => setTimeout(fn, 0);
  window.setInterval = () => 0;
  window.requestAnimationFrame = () => 0;
  window.AudioContext = FakeAudioContext;
  window.AudioWorkletNode = FakeWorkletNode;
  const document = new FakeEventTarget();
  document.querySelector = () => null;
  document.querySelectorAll = () => [];
  document.documentElement = {};
  const sandbox = {
    window,
    document,
    location: { href: "http://127.0.0.1/", hostname: "127.0.0.1" },
    EventTarget: FakeEventTarget,
    AudioNode: { prototype: { connect() {} } },
    HTMLMediaElement: { prototype: { play() {} } },
    Element: { prototype: { attachShadow() {} } },
    AudioWorkletNode: FakeWorkletNode,
    console,
    Date,
    Function,
    String,
    Object,
    Array,
    JSON,
    Error,
  };
  vm.runInNewContext(PROBE_SOURCE, sandbox, { filename: "probe.js" });
  return { window, document, probe: window.__costProbe };
}

test("the probe reports listener REGISTRATIONS, and claims no live count", () => {
  const { window, document, probe } = installProbe();
  const first = () => {};
  const second = () => {};
  window.addEventListener("focus", first);
  window.addEventListener("focus", second);
  document.addEventListener("click", first);
  window.removeEventListener("focus", first);

  const read = probe.read();
  assert.equal(read.listenerRegistrations, 3, "every addEventListener call the page world sees is counted");
  assert.equal(read.listenerRemovalCalls, 1, "removeEventListener calls are counted as calls, nothing more");
  assert.equal(
    Object.prototype.hasOwnProperty.call(read, "liveListeners"),
    false,
    "no live count is published: duplicate adds, capture, once and AbortSignal make one indefensible",
  );
  assert.equal(read.listeners.length, 3, "the registration log is kept for attribution");
});

test("the aggregate reports listenerRegistrations and no invented live figure", () => {
  const extensions = [{ id: "a".repeat(32), package: "audio-normalizer", name: "Audio Normalizer" }];
  const frame = `extension:${"a".repeat(32)}`;
  const probe = {
    listeners: [
      { type: "focus", frame },
      { type: "focus", frame },
      { type: "play", frame },
    ],
    listenerRemovalCalls: 2,
    timers: [],
    rafs: [],
    observers: [],
    audioContexts: [],
    contextStates: [],
    workletNodes: [],
    mediaElementSources: [],
  };
  const row = aggregate({ probe, contexts: [] }, extensions)["audio-normalizer"];
  assert.equal(row.listenerRegistrations, 3, "the column is the observed registration count");
  assert.equal(row.listeners, undefined, "there is no `listeners` field to mistake for a live count");
  assert.equal(row.liveListeners, undefined, "and no live derivative either");
});
