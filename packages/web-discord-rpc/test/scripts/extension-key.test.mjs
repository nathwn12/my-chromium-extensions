import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  deriveIdFromManifest,
  ensureKey,
  extensionIdFromDer,
  extensionIdFromKey,
} from '../../scripts/extension-key.mjs';

/* Node 26 dropped execFile[util.promisify.custom], so promisify(execFile)
   resolves to a bare stdout string and `{ stdout }` destructures to undefined.
   Wrap the callback ourselves so the test sees the documented shape. */
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

// A real 2048-bit SPKI public key and the ID Chrome derives from it.
const FIXTURE_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxB0a4bZDIwpOqpLUZX/Ts/ZGLikMWY5mnBKK+8PJmeyiwVeMhokLqjLqHBR7QyywF+5bkuGuKyL7jwwgY9vD+DlxvLt5Qdt5GDNzdm/KeS1bw3yzIy1OTosUCSLhbk7zNgLIQAB8zjkqEuchyeUDTu5lmpqtbiPwK3VyYBwQGxfUdkuFHAqKWW8syX4ZUC4ejM980k+qTlHBsMuU8e6v0Rbl8ROQTLKesxKzsN9zQoTgIeWkRl6fakXTcaFoPbSqOc/nThEja5Ke9LUZIKY48LJQ6m/K3LbjXKczS2H5Jmo86sNwvJXut8y/dN8D3GfYum5B0X/pyBOxYkE37+DyzwIDAQAB';
const FIXTURE_ID = 'hhbjhcmpjldibcbeiogfnaohjnnmppgk';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wdr-key-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function tempManifest(t, manifest) {
  const dir = await tempDir(t);
  const file = path.join(dir, 'manifest.json');
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return file;
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

test('the shipped manifest key derives the pinned extension id', () => {
  const derived = deriveIdFromManifest(path.join(REPO_ROOT, 'manifest.json'));
  assert.equal(derived.ok, true);
  assert.equal(derived.id, 'mnmmfbjinpokfnendlbhbbdmfjidgikf');
});
