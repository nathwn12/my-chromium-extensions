#!/usr/bin/env node
// Zero-dependency, network-free browser harness that measures what the four
// unpacked extensions cost a page, and proves the exclusion claim instead of
// asserting it.
//
// Usage
//   node tools/cost-audit/run.mjs                          table only, exit 0
//   node tools/cost-audit/run.mjs --assert                 exit 1 on any violation
//   node tools/cost-audit/run.mjs --json <path>            write the full report
//   node tools/cost-audit/run.mjs --package slowed-reverb  load just one extension
//
// Exit codes: 0 ok (skips allowed, printed), 1 assertion failed (--assert), 2 the
// harness itself could not run (no browser, no extension, CDP failure).

import { rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  findBrowser,
  launch,
  stop,
  loadUnpacked,
  listExtensions,
  makeProfileDir,
  buildArgs,
  silentCheck,
  strayPids,
  killStrays,
  REQUIRED_SILENT_FLAGS,
} from "./lib/browser.mjs";
import { startFixtureServers } from "./lib/server.mjs";
import {
  openTab,
  visit,
  readProbe,
  evaluateInWorker,
  evaluateInContext,
  findWorker,
  aggregate,
  isolatedWorlds,
} from "./lib/measure.mjs";
import { buildAssertions, renderTable, tally, EXIT_FAILED } from "./lib/report.mjs";
import { sourceGrep, manifestPatterns } from "./lib/source.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SCRATCH = "C:\\Users\\nathan\\AppData\\Local\\Temp\\opencode\\cx";

const PACKAGES = [
  { name: "audio-normalizer", dir: join(REPO_ROOT, "packages", "audio-normalizer") },
  { name: "slowed-reverb", dir: join(REPO_ROOT, "packages", "slowed-reverb") },
  { name: "web-discord-rpc", dir: join(REPO_ROOT, "packages", "web-discord-rpc") },
  { name: "crunchy-presence", dir: join(REPO_ROOT, "packages", "crunchy-presence") },
];

/** Page-world globals each package installs when it is live. */
const MARKERS = {
  "audio-normalizer": ["__tabNormalizerHookV5"],
  "slowed-reverb": ["__slowedReverbAudioPageHook"],
};

const LOCAL_HOST = "127.0.0.1";
const EXCLUDED_KEY = "excluded.test";
const EXCLUDED_SUB_HOST = `sub.${EXCLUDED_KEY}`;
const NEVER_CONFIGURED_HOST = "never-configured.test";
// Kept opted in throughout so a registration stays alive while A is excluded;
// without it the extension unregisters entirely and excludeMatches is invisible.
const OTHER_ENABLED_HOST = "elsewhere.test";

/**
 * Read Slowed Reverb's own live state from its isolated world, so a missing
 * audio graph is reported with a reason instead of a guess.
 */
const SLOWED_REVERB_PROBE = `(() => {
  try {
    var api = globalThis.__slowedReverbAudioContent || null;
    var media = document.querySelector("audio,video");
    return JSON.stringify({
      api: Boolean(api),
      hookReady: api && typeof api.__testIsHookReady === "function" ? Boolean(api.__testIsHookReady()) : null,
      hookToken: api && typeof api.__testGetHookToken === "function" ? Boolean(api.__testGetHookToken()) : null,
      retired: api && typeof api.__testIsRetired === "function" ? Boolean(api.__testIsRetired()) : null,
      captureStream: typeof HTMLMediaElement.prototype.captureStream,
      mediaElements: document.querySelectorAll("audio,video").length,
      mediaPaused: media ? Boolean(media.paused) : null
    });
  } catch (error) {
    return "probe threw: " + String(error);
  }
})()`;

function parseArgs(argv) {
  const options = { json: null, assert: false, packages: null, settleMs: 1400, help: false, silentCheck: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") options.json = argv[++i];
    else if (arg === "--assert") options.assert = true;
    else if (arg === "--silent-check") options.silentCheck = true;
    else if (arg === "--package") {
      const name = argv[++i];
      options.packages = (options.packages ?? []).concat(name);
    } else if (arg === "--settle") options.settleMs = Number(argv[++i]) || 1400;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "node tools/cost-audit/run.mjs [--assert] [--json <path>] [--package <name>] [--settle <ms>]",
    "",
    "  --assert          exit 1 when any assertion fails",
    "  --json <path>     write the full report to <path>",
    "  --package <name>  load only this extension (audio-normalizer, slowed-reverb,",
    "                    web-discord-rpc, crunchy-presence); repeatable",
    "  --settle <ms>     extra wait after each page load (default 1400)",
    "  --silent-check    verify every launch argv is muted and headless, then exit",
    "                    without starting a browser (exit 1 if any argv could be audible)",
  ].join("\n");
}

/** chrome.storage.local items that put one package into a known state for a host. */
function seedItems(pkg, { host, excluded = false }) {
  if (pkg === "audio-normalizer") {
    const record = { enabled: true, gainDb: 0, seq: 1, mirror: true };
    if (excluded) record.excluded = true;
    return { [`site:${host}`]: record };
  }
  if (pkg === "slowed-reverb") {
    return {
      siteToggles: { [host]: true },
      // reverbIntensity is 0..1, not a percentage: 30 clamps to 0 (neutral).
      siteSettings: { [host]: { slow: 1.2, reverbIntensity: 0.3 } },
    };
  }
  if (pkg === "web-discord-rpc") return { enabled: true };
  return {};
}

async function seed(client, extension, pkg, items) {
  if (!Object.keys(items).length) return { ok: true, wrote: [] };
  const worker = await findWorker(client, extension.id);
  if (!worker) {
    return { ok: false, wrote: [], error: `no ${pkg} service worker target — could not seed chrome.storage.local` };
  }
  await evaluateInWorker(
    client,
    worker.targetId,
    `(async () => { await chrome.storage.local.set(${JSON.stringify(items)}); return Object.keys(await chrome.storage.local.get(null)); })()`,
  );
  return { ok: true, wrote: Object.keys(items) };
}

async function readRegistration(client, extension) {
  const worker = await findWorker(client, extension.id);
  if (!worker) return { ok: false, error: "no service worker target" };
  const raw = await evaluateInWorker(
    client,
    worker.targetId,
    `(async () => {
      if (!chrome.scripting || typeof chrome.scripting.getRegisteredContentScripts !== "function") {
        return JSON.stringify({ supported: false, scripts: [] });
      }
      const scripts = await chrome.scripting.getRegisteredContentScripts();
      const perms = await chrome.permissions.getAll();
      return JSON.stringify({ supported: true, scripts, origins: perms.origins || [], permissions: perms.permissions || [] });
    })()`,
  );
  try {
    return { ok: true, ...JSON.parse(raw) };
  } catch {
    return { ok: false, error: `unreadable registration payload: ${String(raw).slice(0, 200)}` };
  }
}

async function readHostAccess(client, extension) {
  const worker = await findWorker(client, extension.id);
  if (!worker) return null;
  const raw = await evaluateInWorker(
    client,
    worker.targetId,
    `(async () => { const p = await chrome.permissions.getAll(); return JSON.stringify({ origins: p.origins || [], permissions: p.permissions || [] }); })()`,
  );
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function markerPatches(probe, pkg) {
  const owned = MARKERS[pkg] ?? [];
  return (probe?.markers ?? []).filter((marker) => owned.includes(marker)).length;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage() + "\n");
    return 0;
  }
  if (options.silentCheck) {
    const problems = silentCheck();
    const argvHeadless = buildArgs({ profileDir: join(SCRATCH, "profile-silent-check-headless"), headless: true });
    const argvHeaded = buildArgs({ profileDir: join(SCRATCH, "profile-silent-check-headed"), headless: false });
    process.stdout.write(`silent-check: ${problems.length === 0 ? "PASS" : "FAIL"}\n`);
    process.stdout.write(`  headless argv: ${argvHeadless.join(" ")}\n`);
    process.stdout.write(`  headed argv:   ${argvHeaded.join(" ")}\n`);
    for (const problem of problems) process.stdout.write(`  ${problem}\n`);
    if (!problems.length) process.stdout.write("  both argv forms carry --mute-audio and the automation flags\n");
    return problems.length === 0 ? 0 : 1;
  }

  const wanted = options.packages ?? PACKAGES.map((p) => p.name);
  for (const name of wanted) {
    if (!PACKAGES.some((p) => p.name === name)) throw Object.assign(new Error(`unknown package: ${name}`), { exitCode: 2 });
  }
  const selected = PACKAGES.filter((p) => wanted.includes(p.name));

  const browser = findBrowser();
  if (!browser) {
    process.stderr.write(
      `no browser found. Probed:\n${["Brave C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe", "Chrome C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "Edge C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].map((l) => `  ${l}`).join("\n")}\n`,
    );
    return 2;
  }

  const profiles = [];
  const certDir = makeProfileDir("cert");
  const servers = await startFixtureServers({ certDir });
  const hostMapperRules = [
    ...(servers.httpsPort ? [{ host: "music.youtube.com", ip: "127.0.0.1", port: servers.httpsPort }] : []),
    { host: EXCLUDED_KEY, ip: "127.0.0.1" },
    { host: EXCLUDED_SUB_HOST, ip: "127.0.0.1" },
    { host: NEVER_CONFIGURED_HOST, ip: "127.0.0.1" },
    { host: OTHER_ENABLED_HOST, ip: "127.0.0.1" },
  ];

  let session = null;
  const notes = [];
  const limits = [];
  const report = {
    schema: "cost-audit/1",
    generatedAt: new Date().toISOString(),
    browser: { name: browser.name, path: browser.path, product: null, headless: true, argv: [], profileDir: null },
    loadRoute: "CDP Extensions.loadUnpacked (Chrome 157 ignores --load-extension silently)",
    extensions: [],
    foreignExtensions: [],
    server: { http: servers.httpUrl, https: servers.httpsUrl, networkFree: true },
    scenarios: [],
    registration: null,
    hostAccess: null,
    assertions: [],
    silent: {
      requiredFlags: REQUIRED_SILENT_FLAGS,
      argvChecked: silentCheck(),
      muted: true,
      fallback: null,
    },
    limitations: [
      "Audio was muted for every page load (--mute-audio) at the owner's instruction, so nothing here listens to sound and no assertion reads a device. Silence is measured as a stalled media element plus AudioContext state, never by ear.",
      "Isolated-world (content script) listener, timer and observer registrations are invisible to page-world instrumentation; those are counted as isolated worlds through CDP instead.",
      "The listenerRegistrations column counts addEventListener calls observed in the page world. It is NOT a live listener count: duplicate adds are counted twice even though the platform deduplicates them, a once-listener that already fired still counts, capture is not modelled, AbortSignal removals are invisible, isolated-world registrations never reach the page-world EventTarget.prototype, a registration whose stack names no extension is counted as unattributed, and the log is capped at 500. removeEventListener calls are recorded separately as listenerRemovalCalls and are never subtracted; do not read this column as 'how many listeners are attached'.",
      "The synthetic pages carry no site code, so this measures presence and graph shape, not the fidelity of any site's playback.",
      "Main-world patch detection compares function source text against a baseline taken at document start; a patch that restores identical text would evade it.",
    ],
    counts: { pass: 0, fail: 0, skip: 0 },
  };

  try {
    // Headless first. If the extensions will not load headless, the fallback is
    // a HEADED window that is still muted — never an audible one.
    const loadErrors = [];
    let client = null;
    for (const headless of [true, false]) {
      const profileDir = makeProfileDir(headless ? "profile" : "profile-headed");
      profiles.push(profileDir);
      let launched = null;
      try {
        launched = await launch({
          browser,
          profileDir,
          hostMapperRules,
          headless,
          // Only the mapped https origin uses this; without it the throwaway
          // cert makes the navigation land on chrome-error:// and every audio
          // case measures an error page.
          extraArgs: servers.httpsPort ? ["--ignore-certificate-errors"] : [],
        });
        const loaded = await loadUnpacked(launched.client, selected);
        if (loaded.length !== selected.length) {
          throw new Error(`loaded ${loaded.length} of ${selected.length} extensions`);
        }
        session = launched;
        client = launched.client;
        report.browser.headless = headless;
        report.browser.argv = buildArgs({ profileDir, hostMapperRules, headless, extraArgs: servers.httpsPort ? ["--ignore-certificate-errors"] : [] });
        report.browser.profileDir = profileDir;
        report.extensions = loaded;
        if (!headless) {
          report.silent.fallback = "headed (muted)";
          report.limitations.unshift(
            "HEADED FALLBACK: --headless=new could not load the unpacked extensions, so this run used a visible window. It was launched with --mute-audio and made no sound; the audio cases are still measured from instrumented graphs, never from output.",
          );
          notes.push("headed (muted) fallback: --headless=new could not load the unpacked extensions on this browser");
        }
        break;
      } catch (error) {
        loadErrors.push(`${headless ? "headless" : "headed (muted)"}: ${error.message}`);
        if (launched) await stop(launched);
        session = null;
        client = null;
      }
    }
    if (!client) {
      throw Object.assign(
        new Error(`could not load the unpacked extensions in any mode: ${loadErrors.join(" | ")}`),
        { exitCode: 2 },
      );
    }
    for (const ext of report.extensions) {
      if (!ext.enabled) notes.push(`${ext.package} did not report enabled=true after load`);
    }
    report.browser.product = (await client.send("Browser.getVersion")).product;
    const allExtensions = await listExtensions(client);
    report.foreignExtensions = allExtensions.filter((ext) => !report.extensions.some((mine) => mine.id === ext.id));

    const byName = new Map(report.extensions.map((ext) => [ext.package, ext]));
    const audio = byName.get("audio-normalizer");
    if (audio) report.hostAccess = await readHostAccess(client, audio);
    if (audio && !(report.hostAccess?.origins ?? []).some((origin) => origin === "<all_urls>" || origin === "http://*/*")) {
      throw Object.assign(
        new Error(`audio-normalizer does not hold host access on all sites (origins: ${JSON.stringify(report.hostAccess?.origins ?? [])})`),
        { exitCode: 2 },
      );
    }

    const extensionMeta = report.extensions.map((ext) => ({
      package: ext.package,
      id: ext.id,
      name: ext.name,
      version: ext.version,
    }));
    // What each package is even allowed to touch, so a zero on a host it can
    // never match is reported as a limit instead of a pass.
    report.reach = Object.fromEntries(
      report.extensions.map((ext) => {
        const patterns = manifestPatterns(ext.dir);
        return [ext.package, { patterns: [...new Set([...patterns.content, ...patterns.hostPermissions])], content: patterns.content }];
      }),
    );

    // ---- scenario runner ---------------------------------------------------
    const runScenario = async ({
      id,
      label,
      url,
      host,
      expectInert = true,
      kind = "footprint",
      graphExpected = [],
      inspect = null,
      expectInject = null,
    }) => {
      const tab = await openTab(client);
      try {
        await visit(client, tab.sessionId, url, { settleMs: options.settleMs });
        const probe = await readProbe(client, tab.sessionId);
        const contexts = tab.contexts.slice();
        const perExtension = aggregate({ probe, contexts }, extensionMeta);
        for (const [pkg, value] of Object.entries(perExtension)) value.patches = markerPatches(probe, pkg);
        const foreign = isolatedWorlds(contexts).filter(
          (context) => !extensionMeta.some((ext) => context.origin === `chrome-extension://${ext.id}`),
        );
        const scenario = {
          id,
          kind,
          label,
          url,
          host,
          expectInert,
          graphExpected,
          expectInject,
          extensions: perExtension,
          probe,
          foreignIsolatedWorlds: foreign.map((context) => ({ origin: context.origin, name: context.name })),
          notes: [],
        };
        if (!probe) scenario.notes.push("the page instrument did not report — treat every zero here as unmeasured");
        if (probe?.url && probe.url !== url) scenario.notes.push(`the page settled on ${probe.url} instead of ${url}`);
        if (foreign.length) {
          scenario.notes.push(
            `foreign isolated world(s) from extensions outside this repo: ${foreign.map((f) => f.name || f.origin).join(", ")}`,
          );
        }
        if (inspect) scenario.extensionProbes = await inspect({ client, tab, scenario });
        report.scenarios.push(scenario);
        return { scenario, probe, contexts };
      } finally {
        await tab.close();
      }
    };

    // The claim under test is causal, so it runs as one sequence on named
    // hosts with registration snapshots taken between the storage writes:
    //   A = the key that gets excluded, S = its subdomain, B = never configured.
    // S stays opted in throughout, which keeps a registration alive while A is
    // excluded — otherwise the extension unregisters entirely and "A is absent
    // from matches" would be satisfied by an empty array.
    const A = EXCLUDED_KEY;
    const S = EXCLUDED_SUB_HOST;
    const B = NEVER_CONFIGURED_HOST;
    const urlFor = (host) => `http://${host}:${servers.httpPort}/control`;

    const snapshotRegistration = async (id, host, expect, afterScenario, scripts) => {
      const raw = await readRegistration(client, audio);
      const registered = raw.ok && raw.supported ? (raw.scripts ?? []) : [];
      return {
        id,
        host,
        expect,
        afterScenario,
        scripts: Number.isFinite(scripts) ? scripts : -1,
        entries: registered.length,
        registered: registered.map((entry) => ({
          id: entry.id ?? null,
          matches: entry.matches ?? [],
          excludeMatches: entry.excludeMatches ?? [],
        })),
        readable: Boolean(raw.ok && raw.supported),
        error: raw.ok ? null : (raw.error ?? "registration unreadable"),
      };
    };
    const scriptsOn = (scenarioId) =>
      Number(report.scenarios.find((s) => s.id === scenarioId)?.extensions?.["audio-normalizer"]?.scripts ?? -1);

    await runScenario({ id: "control", label: "control host, never opted in", url: urlFor(LOCAL_HOST), host: LOCAL_HOST });

    if (audio) {
      const phases = [];

      // ---- 1. both hosts opted in ------------------------------------------
      await seed(client, audio, "audio-normalizer", {
        ...seedItems("audio-normalizer", { host: A }),
        ...seedItems("audio-normalizer", { host: S }),
        ...seedItems("audio-normalizer", { host: OTHER_ENABLED_HOST }),
      });
      await runScenario({
        id: "enabled",
        kind: "signal",
        expectInject: "audio-normalizer",
        label: `${A} opted in (positive control)`,
        url: urlFor(A),
        host: A,
        expectInert: false,
      });
      await runScenario({
        id: "subdomain-enabled",
        kind: "signal",
        expectInject: "audio-normalizer",
        label: `${S} opted in (so the parent key's exclusion has a live subject)`,
        url: urlFor(S),
        host: S,
        expectInert: false,
      });
      phases.push(await snapshotRegistration("A-enabled", A, "covers-host", "enabled", scriptsOn("enabled")));

      // ---- 2. the key is excluded, the subdomain stays opted in ------------
      await seed(client, audio, "audio-normalizer", seedItems("audio-normalizer", { host: A, excluded: true }));
      await runScenario({
        id: "A-excluded",
        label: `${A} excluded while still enabled`,
        url: urlFor(A),
        host: A,
      });
      await runScenario({
        id: "S-excluded-by-parent",
        label: `${S} enabled, but its parent key ${A} is excluded`,
        url: urlFor(S),
        host: S,
      });
      phases.push(await snapshotRegistration("A-excluded", A, "host-excluded", "A-excluded", scriptsOn("A-excluded")));

      // ---- 3. undo restores it --------------------------------------------
      await seed(client, audio, "audio-normalizer", {
        [`site:${A}`]: { enabled: true, gainDb: 0, seq: 2, mirror: true, excluded: false },
      });
      await runScenario({
        id: "A-restored",
        kind: "signal",
        label: `${A} un-excluded again`,
        url: urlFor(A),
        host: A,
        expectInert: false,
      });
      phases.push(await snapshotRegistration("A-restored", A, "covers-host", "A-restored", scriptsOn("A-restored")));

      // ---- 4. a host that was never configured ----------------------------
      await runScenario({
        id: "B-never-configured",
        label: `${B} never configured`,
        url: urlFor(B),
        host: B,
      });
      phases.push(
        await snapshotRegistration("B-never-configured", B, "host-unknown", "B-never-configured", scriptsOn("B-never-configured")),
      );

      // ---- 5. nothing enabled: no registration may survive ----------------
      await seed(client, audio, "audio-normalizer", {
        [`site:${A}`]: { enabled: false, gainDb: 0, seq: 3, mirror: false },
        [`site:${S}`]: { enabled: false, gainDb: 0, seq: 2, mirror: false },
        [`site:${OTHER_ENABLED_HOST}`]: { enabled: false, gainDb: 0, seq: 2, mirror: false },
      });
      phases.push(await snapshotRegistration("nothing-enabled", A, "no-registration", "(no page load)", 0));

      report.registration = {
        package: "audio-normalizer",
        name: audio.name,
        source: sourceGrep(audio.dir, "registerContentScripts"),
        derived: sourceGrep(audio.dir, "deriveContentScriptRegistration"),
        hostAccess: report.hostAccess,
        phases,
      };
    }

    // ---- scenario: coexistence on one host --------------------------------
    const coexistencePackages = ["audio-normalizer", "slowed-reverb", "web-discord-rpc"].filter((pkg) => byName.has(pkg));
    if (servers.httpsPort) {
      for (const pkg of coexistencePackages) {
        const ext = byName.get(pkg);
        const seeded = await seed(client, ext, pkg, seedItems(pkg, { host: "music.youtube.com" }));
        if (!seeded.ok) notes.push(seeded.error ?? `seeding ${pkg} failed`);
      }
      await runScenario({
        id: "coexistence",
        kind: "coexistence",
        label: "three extensions active on one host",
        url: `${servers.httpsUrl}/watch`,
        host: "music.youtube.com",
        expectInert: false,
        // Only the two audio engines build a graph; the presence extension must
        // cost the page nothing at all.
        graphExpected: ["audio-normalizer", "slowed-reverb"].filter((pkg) => byName.has(pkg)),
        inspect: async ({ client: cdp, tab, scenario }) => {
          const out = {};
          const slowed = byName.get("slowed-reverb");
          if (!slowed) return out;
          const context = tab.contexts.find(
            (entry) => entry.type === "isolated" && entry.origin === `chrome-extension://${slowed.id}`,
          );
          if (!context) {
            out["slowed-reverb"] = "no isolated world for Slowed Reverb on this page";
            return out;
          }
          const isolated = await evaluateInContext(cdp, tab.sessionId, context.id, SLOWED_REVERB_PROBE);
          const markers = (tab.probe?.markers ?? scenario?.probe?.markers ?? []).join(",") || "none";
          out["slowed-reverb"] = `${isolated} pageWorldMarkers=[${markers}]`;
          return out;
        },
      });
    } else {
      notes.push(
        `coexistence did not run: ${servers.problems.join("; ") || "no https origin available"} — slowed-reverb and web-discord-rpc are pinned to https://music.youtube.com/* by manifest`,
      );
    }
  } finally {
    if (session) {
      const leftovers = await stop(session);
      for (const problem of leftovers) notes.push(`cleanup: ${problem}`);
    }
    await servers.close();
    // Every throwaway directory this run created, including the cert and any
    // profile from a failed launch attempt.
    const leftovers = [];
    for (const dir of [certDir, ...profiles]) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      } catch (error) {
        leftovers.push(`${dir}: ${error.message}`);
      }
    }
    for (const dir of profiles) {
      const alive = strayPids(dir);
      if (alive.length) {
        killStrays(dir);
        leftovers.push(`killed browsers left on ${dir}: ${alive.join(", ")}`);
      }
    }
    for (const leftover of leftovers) notes.push(`cleanup: ${leftover}`);
    report.cleanup = { profiles, certDir, leftovers };
    report.silent.browsersAliveAfter = profiles.flatMap((dir) => strayPids(dir));
  }

  if (!servers.httpsPort) {
    limits.push({
      id: "coexistence",
      scenario: "coexistence",
      reason: `no https origin for music.youtube.com (${servers.problems.join("; ") || "unknown"}), so the two host-pinned extensions cannot be loaded here`,
    });
  }
  const loadedNames = new Set(report.extensions.map((ext) => ext.package));
  // Any injection anywhere in the run is evidence the package can run at all.
  report.signals = report.scenarios.flatMap((scenario) =>
    Object.entries(scenario.extensions)
      .filter(([, value]) => (value.scripts ?? 0) > 0)
      .map(([pkg, value]) => ({ package: pkg, scenario: scenario.id, host: scenario.host, scripts: value.scripts })),
  );

  const assertions = [...report.assertions, ...buildAssertions(report, { limits })];
  // A scenario that yields no assertion silently measures nothing. That is a
  // harness bug: every scenario must be judged by at least one assertion.
  for (const scenario of report.scenarios) {
    if (!assertions.some((entry) => entry.scenario === scenario.id)) {
      throw Object.assign(
        new Error(`harness bug: scenario "${scenario.id}" produced no assertion (kind=${scenario.kind}, expectInert=${scenario.expectInert})`),
        { exitCode: 2 },
      );
    }
  }
  report.assertions = assertions;
  report.counts = tally(assertions);
  report.notes = notes;

  const table = renderTable(report, assertions);
  process.stdout.write(`${table}\n\n`);
  process.stdout.write(`browser: ${report.browser.name} ${report.browser.product ?? ""} (${report.browser.path})\n`);
  process.stdout.write(`load route: ${report.loadRoute}\n`);
  process.stdout.write(`server: ${report.server.http} (network-free)${report.server.https ? `, ${report.server.https} mapped to 127.0.0.1, self-signed` : ""}\n`);
  for (const note of notes) process.stdout.write(`note: ${note}\n`);

  const failures = assertions.filter((a) => a.verdict === "fail");
  if (failures.length) {
    process.stdout.write(`\nfailed assertions\n`);
    for (const failure of failures) process.stdout.write(`  FAIL ${failure.message}\n`);
    if (!options.assert) process.stdout.write("\n(exit 0: pass --assert to fail the run on these)\n");
  }

  if (options.json) {
    writeFileSync(options.json, JSON.stringify(report, null, 2) + "\n");
    process.stdout.write(`report written to ${resolve(options.json)}\n`);
  }

  if (options.assert && failures.length) return EXIT_FAILED;
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`cost-audit harness error: ${error?.message ?? error}\n`);
    process.exitCode = error?.exitCode ?? 2;
  },
);
