import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  deriveIdFromManifest,
  ensureKey,
  extensionIdFromDer,
  extensionIdFromKey,
} from '../../scripts/extension-key.mjs';
import {
  HOST_NAME,
  REGISTRY_ROOTS,
  buildHostCmd,
  buildHostManifest,
  installHost,
  installPaths,
  registryAddArgs,
  verifyHost,
} from '../../scripts/install-host.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// A real 2048-bit SPKI public key and the ID Chrome derives from it.
const FIXTURE_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxB0a4bZDIwpOqpLUZX/Ts/ZGLikMWY5mnBKK+8PJmeyiwVeMhokLqjLqHBR7QyywF+5bkuGuKyL7jwwgY9vD+DlxvLt5Qdt5GDNzdm/KeS1bw3yzIy1OTosUCSLhbk7zNgLIQAB8zjkqEuchyeUDTu5lmpqtbiPwK3VyYBwQGxfUdkuFHAqKWW8syX4ZUC4ejM980k+qTlHBsMuU8e6v0Rbl8ROQTLKesxKzsN9zQoTgIeWkRl6fakXTcaFoPbSqOc/nThEja5Ke9LUZIKY48LJQ6m/K3LbjXKczS2H5Jmo86sNwvJXut8y/dN8D3GfYum5B0X/pyBOxYkE37+DyzwIDAQAB';
const FIXTURE_ID = 'hhbjhcmpjldibcbeiogfnaohjnnmppgk';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'crp-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function tempManifest(t, manifest) {
  const dir = await tempDir(t);
  const file = path.join(dir, 'manifest.json');
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return file;
}

/** Fake `reg` runner: records argv, keeps the default value in memory. */
function fakeRegistry() {
  const calls = [];
  const state = { value: null };
  const exec = async (args) => {
    calls.push(args);
    if (args[0] === 'add') {
      state.value = args[args.indexOf('/d') + 1];
      return { stdout: '', stderr: '', code: 0 };
    }
    if (args[0] === 'query') {
      if (!state.value) {
        const error = new Error('reg query failed: unable to find the specified registry key');
        error.code = 1;
        throw error;
      }
      return {
        stdout: `\r\n${args[1]}\r\n    (Default)    REG_SZ    ${state.value}\r\n\r\n`,
        stderr: '',
        code: 0,
      };
    }
    if (args[0] === 'delete') {
      state.value = null;
      return { stdout: '', stderr: '', code: 0 };
    }
    throw new Error(`unexpected reg verb: ${args[0]}`);
  };
  return { exec, calls, state };
}

/* ------------------------------------------------------------------- ids */

test('derives the fixture extension id from its SPKI key', () => {
  assert.equal(extensionIdFromKey(FIXTURE_KEY), FIXTURE_ID);
  assert.match(FIXTURE_ID, /^[a-p]{32}$/);
  assert.equal(extensionIdFromKey(FIXTURE_KEY).length, 32);
});

test('deriveIdFromManifest reads the key and reports a missing one', async (t) => {
  const withKey = await tempManifest(t, { manifest_version: 3, key: FIXTURE_KEY });
  const derived = deriveIdFromManifest(withKey);
  assert.equal(derived.ok, true);
  assert.equal(derived.id, FIXTURE_ID);

  const withoutKey = await tempManifest(t, { manifest_version: 3, name: 'no key' });
  const missing = deriveIdFromManifest(withoutKey);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no "key"/);

  const absent = deriveIdFromManifest(path.join(path.dirname(withoutKey), 'nope.json'));
  assert.equal(absent.ok, false);
});

test('ensureKey never overwrites an existing key', async (t) => {
  const file = await tempManifest(t, { manifest_version: 3, key: FIXTURE_KEY, name: 'kept' });
  const before = await readFile(file, 'utf8');
  const result = ensureKey(file);
  const after = await readFile(file, 'utf8');

  assert.equal(result.ok, true);
  assert.equal(result.created, false);
  assert.equal(result.id, FIXTURE_ID);
  assert.equal(after, before);
});

test('ensureKey generates a 2048-bit key once and preserves the rest of the manifest', async (t) => {
  const file = await tempManifest(t, { manifest_version: 3, name: 'generated', version: '1.2.3' });
  const result = ensureKey(file);
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.match(result.id, /^[a-p]{32}$/);

  const manifest = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(manifest.name, 'generated');
  assert.equal(manifest.version, '1.2.3');
  assert.equal(manifest.key, result.key);
  assert.equal(extensionIdFromDer(Buffer.from(manifest.key, 'base64')), result.id);
  assert.ok(Buffer.from(manifest.key, 'base64').length > 250, 'DER SPKI is a full RSA-2048 key');

  const again = ensureKey(file);
  assert.equal(again.created, false);
  assert.equal(again.id, result.id);
});

test('--print emits the id on its own line', async (t) => {
  const file = await tempManifest(t, { manifest_version: 3, key: FIXTURE_KEY });
  const { stdout } = await execFileAsync(
    process.execPath,
    [path.join(REPO_ROOT, 'scripts', 'extension-key.mjs'), '--print', '--manifest', file],
    { cwd: REPO_ROOT },
  );
  const firstLine = stdout.split('\n')[0].trim();
  assert.match(firstLine, /^[a-p]{32}$/);
  assert.equal(firstLine, FIXTURE_ID);
  assert.match(stdout, /key: /);
});

/* --------------------------------------------------------------- installer */

test('host manifest and launcher are built from absolute paths', () => {
  const paths = installPaths({ root: 'Q:\\repo', localAppData: 'C:\\Users\\x\\AppData\\Local' });
  const manifest = buildHostManifest({ hostPath: paths.cmd, extensionId: FIXTURE_ID });
  assert.equal(manifest.name, HOST_NAME);
  assert.equal(manifest.type, 'stdio');
  assert.equal(manifest.path, paths.cmd);
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${FIXTURE_ID}/`]);

  const cmd = buildHostCmd({ nodePath: paths.node, hostScript: paths.hostScript });
  assert.match(cmd, /^@echo off\r\n/);
  assert.ok(cmd.includes(`"${process.execPath}"`));
  assert.ok(cmd.includes('native\\host.mjs'));
  assert.ok(cmd.trimEnd().endsWith('%*'));
});

test('registry argv pins the default value to the host manifest', () => {
  const key = `${REGISTRY_ROOTS[0].key}\\${HOST_NAME}`;
  assert.deepEqual(registryAddArgs(key, 'C:\\dir\\host-manifest.json'), [
    'add',
    key,
    '/ve',
    '/t',
    'REG_SZ',
    '/d',
    'C:\\dir\\host-manifest.json',
    '/f',
  ]);
});

test('installHost writes both files and registers all three browsers', async (t) => {
  const root = await tempDir(t);
  await writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({ manifest_version: 3, name: 'ext', version: '1.0.0', key: FIXTURE_KEY }),
    'utf8',
  );
  const localAppData = await tempDir(t);
  const registry = fakeRegistry();

  const result = await installHost({ root, localAppData, exec: registry.exec });
  assert.equal(result.ok, true);
  assert.equal(result.extensionId, FIXTURE_ID);

  const paths = installPaths({ root, localAppData });
  assert.equal(existsSync(paths.cmd), true);
  assert.equal(existsSync(paths.manifest), true);

  const written = JSON.parse(await readFile(paths.manifest, 'utf8'));
  assert.equal(written.allowed_origins[0], `chrome-extension://${FIXTURE_ID}/`);
  assert.equal(written.path, paths.cmd);
  assert.equal(written.type, 'stdio');

  const cmd = await readFile(paths.cmd, 'utf8');
  assert.ok(cmd.includes(`"${process.execPath}"`));
  assert.ok(cmd.includes('host.mjs'));

  const adds = registry.calls.filter((args) => args[0] === 'add');
  assert.equal(adds.length, 3);
  assert.deepEqual(
    adds.map((args) => args[1]),
    REGISTRY_ROOTS.map((slot) => `${slot.key}\\${HOST_NAME}`),
  );
  for (const args of adds) {
    assert.equal(args[args.indexOf('/d') + 1], paths.manifest);
  }
});

test('installHost --check writes nothing and reports a missing install', async (t) => {
  const root = await tempDir(t);
  await writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({ manifest_version: 3, key: FIXTURE_KEY }),
    'utf8',
  );
  const localAppData = await tempDir(t);
  const registry = fakeRegistry();

  const result = await installHost({ root, localAppData, exec: registry.exec, check: true });
  assert.equal(result.ok, false);
  assert.equal(registry.calls.filter((args) => args[0] === 'add').length, 0);
  assert.equal(existsSync(path.join(localAppData, 'crunchyroll-discord-presence')), false);
});

test('verifyHost fails when a registry default points somewhere else', async (t) => {
  const root = await tempDir(t);
  await writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({ manifest_version: 3, key: FIXTURE_KEY }),
    'utf8',
  );
  const localAppData = await tempDir(t);
  const registry = fakeRegistry();
  await installHost({ root, localAppData, exec: registry.exec });
  const paths = installPaths({ root, localAppData });

  registry.state.value = 'C:\\somewhere\\else\\host-manifest.json';
  const checks = await verifyHost({ paths, extensionId: FIXTURE_ID, exec: registry.exec });
  const registryChecks = checks.filter((check) => check.name.endsWith('registry'));
  assert.equal(registryChecks.length, 3);
  assert.equal(registryChecks.every((check) => check.ok === false), true);
  assert.equal(checks.find((check) => check.name === 'host.cmd').ok, true);
});
