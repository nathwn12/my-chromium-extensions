import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
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
import { removeHost } from '../../scripts/uninstall-host.mjs';

function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALL_DIR_NAME = 'crunchy-presence';
const PAYLOAD = [
  'native/host.mjs',
  'native/arrpc.mjs',
  'native/ipc.mjs',
  'native/protocol.mjs',
  'bridge-status.js',
  'package.json',
];

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

const payloadPath = (root, rel) => path.join(root, ...rel.split('/'));

/** Stand-in payload for tests that only exercise install wiring, not execution. */
async function seedPayload(root) {
  for (const rel of PAYLOAD) {
    const dest = payloadPath(root, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, `// fixture ${rel}\n`, 'utf8');
  }
}

/** Real, runnable copy of the package so the relocated launcher can self-test. */
async function seedRealPayload(root) {
  for (const rel of PAYLOAD) {
    const dest = payloadPath(root, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(payloadPath(REPO_ROOT, rel), dest);
  }
  await copyFile(path.join(REPO_ROOT, 'manifest.json'), path.join(root, 'manifest.json'));
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


test('host manifest pins the launcher and the launcher resolves the host from its own location', () => {
  const paths = installPaths({ root: 'Q:\\repo', localAppData: 'C:\\example\\AppData\\Local' });
  const manifest = buildHostManifest({ hostPath: paths.cmd, extensionId: FIXTURE_ID });
  assert.equal(manifest.name, HOST_NAME);
  assert.equal(manifest.type, 'stdio');
  assert.equal(manifest.path, paths.cmd);
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${FIXTURE_ID}/`]);

  const cmd = buildHostCmd({ nodePath: paths.node });
  assert.match(cmd, /^@echo off\r\n/);
  assert.match(cmd, /set "NODE_OPTIONS="\r\n/);
  assert.ok(cmd.includes(`"${process.execPath}"`));
  assert.ok(cmd.includes('"%~dp0native\\host.mjs"'), cmd);
  assert.equal(cmd.includes('Q:\\repo'), false, 'launcher carries no source checkout path');
  assert.ok(cmd.trimEnd().endsWith('%*'));
});

test('generated Windows launcher starts Node with stale NODE_OPTIONS cleared and other env preserved', async (t) => {
  if (process.platform !== 'win32') return t.skip('requires Windows cmd.exe');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'crp-host-cmd-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'native'), { recursive: true });
  const script = path.join(dir, 'native', 'host.mjs');
  const launcher = path.join(dir, 'host.cmd');
  await writeFile(script, 'console.log(JSON.stringify({ nodeOptions: process.env.NODE_OPTIONS ?? null, marker: process.env.HOST_TEST_MARKER, args: process.argv.slice(2) }));');
  await writeFile(launcher, buildHostCmd({ nodePath: process.execPath }));
  const output = execFileSync('cmd.exe', ['/d', '/c', launcher, 'argument'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '--require C:\\missing\\preload.cjs', HOST_TEST_MARKER: 'preserved' },
  });
  assert.deepEqual(JSON.parse(output), { nodeOptions: null, marker: 'preserved', args: ['argument'] });
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

test('installHost writes the payload, both files and registers all three browsers', async (t) => {
  const root = await tempDir(t);
  await writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({ manifest_version: 3, name: 'ext', version: '1.0.0', key: FIXTURE_KEY }),
    'utf8',
  );
  await seedPayload(root);
  const localAppData = await tempDir(t);
  const registry = fakeRegistry();

  const result = await installHost({ root, localAppData, exec: registry.exec });
  assert.equal(result.ok, true);
  assert.equal(result.extensionId, FIXTURE_ID);

  const paths = installPaths({ root, localAppData });
  assert.equal(existsSync(paths.cmd), true);
  assert.equal(existsSync(paths.manifest), true);
  for (const rel of PAYLOAD) {
    assert.equal(existsSync(payloadPath(paths.dir, rel)), true, `payload copied: ${rel}`);
  }

  const written = JSON.parse(await readFile(paths.manifest, 'utf8'));
  assert.equal(written.allowed_origins[0], `chrome-extension://${FIXTURE_ID}/`);
  assert.equal(written.path, paths.cmd);
  assert.equal(written.type, 'stdio');

  const cmd = await readFile(paths.cmd, 'utf8');
  assert.ok(cmd.includes(`"${process.execPath}"`));
  assert.ok(cmd.includes('"%~dp0native\\host.mjs"'), cmd);

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
  assert.equal(existsSync(path.join(localAppData, 'crunchy-presence')), false);
});

test('verifyHost fails when a registry default points somewhere else', async (t) => {
  const root = await tempDir(t);
  await writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({ manifest_version: 3, key: FIXTURE_KEY }),
    'utf8',
  );
  await seedPayload(root);
  const localAppData = await tempDir(t);
  const registry = fakeRegistry();
  await installHost({ root, localAppData, exec: registry.exec });
  const paths = installPaths({ root, localAppData });

  registry.state.value = 'C:\\somewhere\\else\\host-manifest.json';
  const checks = await verifyHost({ paths, extensionId: FIXTURE_ID, exec: registry.exec, root });
  const registryChecks = checks.filter((check) => check.name.endsWith('registry'));
  assert.equal(registryChecks.length, 3);
  assert.equal(registryChecks.every((check) => check.ok === false), true);
  assert.equal(checks.find((check) => check.name === 'host.cmd').ok, true);
});

test('installHost --check passes after a self-contained install', async (t) => {
  const root = await tempDir(t);
  await writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({ manifest_version: 3, key: FIXTURE_KEY }),
    'utf8',
  );
  await seedPayload(root);
  const localAppData = await tempDir(t);
  const registry = fakeRegistry();

  assert.equal((await installHost({ root, localAppData, exec: registry.exec })).ok, true);
  const checked = await installHost({ root, localAppData, exec: registry.exec, check: true });
  assert.equal(checked.ok, true, JSON.stringify(checked.checks.filter((check) => !check.ok)));
  assert.ok(checked.checks.some((check) => check.name === 'host.cmd self-contained' && check.ok));
  assert.equal(checked.checks.filter((check) => check.name.startsWith('payload ')).length, PAYLOAD.length);
});

test('installHost --check fails when a copied payload file is missing', async (t) => {
  const root = await tempDir(t);
  await writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({ manifest_version: 3, key: FIXTURE_KEY }),
    'utf8',
  );
  await seedPayload(root);
  const localAppData = await tempDir(t);
  const registry = fakeRegistry();

  assert.equal((await installHost({ root, localAppData, exec: registry.exec })).ok, true);
  const paths = installPaths({ root, localAppData });
  await rm(payloadPath(paths.dir, 'native/protocol.mjs'));

  const checked = await installHost({ root, localAppData, exec: registry.exec, check: true });
  assert.equal(checked.ok, false);
  const failed = checked.checks.filter((check) => !check.ok);
  assert.ok(failed.some((check) => check.name.includes('protocol.mjs')), JSON.stringify(failed));
});

test('installHost --check fails when the launcher names the source checkout', async (t) => {
  const root = await tempDir(t);
  await writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({ manifest_version: 3, key: FIXTURE_KEY }),
    'utf8',
  );
  await seedPayload(root);
  const localAppData = await tempDir(t);
  const registry = fakeRegistry();

  assert.equal((await installHost({ root, localAppData, exec: registry.exec })).ok, true);
  const paths = installPaths({ root, localAppData });
  await writeFile(
    paths.cmd,
    `@echo off\r\nset "NODE_OPTIONS="\r\n"${process.execPath}" "${payloadPath(root, 'native/host.mjs')}" %*\r\n`,
    'utf8',
  );

  const checked = await installHost({ root, localAppData, exec: registry.exec, check: true });
  assert.equal(checked.ok, false);
  assert.ok(
    checked.checks.some((check) => check.name === 'host.cmd self-contained' && !check.ok),
    JSON.stringify(checked.checks.filter((check) => !check.ok)),
  );
});

test('removeHost deletes the copied payload', async (t) => {
  const root = await tempDir(t);
  await writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({ manifest_version: 3, key: FIXTURE_KEY }),
    'utf8',
  );
  await seedPayload(root);
  const localAppData = await tempDir(t);
  const registry = fakeRegistry();

  assert.equal((await installHost({ root, localAppData, exec: registry.exec })).ok, true);
  const paths = installPaths({ root, localAppData });
  assert.equal(existsSync(payloadPath(paths.dir, 'native/host.mjs')), true);

  const removed = await removeHost({ root, localAppData, exec: registry.exec });
  assert.equal(removed.ok, true);
  for (const rel of PAYLOAD) {
    assert.equal(existsSync(payloadPath(paths.dir, rel)), false, `payload removed: ${rel}`);
  }
});

test('installed host runs after the source checkout is removed and the install dir is relocated', async (t) => {
  if (process.platform !== 'win32') return t.skip('requires Windows cmd.exe');
  const sourceRoot = await tempDir(t);
  await seedRealPayload(sourceRoot);
  const localAppData = await tempDir(t);
  const relocatedParent = await tempDir(t);
  const registry = fakeRegistry();

  assert.equal((await installHost({ root: sourceRoot, localAppData, exec: registry.exec })).ok, true);
  const paths = installPaths({ root: sourceRoot, localAppData });
  const cmd = await readFile(paths.cmd, 'utf8');
  assert.equal(cmd.includes(sourceRoot), false, `launcher must not name the source checkout: ${cmd}`);
  assert.ok(cmd.includes('"%~dp0native\\host.mjs"'), cmd);

  await rm(sourceRoot, { recursive: true, force: true });
  const movedDir = path.join(relocatedParent, INSTALL_DIR_NAME);
  await cp(paths.dir, movedDir, { recursive: true });

  const run = spawnSync('cmd.exe', ['/d', '/c', path.join(movedDir, 'host.cmd'), '--selftest'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '--require C:\\missing\\preload.cjs' },
  });
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
  assert.equal(run.stderr.includes('MODULE_TYPELESS'), false, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.ok, true, run.stdout);
  assert.ok(report.checks.length > 0, run.stdout);
  assert.deepEqual(JSON.parse(await readFile(path.join(movedDir, 'package.json'), 'utf8')), { type: 'module' });
});

test('--check verifies the module marker in the installed payload', async (t) => {
  const root = await tempDir(t);
  await writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({ manifest_version: 3, key: FIXTURE_KEY }),
    'utf8',
  );
  await seedPayload(root);
  const localAppData = await tempDir(t);
  const registry = fakeRegistry();

  assert.equal((await installHost({ root, localAppData, exec: registry.exec })).ok, true);
  const paths = installPaths({ root, localAppData });
  assert.deepEqual(JSON.parse(await readFile(path.join(paths.dir, 'package.json'), 'utf8')), { type: 'module' });

  await writeFile(path.join(paths.dir, 'package.json'), '{"type":"commonjs"}\n', 'utf8');
  const checked = await installHost({ root, localAppData, exec: registry.exec, check: true });
  assert.equal(checked.ok, false);
  assert.ok(checked.checks.some((check) => check.name === 'payload package.json' && !check.ok));
});

test('import guard names an imported payload file removed from the install dir', async (t) => {
  const sourceRoot = await tempDir(t);
  await seedRealPayload(sourceRoot);
  const localAppData = await tempDir(t);
  const registry = fakeRegistry();

  assert.equal((await installHost({ root: sourceRoot, localAppData, exec: registry.exec })).ok, true);
  const paths = installPaths({ root: sourceRoot, localAppData });
  await rm(payloadPath(paths.dir, 'native/protocol.mjs'));

  const checked = await installHost({ root: sourceRoot, localAppData, exec: registry.exec, check: true });
  assert.equal(checked.ok, false);
  assert.ok(
    checked.checks.some((check) => check.name === 'import native/host.mjs -> ./protocol.mjs' && !check.ok),
    JSON.stringify(checked.checks.filter((check) => !check.ok)),
  );
});

test('import guard rejects a new local import missing from the payload', async (t) => {
  const sourceRoot = await tempDir(t);
  await seedRealPayload(sourceRoot);
  const localAppData = await tempDir(t);
  const registry = fakeRegistry();

  assert.equal((await installHost({ root: sourceRoot, localAppData, exec: registry.exec })).ok, true);

  await writeFile(payloadPath(sourceRoot, 'native/extra.mjs'), 'export const extra = 1;\n', 'utf8');
  const hostPath = payloadPath(sourceRoot, 'native/host.mjs');
  await writeFile(hostPath, `${await readFile(hostPath, 'utf8')}\nimport './extra.mjs';\n`, 'utf8');

  const checked = await installHost({ root: sourceRoot, localAppData, exec: registry.exec, check: true });
  assert.equal(checked.ok, false);
  assert.ok(
    checked.checks.some((check) => check.name === 'import native/host.mjs -> ./extra.mjs' && !check.ok),
    JSON.stringify(checked.checks.filter((check) => !check.ok)),
  );
});
