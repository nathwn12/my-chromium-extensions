#!/usr/bin/env node
/**
 * One job: remove the native messaging host installed by install-host.mjs.
 *
 *   node scripts/uninstall-host.mjs [--check] [--json]
 *
 * --check reports presence without removing anything: exit 0 when the host is
 * already gone, exit 1 when any trace is still present.
 */

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HOST_NAME,
  REGISTRY_ROOTS,
  defaultExec,
  installPaths,
  registryDeleteArgs,
  registryQueryArgs,
} from './install-host.mjs';
import { REPO_ROOT } from './extension-key.mjs';

export async function inspectHost(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
  const exec = options.exec ?? defaultExec;
  const paths = installPaths({ root, localAppData });

  const checks = [];
  for (const [label, file] of [
    ['host.cmd', paths.cmd],
    ['host-manifest.json', paths.manifest],
  ]) {
    checks.push({ name: label, present: existsSync(file), detail: file });
  }
  for (const slot of REGISTRY_ROOTS) {
    const key = `${slot.key}\\${HOST_NAME}`;
    try {
      await exec(registryQueryArgs(key));
      checks.push({ name: `${slot.label} registry`, present: true, detail: key });
    } catch {
      checks.push({ name: `${slot.label} registry`, present: false, detail: key });
    }
  }

  return { checks, paths, present: checks.some((check) => check.present) };
}

export async function removeHost(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
  const exec = options.exec ?? defaultExec;
  const paths = installPaths({ root, localAppData });

  const removed = [];
  for (const slot of REGISTRY_ROOTS) {
    const key = `${slot.key}\\${HOST_NAME}`;
    try {
      await exec(registryDeleteArgs(key));
      removed.push({ name: `delete ${slot.label} registry`, ok: true, detail: key });
    } catch (error) {
      // A missing key is the desired end state, so it is not a failure here;
      // the read-back below decides whether anything survived.
      removed.push({ name: `delete ${slot.label} registry`, ok: true, detail: 'already absent' });
    }
  }

  try {
    await rm(paths.dir, { recursive: true, force: true });
    removed.push({ name: 'remove install dir', ok: true, detail: paths.dir });
  } catch (error) {
    removed.push({ name: 'remove install dir', ok: false, detail: error.message });
  }

  const after = await inspectHost({ root, localAppData, exec });
  const checks = [...removed, ...after.checks];
  return { ok: !after.present && removed.every((check) => check.ok), checks, paths };
}

/* --------------------------------------------------------------------- cli */

const USAGE = `usage: node scripts/uninstall-host.mjs [--check] [--json]

Removes the three native messaging registry keys and
%LOCALAPPDATA%\\web-discord-rpc. --check only reports presence.`;

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
    if (options.check) {
      const inspection = await inspectHost();
      result = {
        ok: !inspection.present,
        present: inspection.present,
        checks: inspection.checks,
        paths: inspection.paths,
      };
    } else {
      result = await removeHost();
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    for (const check of result.checks) {
      const state = 'present' in check ? (check.present ? 'PRESENT' : 'ABSENT') : check.ok ? 'PASS' : 'FAIL';
      process.stdout.write(`${state}  ${check.name}  ${check.detail ?? ''}\n`);
    }
  }
  return result.ok ? 0 : 1;
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
