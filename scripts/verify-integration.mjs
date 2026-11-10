#!/usr/bin/env node
// Verify the root workspace wires in packages/web-discord-rpc.
// Each wiring point is a predicate with a negative self-test, so a check
// that cannot go red cannot ship: breaking any wiring point fails this script.
// Usage: node scripts/verify-integration.mjs [--prove-red]
//   --prove-red runs the predicates against broken fixtures and exits 0 only
//   when every predicate fails there (proves each check can go red).
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

// Playwright is banned in this repo: Gladius is the only browser tester, and a
// stray dependency or import reinstalls a Chromium download on every install.
// Each clause of the ban is a predicate, so one lockfile entry or one import
// fails this script by name instead of quietly coming back.
// The names are spelled in pieces so this guard file passes its own scan: no
// path is exempt from the ban, this one included.
const PW = "play" + "wright";
const PLAYWRIGHT = [PW, `${PW}-core`, `@${PW}/test`];
const PLAYWRIGHT_SPECIFIER =
  /["'](?:@playwright\/test|playwright-core|playwright)(?:\/[^"']*)?["']/;

// Directories that hold state or dependencies rather than source: node_modules
// is installed output, .git is history, .stack is this workbench's own notes
// (which discuss the ban and must not be mistaken for an import).
const SCAN_EXCLUDED_DIRS = new Set(["node_modules", ".git", ".stack"]);

// Assets a specifier cannot be written in, and which read as noise in UTF-8:
// images, web fonts, archives and PDFs. Everything else is source.
const SCAN_ASSET_EXTENSIONS = new Set([
  ".png", ".ico", ".jpg", ".jpeg", ".gif", ".webp",
  ".woff", ".woff2", ".ttf", ".zip", ".pdf",
]);

// Every path a commit would carry: tracked files plus untracked files that no
// ignore rule covers. Ignored output (installed packages, media fixtures,
// stale per-package lockfiles) is not repository source, and git is the only
// authority on which is which -- no path is exempted by name here.
function commitSurface() {
  const raw = execFileSync(
    "git",
    ["-C", ROOT, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true }
  );
  return new Set(raw.split("\0").filter(Boolean));
}

// Strict walk: no catch. An unreadable directory or entry throws, and the
// error carries the path, so the scan fails by name instead of passing.
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

// Every file the ban can appear in: the manifests that declare it, the sources
// that import it, and the CI steps that would install it. The tree walk decides
// what exists on disk; the commit surface decides what is source.
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

// The root README is the only list of every extension: each row is a package
// link plus a version cell. Both are checkable against the manifests, so a new
// package, a deleted row, or a stale version fails here by name.
const README_ROW = /^\|\s*\[[^\]]+\]\(packages\/([^)/]+)\)\s*\|[^|]*\|\s*(\S+)\s*\|\s*$/gm;
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

function readmeRows(readme) {
  const rows = new Map();
  for (const match of readme.matchAll(README_ROW)) rows.set(match[1], match[2]);
  return rows;
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
      .filter((pkg) => rows.get(pkg.name) !== pkg.version)
      .map((pkg) => `${pkg.name}: README ${rows.get(pkg.name) ?? "missing"} vs manifest ${pkg.version}`);
    return bad.length === 0 ? true : bad.join("; ");
  },
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
    if (!lock?.packages) return "no lockfile was read";
    const bad = [];
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (/(^|\/)node_modules\/(@playwright\/test|playwright|playwright-core)$/.test(key))
        bad.push(key);
      const deps = {
        ...entry?.dependencies,
        ...entry?.devDependencies,
        ...entry?.optionalDependencies,
        ...entry?.peerDependencies,
      };
      for (const name of PLAYWRIGHT) {
        if (name in deps) bad.push(`${key || "<root>"} -> ${name}`);
      }
    }
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
  // Every directory under packages/ that carries a manifest is an extension the
  // root README must list. The directory name is the path segment the README links.
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
        return JSON.parse(read("package-lock.json") ?? "null");
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
  // Filesystem predicates must go red too: run them against an empty root.
  const realRoot = ROOT;
  const emptyRoot = mkdtempSync(join(tmpdir(), "wdr-verify-red-"));
  let bad = 0;
  // The walker must see the file types the old .js/.ts filter missed. Plant a
  // quoted specifier in an .html file inside the real tree, watch the real scan
  // fail by name, then remove it so the tree is left as it was found.
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
      // A zip step that names a file that does not exist must fail.
      checkCtx = {
        ...ctx,
        release: `(cd packages/${WDR} && zip -r ../../dist/${WDR}.zip manifest.json no-such-file.js)\ngh release create x dist/${WDR}.zip`,
      };
    }
    if (name === "no source or CI step imports Playwright") {
      // A planted import must fail by name. The path is the one the old skip
      // hid, so a returning skip shows up here as a check that stayed green.
      const planted = ["import { chromium } from '", PW, "-core';\n"].join("");
      checkCtx = {
        ...ctx,
        sources: [
          { path: "packages/crunchy-presence/scripts/e2e-live.mjs", text: planted },
        ],
      };
    }
    if (name === "the Playwright scan reads every source file") {
      // An unreadable path must fail by name, not pass silently.
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
      // The stated count and the row count both say two, but only one row is
      // present: the missing row alone must turn the check red.
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
    if (name === "README lists each package at its manifest version") {
      // A single stale version cell must fail by name.
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
