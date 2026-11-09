import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const popupPath = pathToFileURL(join(here, "..", "..", "popup.js")).href;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let bootSeq = 0;

function fakeEl() {
  return {
    textContent: "",
    dataset: {},
    attrs: {},
    listeners: {},
    hidden: false,
    checked: false,
    disabled: false,
    addEventListener(name, fn) {
      this.listeners[name] = fn;
    },
    append() {},
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    removeAttribute(name) {
      delete this.attrs[name];
    },
    focus() {},
    select() {},
  };
}

/**
 * Load popup.js against a fake extension API. A query string gives every test
 * a fresh module instance, so the module-level element handles cannot leak.
 */
async function boot({ status = {}, enabled = true } = {}) {
  let live = { ...status, enabled };
  let changedListener = null;
  const writes = [];
  const messages = [];
  const els = {};
  for (const id of [
    "bridge",
    "app",
    "app-override",
    "now",
    "detail",
    "reason",
    "buttons",
    "enabled",
    "open-options",
  ]) {
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
      sendMessage: (message, cb) => {
        messages.push(message);
        if (message && message.kind === "crp-refresh") {
          live = { ...live, bridgeState: live.enabled === false ? live.bridgeState : "connecting" };
        }
        cb({ ...live });
      },
      lastError: undefined,
      openOptionsPage() {},
    },
    storage: {
      local: {
        get: async () => ({ enabled: live.enabled !== false }),
        set: async (values) => {
          writes.push(values);
          if (typeof values.enabled === "boolean") live = { ...live, enabled: values.enabled };
        },
      },
      onChanged: {
        addListener: (fn) => {
          changedListener = fn;
        },
      },
    },
  };

  bootSeq += 1;
  await import(`${popupPath}?case=${bootSeq}`);
  await tick();
  await tick();

  return {
    els,
    writes,
    messages,
    setLive(next) {
      live = { ...live, ...next };
      changedListener({ crpStatus: {} }, "local");
    },
    async press(checked) {
      els.enabled.checked = checked;
      await els.enabled.listeners.change();
      await tick();
      await tick();
    },
  };
}

test("popup maps every bridge state to a friendly label and keeps raw data-state", async () => {
  const { els, setLive } = await boot();

  const cases = {
    unknown: "Not connected",
    connected: "Connected",
    connecting: "Waiting",
    disconnected: "Waiting",
    waiting: "Waiting",
    unavailable: "Waiting",
    error: "Error",
    idle: "Idle",
  };
  for (const [raw, label] of Object.entries(cases)) {
    setLive({ bridgeState: raw });
    await tick();
    await tick();
    assert.equal(els.bridge.textContent, label, `text for ${raw}`);
    assert.equal(els.bridge.dataset.state, raw, `data-state for ${raw}`);
  }

  setLive({ bridgeState: "weird-state" });
  await tick();
  await tick();
  assert.equal(els.bridge.textContent, "Weird-state");
  assert.equal(els.bridge.dataset.state, "weird-state");
});

test("popup shows Waiting with friendly copy, never Error, while an episode is loaded", async () => {
  const { els } = await boot({
    status: {
      bridgeState: "waiting",
      availability: "unavailable",
      reason: "Discord is not running — presence paused, resumes automatically.",
      lastError: "no discord ipc pipe found",
      lastActivity: { details: "Frieren", state: "S1 E1" },
    },
  });

  assert.equal(els.bridge.textContent, "Waiting");
  assert.notEqual(els.bridge.textContent, "Error");
  assert.equal(els.bridge.dataset.tone, "waiting");
  assert.equal(els.now.textContent, "Frieren");
  assert.equal(els.detail.textContent, "S1 E1", "the activity line is untouched");
  assert.equal(els.reason.hidden, false);
  assert.match(els.reason.textContent, /Discord is not running/);
  assert.doesNotMatch(els.reason.textContent, /pipe|error/i);
  assert.equal(els.reason.attrs.role, "status");
  assert.equal(els.reason.attrs["aria-live"], "polite");
});

test("popup uses role=alert only for a true error and hides the reason when connected", async () => {
  const { els, setLive } = await boot({
    status: {
      bridgeState: "error",
      reason: "Discord rejected this application ID. Check the application ID in Settings.",
      lastError: "Invalid Client ID",
    },
  });
  assert.equal(els.bridge.textContent, "Error");
  assert.equal(els.reason.attrs.role, "alert");
  assert.match(els.reason.textContent, /rejected this application ID/);
  assert.doesNotMatch(els.reason.textContent, /Invalid Client ID/);

  setLive({ bridgeState: "connected", reason: null });
  await tick();
  await tick();
  assert.equal(els.bridge.textContent, "Connected");
  assert.equal(els.reason.hidden, true);
  assert.equal(els.reason.textContent, "");
});

test("popup turns presence off while Discord is absent and never disables the toggle", async () => {
  const { els, writes, messages, setLive, press } = await boot({
    status: {
      bridgeState: "waiting",
      reason: "Discord is not running — presence paused, resumes automatically.",
    },
  });

  assert.equal(els.enabled.checked, true);
  assert.equal(els.enabled.disabled, false, "the switch is always operable");

  await press(false);

  assert.deepEqual(writes.at(-1), { enabled: false });
  assert.ok(
    messages.some((message) => message && message.kind === "crp-refresh"),
    "the worker is asked to send the null clear"
  );
  assert.equal(els.bridge.textContent, "Off");
  assert.equal(els.enabled.disabled, false, "turn-off never strands the user");

  setLive({ enabled: false });
  await tick();
  await tick();
  assert.equal(els.bridge.textContent, "Off");
  assert.equal(els.now.textContent, "Presence off");
  assert.equal(els.reason.hidden, false);
  assert.match(els.reason.textContent, /Presence is off/);
});

test("popup optimistically shows Waiting when the user turns presence on", async () => {
  const { els, press } = await boot({ enabled: false, status: { bridgeState: "idle" } });
  assert.equal(els.bridge.textContent, "Off");

  await press(true);

  assert.equal(els.bridge.textContent, "Waiting");
  assert.equal(els.bridge.dataset.state, "connecting");
});
