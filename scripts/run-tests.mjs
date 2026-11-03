#!/usr/bin/env node
// Run node --test over every *.test.{js,mjs,cjs} file under the given dirs.
// Exits 1 when zero test files match, so CI can never pass with no tests.
// Usage: node scripts/run-tests.mjs <dir> [<dir>...]
// Windows and Linux safe: no shell globs, dirs resolved relative to the
// package that invokes the runner, files passed to node --test explicitly.
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const TEST_RE = /\.test\.(js|mjs|cjs)$/;

function collect(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    console.error(`run-tests: cannot read directory ${dir}: ${err.message}`);
    process.exit(1);
  }
  for (const entry of entries.sort()) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) collect(full, out);
    else if (st.isFile() && TEST_RE.test(entry)) out.push(full);
  }
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("usage: node scripts/run-tests.mjs <dir> [<dir>...]");
  process.exit(1);
}

const files = [];
for (const dir of dirs) collect(resolve(dir), files);

if (files.length === 0) {
  console.error(
    `run-tests: no test files (*.test.js, *.test.mjs, *.test.cjs) found under: ${dirs.join(", ")}`
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
