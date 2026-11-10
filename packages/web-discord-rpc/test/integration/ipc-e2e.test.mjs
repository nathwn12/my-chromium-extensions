import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SCRIPT = fileURLToPath(new URL("../../scripts/e2e-ipc.mjs", import.meta.url));

/**
 * Runs the real script rather than re-implementing it: the script owns the
 * named-pipe scenario, the spawned host, and the assertions that a second
 * connection stacks a second activity.
 */
test("e2e-ipc drives the native host over a real named pipe", { timeout: 30_000 }, async (t) => {
  if (process.platform !== "win32") {
    t.skip("Discord desktop IPC on Windows is the tested transport");
    return;
  }

  const child = spawn(process.execPath, [SCRIPT], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const code = await new Promise((resolve) => child.once("exit", resolve));

  assert.equal(code, 0, `e2e-ipc exited ${String(code)}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.match(stdout, /^PASS {2}e2e-ipc: both sources ack over Discord IPC$/m);
  assert.match(stdout, /^PASS {2}e2e-ipc: a real named pipe saw two connections and two handshakes$/m);
  assert.match(stdout, /^e2e-ipc: PASS \(\d+\/\d+\)$/m);});
