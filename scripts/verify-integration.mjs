#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let ROOT = process.env.WDR_VERIFY_ROOT
  ? resolve(process.env.WDR_VERIFY_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WDR = "youtube-music-presence";

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

const PW = "play" + "wright";
const PLAYWRIGHT = [PW, `${PW}-core`, `@${PW}/test`];
const PLAYWRIGHT_SPECIFIER =
  /["'](?:@playwright\/test|playwright-core|playwright)(?:\/[^"']*)?["']/;

const SCAN_EXCLUDED_DIRS = new Set(["node_modules", ".git", ".stack"]);

const SCAN_ASSET_EXTENSIONS = new Set([
  ".png", ".ico", ".jpg", ".jpeg", ".gif", ".webp",
  ".woff", ".woff2", ".ttf", ".zip", ".pdf",
]);

function commitSurface() {
  const raw = execFileSync(
    "git",
    ["-C", ROOT, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true }
  );
  return new Set(raw.split("\0").filter(Boolean));
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    if (SCAN_EXCLUDED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (!SCAN_ASSET_EXTENSIONS.has(extname(entry).toLowerCase()))
      out.push(full);
  }
  return out;
}

function collectPlaywrightSurface() {
  const scan = { walked: 0, files: 0, failures: [] };
  let surface = new Set();
  try {
    surface = commitSurface();
  } catch (error) {
    scan.failures.push({
      path: ROOT,
      reason: `git ls-files: ${error?.code ?? error?.message ?? error}`,
    });
  }
  const paths = [];
  try {
    walk(ROOT, paths);
  } catch (error) {
    scan.failures.push({
      path: error?.path ?? ROOT,
      reason: error?.code ?? String(error?.message ?? error),
    });
  }
  scan.walked = paths.length;
  const manifests = [];
  const sources = [];
  for (const full of paths) {
    const path = full.slice(ROOT.length + 1).replace(/\\/g, "/");
    if (!surface.has(path)) continue;
    scan.files += 1;
    let text;
    try {
      text = readFileSync(full, "utf8");
    } catch (error) {
      scan.failures.push({ path, reason: error?.code ?? String(error?.message ?? error) });
      continue;
    }
    sources.push({ path, text });
    if (/(^|\/)package\.json$/.test(path)) {
      let pkg = null;
      try {
        pkg = JSON.parse(text);
      } catch {
        pkg = null;
      }
      manifests.push({ path, pkg });
    }
  }
  return { manifests, sources, scan };
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

const README_ROW = /^\|\s*\[[^\]]+\]\(packages\/([^)/]+)\)\s*\|[^|]*\|\s*(\S+)\s*\|\s*$/gm;
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

function readmeRows(readme) {
  const rows = new Map();
  for (const match of readme.matchAll(README_ROW)) rows.set(match[1], match[2]);
  return rows;
}

const predicates = {
  "workspaces cover packages/*": ({ rootPkg }) => {
    if (!rootPkg?.workspaces || !Array.isArray(rootPkg.workspaces)) return false;
    return rootPkg.workspaces.some(
      (w) => w === "packages/*" || w === `packages/${WDR}`
    );
  },
  "root test script runs the youtube-music-presence workspace": ({ rootPkg }) =>
    typeof rootPkg?.scripts?.test === "string" &&
    rootPkg.scripts.test.includes(WDR),
  "package test script runs every test under test/": ({ wdrPkg }) => {
    const script = wdrPkg?.scripts?.test;
    if (typeof script !== "string") return false;
    if (!/(run-tests\.mjs\s+test|node\s+--test\s+test\/?(\s|$|"))/.test(script))
      return false;
    return true;
  },
  "package test/ holds at least one test file": () =>
    collectTests(join(ROOT, "packages", WDR, "test")).length > 0,
  "README names the package with its version": ({ readme, wdrPkg }) =>
    typeof readme === "string" &&
    readme.includes(`[manifest](packages/${WDR}/manifest.json)`) &&
    typeof wdrPkg?.version === "string" &&
    existsSync(join(ROOT, "packages", WDR, "manifest.json")),
  "README lists every package once": ({ readme, packages }) => {
    if (typeof readme !== "string" || !Array.isArray(packages) || packages.length === 0)
      return false;
    const rows = [...readmeRows(readme).keys()].sort();
    const dirs = packages.map((pkg) => pkg.name).sort();
    if (rows.join(",") !== dirs.join(",")) {
      return `README rows are [${rows.join(", ")}]; packages are [${dirs.join(", ")}]`;
    }
    const stated = /^(\w+) Chromium extensions/m.exec(readme)?.[1]?.toLowerCase();
    const expected = NUMBER_WORDS[packages.length];
    if (stated !== expected) {
      return `README says ${stated ?? "no count"}; there are ${packages.length} packages`;
    }
    return true;
  },
  "README lists each package at its manifest version": ({ readme, packages }) => {
    if (typeof readme !== "string" || !Array.isArray(packages) || packages.length === 0)
      return false;
    const rows = readmeRows(readme);
    const bad = packages
      .filter((pkg) => rows.get(pkg.name) !== `[manifest](packages/${pkg.name}/manifest.json)`)
      .map((pkg) => `${pkg.name}: README cell ${rows.get(pkg.name) ?? "missing"} does not cite its manifest`);
    return bad.length === 0 ? true : bad.join("; ");
  },
  "CI defines a youtube-music-presence job that runs tests": ({ ci }) => {
    if (typeof ci !== "string" || !ci.includes(`${WDR}:`)) return false;
    const job = ci.slice(ci.indexOf(`${WDR}:`));
    return (
      /run:\s*(npm|bun run) test/.test(job) &&
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
  "no package.json declares Playwright": ({ manifests }) => {
    if (!manifests || manifests.length === 0) return "no package.json was read";
    const bad = manifests
      .filter(({ pkg }) =>
        [
          pkg?.dependencies,
          pkg?.devDependencies,
          pkg?.optionalDependencies,
          pkg?.peerDependencies,
        ].some((deps) => deps && PLAYWRIGHT.some((name) => name in deps))
      )
      .map(({ path }) => path);
    return bad.length === 0 ? true : `declares Playwright: ${bad.join(", ")}`;
  },
  "the lockfile resolves no Playwright package": ({ lock }) => {
    if (typeof lock !== "string" || lock.length === 0) return "no lockfile was read";
    const bad = PLAYWRIGHT.filter((name) =>
      new RegExp(`"${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`).test(lock),
    );
    return bad.length === 0 ? true : `lockfile names Playwright: ${bad.join(", ")}`;
  },
  "the Playwright scan reads every source file": ({ scan }) => {
    if (!scan || !Array.isArray(scan.failures)) return "the scan did not report itself";
    if (scan.failures.length > 0)
      return `unreadable: ${scan.failures
        .map(({ path, reason }) => `${path} (${reason})`)
        .join("; ")}`;
    return scan.files > 0 ? true : "no source file was read";
  },
  "no source or CI step imports Playwright": ({ sources }) => {
    if (!sources) return "no sources were read";
    const bad = sources
      .filter(({ text }) => PLAYWRIGHT_SPECIFIER.test(text))
      .map(({ path }) => path);
    return bad.length === 0 ? true : `imports Playwright: ${bad.join(", ")}`;
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
  const packages = (() => {
    let entries;
    try {
      entries = readdirSync(join(ROOT, "packages"));
    } catch {
      return [];
    }
    const out = [];
    for (const entry of entries.sort()) {
      const raw = read(`packages/${entry}/manifest.json`);
      if (raw === null) continue;
      try {
        const version = JSON.parse(raw)?.version;
        if (typeof version === "string") out.push({ name: entry, version });
      } catch {
        continue;
      }
    }
    return out;
  })();
  return {
    rootPkg: rootRaw ? parse(rootRaw) : null,
    wdrPkg: wdrRaw ? parse(wdrRaw) : null,
    manifest: manifestRaw ? parse(manifestRaw) : null,
    packages,
    readme: read("README.md"),
    ci: read(".github/workflows/ci.yml"),
    release: read(".github/workflows/release.yml"),
    lock: (() => {
      try {
        return read("bun.lock") ?? null;
      } catch {
        return null;
      }
    })(),
    ...collectPlaywrightSurface(),
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
  const realRoot = ROOT;
  const emptyRoot = mkdtempSync(join(tmpdir(), "wdr-verify-red-"));
  let bad = 0;
  const plantedDir = mkdtempSync(join(realRoot, ".prove-red-scan-"));
  const plantedFile = join(plantedDir, "planted.html");
  const plantedRel = plantedFile.slice(realRoot.length + 1).replace(/\\/g, "/");
  writeFileSync(
    plantedFile,
    ["<script type=\"module\">import { chromium } from '", PW, "-core';</script>\n"].join("")
  );
  let plantedResult;
  try {
    plantedResult = predicates["no source or CI step imports Playwright"](
      collectPlaywrightSurface()
    );
  } finally {
    rmSync(plantedDir, { recursive: true, force: true });
  }
  if (plantedResult !== true && String(plantedResult).includes(plantedRel)) {
    console.log(`prove-red: a planted .html specifier -> red by name (${plantedRel})`);
  } else {
    console.error(
      `PROVE-RED FAIL: a planted .html specifier did not fail by name: ${String(plantedResult)}`
    );
    bad += 1;
  }
  if (existsSync(plantedDir)) {
    console.error(`PROVE-RED FAIL: the planted fixture was not removed: ${plantedDir}`);
    bad += 1;
  } else {
    console.log("prove-red: the planted .html fixture was removed, tree unchanged");
  }
  for (const name of names) {
    let checkCtx = ctx;
    if (name === "every file in the release zip step exists") {
      checkCtx = {
        ...ctx,
        release: `(cd packages/${WDR} && zip -r ../../dist/${WDR}.zip manifest.json no-such-file.js)\ngh release create x dist/${WDR}.zip`,
      };
    }
    if (name === "no source or CI step imports Playwright") {
      const planted = ["import { chromium } from '", PW, "-core';\n"].join("");
      checkCtx = {
        ...ctx,
        sources: [
          { path: "packages/crunchy-presence/scripts/e2e-live.mjs", text: planted },
        ],
      };
    }
    if (name === "the Playwright scan reads every source file") {
      checkCtx = {
        ...ctx,
        scan: {
          walked: 4,
          files: 3,
          failures: [
            { path: "packages/audio-normalizer/locked", reason: "EACCES" },
          ],
        },
      };
    }
    if (name === "README lists every package once") {
      checkCtx = {
        ...ctx,
        readme: [
          "Two Chromium extensions.",
          "",
          "| Extension | What it does | Version |",
          "| --- | --- | --- |",
          "| [Audio Normalizer](packages/audio-normalizer) | loudness | 5.4.3 |",
          "",
        ].join("\n"),
        packages: [
          { name: "audio-normalizer", version: "5.4.3" },
          { name: "crunchy-presence", version: "1.2.0" },
        ],
      };
    }
    if (name === "README names the package with its version") {
      checkCtx = {
        ...ctx,
        readme: `| [YouTube Music Presence](packages/${WDR}) | presence | [manifest](packages/${WDR}/package.json) |\n`,
      };
    }
    if (name === "README lists each package at its manifest version") {
      checkCtx = {
        ...ctx,
        readme: "| [Slowed Reverb](packages/slowed-reverb) | slow | 1.0.3 |\n",
        packages: [{ name: "slowed-reverb", version: "1.1.0" }],
      };
    }
    if (name === "package test/ holds at least one test file") ROOT = emptyRoot;
    else ROOT = realRoot;
    let ok = false;
    try {
      ok = predicates[name](checkCtx) === true;
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
console.log(
  `scan: ${ctx.scan.files} tracked source files read from ${ctx.scan.walked} on disk ` +
    `(${ctx.sources.filter(({ path }) => path.endsWith(".html")).length} .html); ` +
    `${ctx.scan.failures.length} unreadable`
);
const failures = [];
for (const name of names) {
  let result = false;
  try {
    result = predicates[name](ctx);
  } catch {
    result = false;
  }
  const ok = result === true;
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
  if (!ok) {
    if (typeof result === "string") console.error(`  ${name}: ${result}`);
    failures.push(name);
  }
}
if (failures.length > 0) {
  console.error(`\nverify-integration: ${failures.length} wiring point(s) broken (root: ${ROOT})`);
  process.exit(1);
}
console.log(`\nverify-integration: ${names.length}/${names.length} wiring points hold`);
