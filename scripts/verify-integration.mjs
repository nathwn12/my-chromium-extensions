#!/usr/bin/env node
// Verify the root workspace wires in packages/web-discord-rpc.
// Each wiring point is a predicate with a negative self-test, so a check
// that cannot go red cannot ship: breaking any wiring point fails this script.
// Usage: node scripts/verify-integration.mjs [--prove-red]
//   --prove-red runs the predicates against broken fixtures and exits 0 only
//   when every predicate fails there (proves each check can go red).
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let ROOT = process.env.WDR_VERIFY_ROOT
  ? resolve(process.env.WDR_VERIFY_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WDR = "web-discord-rpc";

function read(rel) {
  try {
    return readFileSync(join(ROOT, rel), "utf8");
  } catch {
    return null;
  }
}

function collectTests(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries.sort()) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out = out.concat(collectTests(full));
    else if (/\.test\.(js|mjs|cjs)$/.test(entry)) out.push(full);
  }
  return out;
}

function zipFiles(release) {
  if (typeof release !== "string") return null;
  const line = release.split("\n").find((l) => l.includes(`(cd packages/${WDR}`));
  if (!line) return null;
  const files = line
    .split("&&")[1]
    ?.replace(/^.*zip\s+\S+\s+/, "")
    .replace(/\)\s*$/, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return files && files.length > 0 ? files : null;
}

// Every local file the manifest points at: the loader, content scripts,
// popup and options pages, and all icons. Remote URLs never appear here.
function manifestLocalFiles(manifest) {
  if (!manifest || typeof manifest !== "object") return null;
  const out = [];
  if (typeof manifest?.background?.service_worker === "string")
    out.push(manifest.background.service_worker);
  for (const script of manifest.content_scripts ?? []) {
    if (Array.isArray(script.js)) out.push(...script.js);
  }
  if (typeof manifest?.action?.default_popup === "string")
    out.push(manifest.action.default_popup);
  if (typeof manifest?.options_ui?.page === "string")
    out.push(manifest.options_ui.page);
  for (const icons of [manifest.icons, manifest?.action?.default_icon]) {
    if (icons && typeof icons === "object") {
      for (const value of Object.values(icons)) {
        if (typeof value === "string") out.push(value);
      }
    }
  }
  return [...new Set(out)];
}

// Predicates over loaded content. Each returns true when the wiring holds.
const predicates = {
  "workspaces cover packages/*": ({ rootPkg }) => {
    if (!rootPkg?.workspaces || !Array.isArray(rootPkg.workspaces)) return false;
    return rootPkg.workspaces.some(
      (w) => w === "packages/*" || w === `packages/${WDR}`
    );
  },
  "root test script runs the web-discord-rpc workspace": ({ rootPkg }) =>
    typeof rootPkg?.scripts?.test === "string" &&
    rootPkg.scripts.test.includes(WDR),
  "package test script runs every test under test/": ({ wdrPkg }) => {
    const script = wdrPkg?.scripts?.test;
    if (typeof script !== "string") return false;
    // Must point at the directory (runner or glob), never an explicit file list.
    if (!/(run-tests\.mjs\s+test|node\s+--test\s+test\/?(\s|$|"))/.test(script))
      return false;
    return true;
  },
  "package test/ holds at least one test file": () =>
    collectTests(join(ROOT, "packages", WDR, "test")).length > 0,
  "README names the package with its version": ({ readme, wdrPkg }) =>
    typeof readme === "string" &&
    readme.includes(`packages/${WDR}`) &&
    typeof wdrPkg?.version === "string" &&
    readme.includes(wdrPkg.version),
  "CI defines a web-discord-rpc job that runs tests": ({ ci }) => {
    if (typeof ci !== "string" || !ci.includes(`${WDR}:`)) return false;
    const job = ci.slice(ci.indexOf(`${WDR}:`));
    return (
      /run:\s*npm test/.test(job) &&
      !/continue-on-error:\s*true/.test(job) &&
      !/if:\s*false/.test(job)
    );
  },
  "CI web job runs the native host selftest and both e2e scripts": ({ ci }) => {
    if (typeof ci !== "string" || !ci.includes(`${WDR}:`)) return false;
    const job = ci.slice(ci.indexOf(`${WDR}:`));
    return (
      job.includes("node native/host.mjs --selftest") &&
      job.includes("node scripts/e2e-arrpc.mjs") &&
      job.includes("node scripts/e2e-ipc.mjs")
    );
  },
  "release zips the package and attaches the zip": ({ release }) =>
    typeof release === "string" &&
    release.includes(`dist/${WDR}.zip`) &&
    release.includes(`(cd packages/${WDR} `),
  "every file in the release zip step exists": ({ release }) => {
    const files = zipFiles(release);
    if (!files) return false;
    return files.every((f) => {
      try {
        return statSync(join(ROOT, "packages", WDR, f)).isFile();
      } catch {
        return false;
      }
    });
  },
  "release zip contains every local file the manifest names": ({ release, manifest }) => {
    const files = zipFiles(release);
    const named = manifestLocalFiles(manifest);
    if (!files || !named || named.length === 0) return false;
    return named.every((f) => files.includes(f));
  },
};

function loadContext() {
  const parse = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  const rootRaw = read("package.json");
  const wdrRaw = read(`packages/${WDR}/package.json`);
  const manifestRaw = read(`packages/${WDR}/manifest.json`);
  return {
    rootPkg: rootRaw ? parse(rootRaw) : null,
    wdrPkg: wdrRaw ? parse(wdrRaw) : null,
    manifest: manifestRaw ? parse(manifestRaw) : null,
    readme: read("README.md"),
    ci: read(".github/workflows/ci.yml"),
    release: read(".github/workflows/release.yml"),
  };
}

function brokenContext() {
  return {
    rootPkg: { workspaces: ["packages/audio-normalizer"], scripts: { test: "exit 0" } },
    wdrPkg: {
      version: "0.0.0",
      scripts: { test: "node --test test/extension/config.test.mjs" },
    },
    readme: "# nothing here\n",
    manifest: null,
    ci: "jobs:\n  other:\n    steps: []\n",
    release: "steps: []\n",
  };
}

const names = Object.keys(predicates);

if (process.argv.includes("--prove-red")) {
  const ctx = brokenContext();
  // Filesystem predicates must go red too: run them against an empty root.
  const realRoot = ROOT;
  const emptyRoot = mkdtempSync(join(tmpdir(), "wdr-verify-red-"));
  let bad = 0;
  for (const name of names) {
    let checkCtx = ctx;
    if (name === "every file in the release zip step exists") {
      // A zip step that names a file that does not exist must fail.
      checkCtx = {
        ...ctx,
        release: `(cd packages/${WDR} && zip -r ../../dist/${WDR}.zip manifest.json no-such-file.js)\ngh release create x dist/${WDR}.zip`,
      };
    }
    if (name === "package test/ holds at least one test file") ROOT = emptyRoot;
    else ROOT = realRoot;
    let ok = false;
    try {
      ok = predicates[name](checkCtx);
    } catch {
      ok = false;
    }
    ROOT = realRoot;
    if (ok) {
      console.error(`PROVE-RED FAIL: ${JSON.stringify(name)} stayed green on a broken fixture`);
      bad += 1;
    } else {
      console.log(`prove-red: ${name} -> red as expected`);
    }
  }
  if (bad > 0) process.exit(1);
  console.log(`prove-red: ${names.length}/${names.length} checks can go red`);
  process.exit(0);
}

const ctx = loadContext();
const failures = [];
for (const name of names) {
  let ok = false;
  try {
    ok = predicates[name](ctx) === true;
  } catch {
    ok = false;
  }
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
  if (!ok) failures.push(name);
}
if (failures.length > 0) {
  console.error(`\nverify-integration: ${failures.length} wiring point(s) broken (root: ${ROOT})`);
  process.exit(1);
}
console.log(`\nverify-integration: ${names.length}/${names.length} wiring points hold`);
