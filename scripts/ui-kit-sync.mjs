#!/usr/bin/env node
// Dev tool, not a bundler and not a build step. Copies the two canonical
// stylesheets byte-for-byte into every package that already has a ui-kit dir.
// Usage: node scripts/ui-kit-sync.mjs [--root <dir>]

import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FILES = ["tokens.css", "components.css"];

function rootFrom(argv) {
  const i = argv.indexOf("--root");
  if (i >= 0) {
    if (!argv[i + 1]) {
      console.error("ui-kit-sync: --root needs a directory");
      process.exit(2);
    }
    return resolve(argv[i + 1]);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

const root = rootFrom(process.argv);
const kit = join(root, "packages", "ui-kit");

for (const file of FILES) {
  if (!existsSync(join(kit, file))) {
    console.error(`ui-kit-sync: missing canonical packages/ui-kit/${file}`);
    process.exit(1);
  }
}

const packagesDir = join(root, "packages");
let names = [];
try {
  names = readdirSync(packagesDir).sort();
} catch (error) {
  console.error(`ui-kit-sync: cannot read packages/: ${error.message}`);
  process.exit(1);
}

let written = 0;
for (const name of names) {
  const dir = join(packagesDir, name, "ui-kit");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
  for (const file of FILES) {
    copyFileSync(join(kit, file), join(dir, file));
    written += 1;
    console.log(`wrote packages/${name}/ui-kit/${file}`);
  }
  // switch.js was removed from canonical; a vendored leftover has no consumer.
  const stale = join(dir, "switch.js");
  if (existsSync(stale)) {
    rmSync(stale);
    console.log(`removed stale packages/${name}/ui-kit/switch.js`);
  }
}

console.log(`ui-kit-sync: ${written} file(s) written; vendored copies are committed static files, not build output`);
