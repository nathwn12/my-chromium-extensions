#!/usr/bin/env node
// Read-only corruption guard for JSON and YAML files. Parses each file, never writes.
// JSON: built-in JSON.parse (zero dependency). YAML: pinned "yaml" package.
// Usage: node scripts/check-yaml-json.mjs
// Exit 0 = every file parsed; 1 = at least one read/parse failure.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git']);
const SKIP_FILES = new Set(['bun.lock', 'bun.lockb']);
const EXTENSIONS = new Set(['.json', '.yaml', '.yml']);

const files = [];
const findings = [];
const add = (file, line, col, kind, message) => {
  findings.push({ file, line, col, kind, message });
};

function isSkippedFile(name) {
  return SKIP_FILES.has(name) || name.startsWith('package-lock.') || name === 'npm-shrinkwrap.json';
}

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    add(path.relative(ROOT, dir).split(path.sep).join('/'), 1, 1, 'read', error.message);
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full);
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && !isSkippedFile(entry.name)) {
      files.push(full);
    }
  }
}

function lineColFromOffset(text, offset) {
  const before = text.slice(0, Math.max(0, offset));
  const lines = before.split(/\r?\n/);
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

function checkJson(rel, text) {
  try {
    JSON.parse(text);
  } catch (error) {
    const match = /at position (\d+)/.exec(error.message);
    const { line, col } = lineColFromOffset(text, match ? Number(match[1]) : 0);
    add(rel, line, col, 'json', error.message);
  }
}

function checkYaml(rel, text) {
  let doc;
  try {
    doc = parseDocument(text);
  } catch (error) {
    add(rel, 1, 1, 'yaml', error.message);
    return;
  }
  for (const error of doc.errors) {
    const pos = Array.isArray(error.linePos) && error.linePos.length > 0 ? error.linePos[0] : null;
    add(rel, pos?.line ?? 1, pos?.col ?? 1, 'yaml', error.message);
  }
}

walk(ROOT);
for (const full of files) {
  const rel = path.relative(ROOT, full).split(path.sep).join('/');
  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch (error) {
    add(rel, 1, 1, 'read', error.message);
    continue;
  }
  if (rel.endsWith('.json')) checkJson(rel, text);
  else checkYaml(rel, text);
}

findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col);
if (findings.length === 0) {
  process.stdout.write(`check-yaml-json: OK - ${files.length} JSON/YAML files parsed\n`);
} else {
  for (const f of findings) {
    process.stdout.write(`${f.file}:${f.line}:${f.col} [${f.kind}] ${f.message}\n`);
  }
  process.stdout.write(`check-yaml-json: ${findings.length} parse error(s) in ${files.length} files\n`);
  process.exitCode = 1;
}
