import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const popupSource = readFileSync(join(here, "..", "..", "popup.js"), "utf8");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeEl() {
  return {
    textContent: "",
    dataset: {},
    hidden: false,
    checked: false,
    addEventListener() {},
    append() {},
  };
}

// Bridge pill renders a display label per state while data-state keeps the raw value.
test("popup maps every bridge state to a label and keeps raw data-state", async () => {
  assert.match(popupSource, /bridge\.dataset\.state = state/);

  let liveState = "unknown";
  let changedListener = null;
  const els = {};
  for (const id of ["bridge", "app", "app-override", "now", "detail", "buttons", "enabled", "open-options"]) {
    els[id] = fakeEl();
  }
  const toggleSpan = fakeEl();
  globalThis.document = {
    getElementById: (id) => els[id] ?? (els[id] = fakeEl()),
    querySelector: () => toggleSpan,
    createElement: () => fakeEl(),
  };
  globalThis.chrome = {
    runtime: {
      sendMessage: (_message, cb) => cb({ bridgeState: liveState, enabled: true }),
      lastError: undefined,
      openOptionsPage() {},
    },
    storage: {
      local: {
        get: async () => ({ enabled: true }),
        set: async () => {},
      },
      onChanged: {
        addListener: (fn) => {
          changedListener = fn;
        },
      },
    },
  };

  await import(pathToFileURL(join(here, "..", "..", "popup.js")).href);
  assert.ok(changedListener, "popup subscribes to storage changes");
  await tick();

  const cases = {
    unknown: "Not connected",
    connected: "Connected",
    connecting: "Connecting",
    disconnected: "Disconnected",
    error: "Error",
    idle: "Idle",
  };
  for (const [raw, label] of Object.entries(cases)) {
    liveState = raw;
    changedListener({ crpStatus: {} }, "local");
    await tick();
    await tick();
    assert.equal(els.bridge.textContent, label, `text for ${raw}`);
    assert.equal(els.bridge.dataset.state, raw, `data-state for ${raw}`);
  }

  liveState = "weird-state";
  changedListener({ crpStatus: {} }, "local");
  await tick();
  await tick();
  assert.equal(els.bridge.textContent, "Weird-state");
  assert.equal(els.bridge.dataset.state, "weird-state");
});
