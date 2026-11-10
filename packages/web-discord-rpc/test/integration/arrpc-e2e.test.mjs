import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SCRIPT = fileURLToPath(new URL("../../scripts/e2e-arrpc.mjs", import.meta.url));

/**
 * Runs the real script rather than re-implementing it: the script owns the
 * WebSocket server, the spawned host, and the assertions that two sources
 * stack on two connections and that a clear reaches arRPC as a null activity.
 */
test("e2e-arrpc drives the native host over a real WebSocket", { timeout: 30_000 }, async () => {
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

  assert.equal(code, 0, `e2e-arrpc exited ${String(code)}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.match(
    stdout,
    /^PASS {2}e2e-arrpc: a real WebSocket server saw two connections, one per source, on the built-in client id$/m,
  );
  assert.match(
    stdout,
    /^PASS {2}e2e-arrpc: each source reached arRPC as its own Discord type \(3 and 2\) on its own connection$/m,
  );
  assert.match(
    stdout,
    /^PASS {2}e2e-arrpc: the clear reached arRPC as a null activity on the connection that published it$/m,
  );
  assert.match(stdout, /^e2e-arrpc: PASS \(\d+\/\d+\)$/m);
});
