import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

test("release workflow requires a product choice for manual runs", () => {
  assert.match(workflow, /workflow_dispatch:\s*\n\s+inputs:\s*\n\s+product:/);
  assert.match(workflow, /required:\s*true/);
});

test("release workflow builds and publishes only the selected product", () => {
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && inputs\.product \|\| github\.ref_name/);
  assert.match(workflow, /case "\$PRODUCT" in/);
  assert.match(workflow, /unzip -l "dist\/\$PRODUCT\.zip"/);
  assert.match(workflow, /publish "\$PRODUCT" "\$PRODUCT"/);
  assert.doesNotMatch(workflow, /publish audio-normalizer audio-normalizer/);
  assert.doesNotMatch(workflow, /publish slowed-reverb slowed-reverb/);
  assert.doesNotMatch(workflow, /publish crunchy-presence crunchy-presence/);
  assert.doesNotMatch(workflow, /publish web-discord-rpc web-discord-rpc/);
});
