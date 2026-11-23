#!/usr/bin/env node
/**
 * One job: install the native messaging host for YouTube Music Presence (Chrome, Edge, Brave).
 *
 *   node scripts/install-host.mjs [--check] [--json]
 *
 * `--check` verifies without writing. Every registry write is a `reg add` child
 * process; every verification reads the key's default value back.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { REPO_ROOT, deriveIdFromManifest } from './extension-key.mjs';

const execFileAsync = promisify(execFile);

export const HOST_NAME = 'com.nathwn12.youtube_music_presence';
export const INSTALL_DIR_NAME = 'youtube-music-presence';

/** Fixed runnable payload, copied into the install dir with its layout intact. */
export const PAYLOAD = Object.freeze([
  'native/host.mjs',
  'native/arrpc.mjs',
  'native/ipc.mjs',
  'native/native-framing.mjs',
  'config.js',
]);
/** Launcher target, resolved from the launcher's own directory by cmd.exe. */
export const HOST_SCRIPT_REL = 'native\\host.mjs';

export const REGISTRY_ROOTS = Object.freeze([
  { label: 'Chrome', key: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts' },
  { label: 'Edge', key: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts' },
  { label: 'Brave', key: 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts' },
]);

/** Default registry runner: one `reg` child process, no shell. */
export async function defaultExec(args) {
  try {
    const { stdout, stderr } = await execFileAsync('reg', args, { windowsHide: true });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const wrapped = new Error(
      `reg ${args[0]} failed (${error.code ?? 'unknown'}): ${
        (error.stderr || error.stdout || error.message).toString().trim().split('\n')[0]
      }`,
    );
    wrapped.code = typeof error.code === 'number' ? error.code : null;
    wrapped.stdout = (error.stdout ?? '').toString();
    throw wrapped;
  }
}

export function installPaths({ root = REPO_ROOT, localAppData = process.env.LOCALAPPDATA } = {}) {
  if (typeof localAppData !== 'string' || localAppData.length === 0) {
    throw new Error('LOCALAPPDATA is not set');
  }
  const dir = path.join(localAppData, INSTALL_DIR_NAME);
  return {
    dir,
    cmd: path.join(dir, 'host.cmd'),
    manifest: path.join(dir, 'host-manifest.json'),
    node: process.execPath,
  };
}

export function payloadFiles({ root, dir }) {
  return PAYLOAD.map((rel) => {
    const segments = rel.split('/');
    return { rel, source: path.join(root, ...segments), dest: path.join(dir, ...segments) };
  });
}

export function buildHostCmd({ nodePath }) {
  return `@echo off\r\nrem Chrome native messaging host for youtube-music-presence\r\nset "NODE_OPTIONS="\r\n"${nodePath}" "%~dp0${HOST_SCRIPT_REL}" %*\r\n`;
}

export function buildHostManifest({ hostPath, extensionId }) {
  return {
    name: HOST_NAME,
    description: 'YouTube Music Presence native messaging host',
    path: hostPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

export function registryAddArgs(key, manifestPath) {
  return ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'];
}

export function registryQueryArgs(key) {
  return ['query', key, '/ve'];
}

export function registryDeleteArgs(key) {
  return ['delete', key, '/f'];
}

async function checkFile(label, filePath) {
  if (!existsSync(filePath)) return { name: label, ok: false, detail: `missing ${filePath}` };
  return { name: label, ok: true, detail: filePath };
}

async function copyPayload({ root, dir }) {
  const copied = [];
  for (const { rel, source, dest } of payloadFiles({ root, dir })) {
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(source, dest);
    copied.push({ name: `copy ${rel}`, ok: true, detail: dest });
  }
  return copied;
}

async function checkPayload({ root, dir }) {
  const checks = [];
  for (const { rel, dest } of payloadFiles({ root, dir })) {
    checks.push(await checkFile(`payload ${rel}`, dest));
  }
  return checks;
}

async function checkLauncher({ cmd, root }) {
  let content;
  try {
    content = await readFile(cmd, 'utf8');
  } catch (error) {
    return { name: 'host.cmd self-contained', ok: false, detail: error.message };
  }
  const problems = [];
  if (!content.includes(`%~dp0${HOST_SCRIPT_REL}`)) {
    problems.push('script target does not resolve from host.cmd');
  }
  if (content.includes(root)) problems.push('launcher names the source checkout');
  return problems.length === 0
    ? { name: 'host.cmd self-contained', ok: true, detail: `%~dp0${HOST_SCRIPT_REL}` }
    : { name: 'host.cmd self-contained', ok: false, detail: problems.join(', ') };
}

async function checkManifest(paths, extensionId) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(paths.manifest, 'utf8'));
  } catch (error) {
    return { name: 'host-manifest.json', ok: false, detail: error.message };
  }
  const problems = [];
  if (manifest.name !== HOST_NAME) problems.push(`name=${manifest.name}`);
  if (manifest.type !== 'stdio') problems.push(`type=${manifest.type}`);
  if (manifest.path !== paths.cmd) problems.push(`path=${manifest.path}`);
  const origin = `chrome-extension://${extensionId}/`;
  if (!Array.isArray(manifest.allowed_origins) || !manifest.allowed_origins.includes(origin)) {
    problems.push(`allowed_origins=${JSON.stringify(manifest.allowed_origins)}`);
  }
  return problems.length === 0
    ? { name: 'host-manifest.json', ok: true, detail: origin }
    : { name: 'host-manifest.json', ok: false, detail: problems.join(', ') };
}

export async function verifyHost({ paths, extensionId, exec = defaultExec, root = REPO_ROOT }) {
  const checks = [];
  checks.push(await checkFile('host.cmd', paths.cmd));
  checks.push(await checkManifest(paths, extensionId));
  checks.push(await checkLauncher({ cmd: paths.cmd, root }));
  checks.push(...await checkPayload({ root, dir: paths.dir }));
  for (const slot of REGISTRY_ROOTS) {
    const key = `${slot.key}\\${HOST_NAME}`;
    try {
      const { stdout } = await exec(registryQueryArgs(key));
      const ok = stdout.toLowerCase().includes(paths.manifest.toLowerCase());
      checks.push({ name: `${slot.label} registry`, ok, detail: ok ? key : `default value is not ${paths.manifest}` });
    } catch (error) {
      checks.push({ name: `${slot.label} registry`, ok: false, detail: error.message });
    }
  }
  return checks;
}

export async function installHost(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
  const exec = options.exec ?? defaultExec;
  const checkOnly = options.check === true;

  const derived = deriveIdFromManifest(path.join(root, 'manifest.json'));
  if (!derived.ok) throw new Error(derived.error);
  const extensionId = derived.id;
  const paths = installPaths({ root, localAppData });

  const checks = [];
  if (!checkOnly) {
    await mkdir(paths.dir, { recursive: true });
    checks.push(...await copyPayload({ root, dir: paths.dir }));
    await writeFile(
      paths.cmd,
      buildHostCmd({ nodePath: paths.node }),
      'utf8',
    );
    await writeFile(
      paths.manifest,
      `${JSON.stringify(buildHostManifest({ hostPath: paths.cmd, extensionId }), null, 2)}\n`,
      'utf8',
    );
    checks.push({ name: 'write host.cmd', ok: true, detail: paths.cmd });
    checks.push({ name: 'write host-manifest.json', ok: true, detail: paths.manifest });

    for (const slot of REGISTRY_ROOTS) {
      const key = `${slot.key}\\${HOST_NAME}`;
      try {
        await exec(registryAddArgs(key, paths.manifest));
        checks.push({ name: `register ${slot.label}`, ok: true, detail: key });
      } catch (error) {
        checks.push({ name: `register ${slot.label}`, ok: false, detail: error.message });
      }
    }
  }

  const verified = await verifyHost({ paths, extensionId, exec, root });
  const all = [...checks, ...verified];
  return { ok: all.every((check) => check.ok), checks: all, paths, extensionId };
}


const USAGE = `usage: node scripts/install-host.mjs [--check] [--json]

Writes %LOCALAPPDATA%\\${INSTALL_DIR_NAME}\\host.cmd + host-manifest.json and
registers the host for Chrome, Edge and Brave. --check verifies without writing.`;

function parseArgs(argv) {
  const options = { check: false, json: false, help: false };
  for (const arg of argv) {
    if (arg === '--check') options.check = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function printTable(checks) {
  for (const check of checks) {
    process.stdout.write(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}  ${check.detail ?? ''}\n`);
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

  let result;
  try {
    result = await installHost({ check: options.check });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ ok: result.ok, extensionId: result.extensionId, checks: result.checks })}\n`,
    );
  } else {
    printTable(result.checks);
    process.stdout.write(`extension id: ${result.extensionId}\nhost manifest: ${result.paths.manifest}\n`);
  }
  return result.ok ? 0 : 1;
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
