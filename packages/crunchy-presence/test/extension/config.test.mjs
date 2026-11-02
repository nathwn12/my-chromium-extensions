import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  DEFAULT_CLIENT_ID,
  HOST_NAME,
  clientIdToPersist,
  resolveClientId
} from "../../config.js";

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(here, "..", "..");
const OVERRIDE = "123456789012345678";

test("the built-in application ID is a real ID the native host accepts", () => {
  assert.equal(DEFAULT_CLIENT_ID, "1566530911514923188");
  assert.match(DEFAULT_CLIENT_ID, /^[0-9]{17,20}$/);
  // native/protocol.mjs validateClientId accepts 17-19 digits, so a 20-digit
  // built-in would be rejected at the handshake.
  assert.match(DEFAULT_CLIENT_ID, /^[0-9]{17,19}$/);
});

test("HOST_NAME is the native messaging host the installer registers", () => {
  assert.equal(HOST_NAME, "com.nathwn12.crunchyroll_presence");
});

test("resolveClientId falls back to the built-in for missing or malformed values", () => {
  for (const stored of [undefined, null, "", "   ", "abc", "1234", 123456789012345678]) {
    assert.equal(resolveClientId(stored), DEFAULT_CLIENT_ID, `stored=${String(stored)}`);
  }
});

test("resolveClientId keeps a valid stored override, trimmed", () => {
  assert.equal(resolveClientId(OVERRIDE), OVERRIDE);
  assert.equal(resolveClientId(` ${OVERRIDE} `), OVERRIDE);
  assert.equal(resolveClientId(DEFAULT_CLIENT_ID), DEFAULT_CLIENT_ID);
});

test("clientIdToPersist saves an override, clears for empty/built-in, rejects junk", () => {
  assert.equal(clientIdToPersist(""), null);
  assert.equal(clientIdToPersist("   "), null);
  assert.equal(clientIdToPersist(null), null);
  assert.equal(clientIdToPersist(DEFAULT_CLIENT_ID), null);
  assert.equal(clientIdToPersist(` ${DEFAULT_CLIENT_ID} `), null);
  assert.equal(clientIdToPersist(OVERRIDE), OVERRIDE);
  assert.equal(clientIdToPersist(` ${OVERRIDE} `), OVERRIDE);
  assert.equal(clientIdToPersist("abc"), undefined);
  assert.equal(clientIdToPersist("1234"), undefined);
});

test("pages and worker share the one copy of the ID rule", () => {
  for (const file of ["background.js", "options.js", "popup.js"]) {
    const source = readFileSync(join(extensionDir, file), "utf8");
    assert.match(source, /from "\.\/config\.js"/, `${file} imports config.js`);
    assert.ok(!/\[0-9\]\{17,20\}/.test(source), `${file} has no duplicate client-id regex`);
  }
});
