#!/usr/bin/env node
/**
 * One job: make sure `manifest.json` has a stable extension key and
 * report the extension ID Chrome derives from it.
 *
 * Chrome maps the SHA-256 of the DER-encoded SPKI public key to an ID: the
 * first 16 bytes, one hex nibble per character, 0-f mapped to a-p.
 *
 *   node scripts/extension-key.mjs --print
 *   node scripts/extension-key.mjs --print --json
 *   node scripts/extension-key.mjs --print --manifest <path>
 */

import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_PATH = path.join(REPO_ROOT, 'manifest.json');

/** Chrome's alphabet: hex nibble -> a..p */
export function extensionIdFromDer(der) {
  const digest = createHash('sha256').update(der).digest();
  let id = '';
  for (let i = 0; i < 16; i += 1) {
    const byte = digest[i];
    id += String.fromCharCode(97 + (byte >> 4));
    id += String.fromCharCode(97 + (byte & 0x0f));
  }
  return id;
}

export function extensionIdFromKey(keyBase64) {
  if (typeof keyBase64 !== 'string' || keyBase64.trim().length === 0) {
    throw new Error('manifest key is empty');
  }
  const der = Buffer.from(keyBase64, 'base64');
  if (der.length === 0) throw new Error('manifest key is not valid base64');
  return extensionIdFromDer(der);
}

export function readManifest(manifestPath = MANIFEST_PATH) {
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

/** Pure read: `{ok, id, key, path}` or `{ok:false, error}`. */
export function deriveIdFromManifest(manifestPath = MANIFEST_PATH) {
  let manifest;
  try {
    manifest = readManifest(manifestPath);
  } catch (error) {
    return { ok: false, error: `cannot read ${manifestPath}: ${error.message}` };
  }
  if (typeof manifest.key !== 'string' || manifest.key.trim().length === 0) {
    return { ok: false, error: `manifest has no "key" field: ${manifestPath}` };
  }
  try {
    return { ok: true, id: extensionIdFromKey(manifest.key), key: manifest.key, path: manifestPath };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function createKeyPair() {
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });
  return publicKey.toString('base64');
}

/**
 * Read the manifest, adding a key only when it has none. Never overwrites an
 * existing key, so an installed extension keeps its ID.
 */
export function ensureKey(manifestPath = MANIFEST_PATH) {
  let manifest;
  try {
    manifest = readManifest(manifestPath);
  } catch (error) {
    return { ok: false, error: `cannot read ${manifestPath}: ${error.message}` };
  }
  if (typeof manifest.key === 'string' && manifest.key.trim().length > 0) {
    try {
      return {
        ok: true,
        id: extensionIdFromKey(manifest.key),
        key: manifest.key,
        created: false,
        path: manifestPath,
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  const key = createKeyPair();
  const next = { ...manifest, key };
  writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return { ok: true, id: extensionIdFromKey(key), key, created: true, path: manifestPath };
}

/* --------------------------------------------------------------------- cli */

function parseArgs(argv) {
  const options = { print: false, json: false, manifest: MANIFEST_PATH };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--print') options.print = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--manifest') options.manifest = path.resolve(argv[++i]);
    else if (arg.startsWith('--manifest=')) options.manifest = path.resolve(arg.slice('--manifest='.length));
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const USAGE = `usage: node scripts/extension-key.mjs [--print] [--json] [--manifest <path>]

Ensures manifest.json carries a key (generating an RSA-2048 keypair
once, never overwriting) and prints the Chrome extension ID.`;

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    return 1;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const result = ensureKey(options.manifest);
  if (!result.ok) {
    process.stderr.write(`${result.error}\n`);
    return 1;
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ id: result.id, key: result.key, created: result.created, path: result.path })}\n`,
    );
    return 0;
  }

  // The ID stands alone on its first line so it can be matched exactly.
  process.stdout.write(`${result.id}\nkey: ${result.key}\n`);
  process.stderr.write(
    `${result.created ? 'generated' : 'reused'} key in ${result.path}\n`,
  );
  return 0;
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
