#!/usr/bin/env node
/**
 * One job: copy one extension's runtime payload into a stable per-user folder.
 *
 *   node scripts/install-extension.mjs <pkg> [--check] [--uninstall]
 *                                      [--local-app-data <path>] [--json]
 *
 * Chrome stores an unpacked extension as a folder path. Loading it from the
 * checkout means a moved checkout breaks the extension. The stable target is
 * %LOCALAPPDATA%\<install-dir-name>\extension, so it never moves with the repo.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import {
  copyFile,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Explicit package list: no positional argument may become a path fragment. */
export const PACKAGES = Object.freeze([
  "audio-normalizer",
  "slowed-reverb",
  "crunchy-presence",
  "youtube-music-presence",
]);

const STATE_FILE = ".install-state.json";
const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".json", ".html", ".css"]);
const FILE_REF = /\.(?:js|mjs|cjs|json|html|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf)$/i;

const USAGE = `usage: node scripts/install-extension.mjs <pkg> [--check] [--uninstall]
                                    [--local-app-data <path>] [--json] [--help]

pkg: ${PACKAGES.join(", ")}
Copies the runtime into %LOCALAPPDATA%\\<name>\\extension and prints the
folder to load with chrome://extensions -> Load unpacked. --check verifies
without writing; --uninstall removes only that extension folder.`;

/** Manifest name to install-dir name: "Crunchy Presence" -> "crunchy-presence". */
export function slug(name) {
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isFile(target) {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

function localAppDataDir(localAppData, name) {
  if (typeof localAppData !== "string" || localAppData.length === 0) {
    throw new Error("LOCALAPPDATA is not set; pass --local-app-data <path>");
  }
  return path.join(localAppData, name, "extension");
}

/** Repo layout, then the unzipped-release layout (payload sits at the root). */
function resolvePackageDir(root, pkg) {
  if (!PACKAGES.includes(pkg)) throw new Error(`unknown package: ${pkg}`);
  const inRepo = path.join(root, "packages", pkg);
  if (isFile(path.join(inRepo, "manifest.json"))) return inRepo;
  if (isFile(path.join(root, "manifest.json"))) {
    const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
    if (slug(manifest.name) === pkg) return root;
  }
  throw new Error(`cannot find manifest.json for ${pkg} under ${root}`);
}

function readManifest(pkgDir) {
  const manifestPath = path.join(pkgDir, "manifest.json");
  return { manifestPath, manifest: JSON.parse(readFileSync(manifestPath, "utf8")) };
}

/** Every string in the manifest, so new reference fields are picked up. */
function manifestStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => manifestStrings(item, out));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => manifestStrings(item, out));
  return out;
}

function normalizeRef(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim().replace(/^\.\//, "");
  if (!value || /\s/.test(value)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  if (value.includes("*") || value.includes("?")) return null;
  if (value.startsWith("/") || value.split(/[\\/]/).includes("..")) return null;
  if (!FILE_REF.test(value)) return null;
  return value.replace(/\\/g, "/");
}

/** Remove comments but keep string literals, so doc mentions are not payload. */
function stripComments(text) {
  let out = "";
  let quote = null;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (quote) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 2;
      out += " ";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    out += char;
    index += 1;
  }
  return out;
}

/** String literals plus HTML attributes and CSS url() references. */
function referencedStrings(text) {
  const out = [];
  for (const match of text.matchAll(/(["'`])([^"'`\n]+)\1/g)) out.push(match[2]);
  for (const match of text.matchAll(/\b(?:src|href)\s*=\s*(["'])([^"']+)\1/g)) out.push(match[2]);
  for (const match of text.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)) out.push(match[2]);
  return out;
}

/**
 * Payload = manifest references plus the transitive closure of local files
 * named by those files. The generic string scan covers importScripts, ES
 * imports, chrome.runtime.getURL, executeScript files, HTML src/href, and CSS
 * url(). Every candidate is checked against the real package directory.
 */
export function resolvePayload(pkgDir) {
  const { manifest } = readManifest(pkgDir);
  for (const raw of manifestStrings(manifest)) {
    if (FILE_REF.test(raw) && /[*?]/.test(raw)) {
      throw new Error(`manifest names a glob the installer cannot expand: ${raw}`);
    }
  }

  const files = new Set(["manifest.json"]);
  for (const raw of manifestStrings(manifest)) {
    const rel = normalizeRef(raw);
    if (rel && isFile(path.join(pkgDir, ...rel.split("/")))) files.add(rel);
  }

  const queue = [...files].filter((rel) => TEXT_EXT.has(path.extname(rel).toLowerCase()));
  const scanned = new Set();
  while (queue.length > 0) {
    const rel = queue.shift();
    if (scanned.has(rel)) continue;
    scanned.add(rel);
    const text = stripComments(readFileSync(path.join(pkgDir, ...rel.split("/")), "utf8"));
    for (const raw of referencedStrings(text)) {
      const next = normalizeRef(raw);
      if (!next || files.has(next)) continue;
      if (!isFile(path.join(pkgDir, ...next.split("/")))) continue;
      files.add(next);
      if (TEXT_EXT.has(path.extname(next).toLowerCase())) queue.push(next);
    }
  }
  return [...files].sort();
}

function hashFile(target) {
  return createHash("sha256").update(readFileSync(target)).digest("hex");
}

function recordHashes(pkgDir, files) {
  return Object.fromEntries(
    files.map((rel) => [rel, hashFile(path.join(pkgDir, ...rel.split("/")))]),
  );
}

function sameSet(left, right) {
  return left.length === right.length && left.every((item) => right.includes(item));
}

export async function installExtension({
  root = REPO_ROOT,
  pkg,
  localAppData = process.env.LOCALAPPDATA,
} = {}) {
  const pkgDir = resolvePackageDir(root, pkg);
  const { manifestPath, manifest } = readManifest(pkgDir);
  const name = slug(manifest.name);
  const dir = localAppDataDir(localAppData, name);
  const files = resolvePayload(pkgDir);

  // Stale-file rule: wipe the dedicated extension dir before copying. An
  // overlay copy lets a file removed from the payload survive a shrink and
  // keep changing runtime behavior. Only this subdir is touched, never the
  // parent that holds the native host files.
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const rel of files) {
    const segments = rel.split("/");
    const dest = path.join(dir, ...segments);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(path.join(pkgDir, ...segments), dest);
  }

  const state = {
    format: 1,
    package: pkg,
    installDir: name,
    manifestHash: hashFile(manifestPath),
    files: recordHashes(pkgDir, files),
  };
  await writeFile(path.join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const verified = checkExtension({ root, pkg, localAppData });
  if (!verified.ok) {
    throw new Error(`post-install check failed: ${verified.checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}`);
  }
  return { pkg, name, dir, files, checks: verified.checks };
}

export function checkExtension({
  root = REPO_ROOT,
  pkg,
  localAppData = process.env.LOCALAPPDATA,
} = {}) {
  const pkgDir = resolvePackageDir(root, pkg);
  const { manifestPath, manifest } = readManifest(pkgDir);
  const name = slug(manifest.name);
  const dir = localAppDataDir(localAppData, name);
  const checks = [];
  const add = (check, ok, detail) => checks.push({ name: check, ok, detail });

  let state;
  try {
    state = JSON.parse(readFileSync(path.join(dir, STATE_FILE), "utf8"));
    add("install record", true, STATE_FILE);
  } catch (error) {
    add("install record", false, `missing or unreadable ${STATE_FILE}: ${error.message}`);
    return { ok: false, name, dir, checks };
  }

  add("record package", state.package === pkg, `${state.package}`);
  add("record install dir", state.installDir === name, `${state.installDir}`);
  const manifestHash = hashFile(manifestPath);
  add("manifest hash", state.manifestHash === manifestHash, manifestHash.slice(0, 12));

  const expected = resolvePayload(pkgDir);
  const recorded = state.files && typeof state.files === "object" ? Object.keys(state.files).sort() : [];
  add("file list", sameSet(expected, recorded), `${expected.length} files`);

  const recordedHashes = state.files ?? {};
  for (const rel of expected) {
    const segments = rel.split("/");
    const dest = path.join(dir, ...segments);
    const sourceHash = hashFile(path.join(pkgDir, ...segments));
    if (!isFile(dest)) {
      add(`payload ${rel}`, false, `missing ${dest}`);
      continue;
    }
    const destHash = hashFile(dest);
    const ok = destHash === sourceHash && recordedHashes[rel] === sourceHash;
    add(`payload ${rel}`, ok, ok ? sourceHash.slice(0, 12) : "hash mismatch with the recorded copy");
  }
  return { ok: checks.every((check) => check.ok), name, dir, checks };
}

export async function uninstallExtension({
  root = REPO_ROOT,
  pkg,
  localAppData = process.env.LOCALAPPDATA,
} = {}) {
  const pkgDir = resolvePackageDir(root, pkg);
  const { manifest } = readManifest(pkgDir);
  const name = slug(manifest.name);
  const dir = localAppDataDir(localAppData, name);
  await rm(dir, { recursive: true, force: true });
  return { pkg, name, dir };
}

function parseArgs(argv) {
  const options = { pkg: null, check: false, uninstall: false, localAppData: null, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") options.check = true;
    else if (arg === "--uninstall") options.uninstall = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--local-app-data") {
      options.localAppData = argv[++index];
      if (!options.localAppData) throw new Error("--local-app-data needs a path");
    } else if (arg.startsWith("--local-app-data=")) {
      options.localAppData = arg.slice("--local-app-data=".length);
      if (!options.localAppData) throw new Error("--local-app-data needs a path");
    } else if (arg.startsWith("-")) throw new Error(`unknown argument: ${arg}`);
    else if (options.pkg === null) options.pkg = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (!options.help && !options.pkg) throw new Error("missing package name");
  if (options.check && options.uninstall) throw new Error("--check and --uninstall are exclusive");
  return options;
}

function printChecks(checks) {
  for (const check of checks) {
    process.stdout.write(`${check.ok ? "PASS" : "FAIL"}  ${check.name}  ${check.detail ?? ""}\n`);
  }
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
  if (!localAppData) {
    process.stderr.write("LOCALAPPDATA is not set; pass --local-app-data <path>\n");
    return 2;
  }

  try {
    if (options.check) {
      const result = checkExtension({ pkg: options.pkg, localAppData });
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ ok: result.ok, dir: result.dir, checks: result.checks })}\n`);
      } else {
        printChecks(result.checks);
        process.stdout.write(`check: ${result.checks.filter((c) => c.ok).length}/${result.checks.length} hold\n`);
      }
      return result.ok ? 0 : 1;
    }
    if (options.uninstall) {
      const result = await uninstallExtension({ pkg: options.pkg, localAppData });
      process.stdout.write(`removed: ${result.dir}\n`);
      return 0;
    }
    const result = await installExtension({ pkg: options.pkg, localAppData });
    printChecks(result.checks);
    process.stdout.write(`Load unpacked: ${result.dir}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`install-extension: ${error.message}\n`);
    return 1;
  }
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
