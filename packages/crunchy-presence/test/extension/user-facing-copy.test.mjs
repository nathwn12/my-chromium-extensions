import { test } from "node:test";
import assert from "node:assert/strict";

const root = new URL("../../", import.meta.url);
const tick = () => new Promise((resolve) => setImmediate(resolve));
let sequence = 0;

async function workerStatus(missingHost) {
  let listener;
  let nativeMessage;
  const port = {
    onMessage: { addListener: (fn) => { nativeMessage = fn; }, removeListener() {} },
    onDisconnect: { addListener() {}, removeListener() {} },
    postMessage() {}, disconnect() {},
  };
  globalThis.chrome = {
    runtime: {
      connectNative() {
        if (missingHost) throw new Error("Specified native messaging host not found: ENOENT discord-ipc ProtocolError");
        return port;
      },
      onMessage: { addListener: (fn) => { listener = fn; } },
    },
    storage: {
      local: { get: async () => ({ enabled: true }), set: async () => {} },
      onChanged: { addListener() {} },
    },
  };
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0; // Prevent reconnect timers from launching external work.
  try {
    await import(`${new URL("background.js", root)}?copy=${++sequence}`);
    await tick();
    if (!missingHost) nativeMessage({ t: "status", state: "error", fatal: false, reason: "discord-closed", detail: "no discord ipc pipe found: ENOENT discord-ipc ProtocolError" });
    let status;
    listener({ kind: "crp-get-status" }, {}, (value) => { status = value; });
    return status;
  } finally {
    globalThis.setTimeout = realTimeout;
  }
}

async function render(surface, status) {
  const elements = {};
  const element = (id) => elements[id] ??= {
    textContent: "", value: "", dataset: {}, hidden: false,
    addEventListener() {}, setAttribute() {}, removeAttribute() {}, append() {},
  };
  globalThis.document = { getElementById: element, querySelector: () => element("toggle"), createElement: () => element("item") };
  globalThis.chrome = {
    runtime: { sendMessage: (_message, cb) => cb(status), openOptionsPage() {} },
    storage: {
      local: { get: async () => ({ enabled: true }), set: async () => {} },
      session: { get: async () => ({}) },
      onChanged: { addListener() {} },
    },
  };
  await import(`${new URL(`${surface}.js`, root)}?copy=${++sequence}`);
  await tick();
  await tick();
  return elements;
}

test("absence is friendly Waiting on both surfaces; actionable failures are Error", async () => {
  for (const [name, missingHost] of [["discord-closed", false], ["host-missing", true]]) {
    const status = await workerStatus(missingHost);
    for (const surface of ["popup", "options"]) {
      const el = await render(surface, status);
      const label = el[surface === "popup" ? "bridge" : "bridgeState"].textContent;
      const reason = el[surface === "popup" ? "reason" : "lastError"]?.textContent || "";
      assert.equal(label, "Waiting", `${name} ${surface} must not render Error`);
      assert.match(reason, /Discord|host/i, `${name} ${surface} explains the wait`);
      assert.doesNotMatch(`${label} ${reason} ${el.detail?.textContent || ""}`, /Error|discord-ipc|ENOENT|ProtocolError/i);
    }
  }
  for (const reason of ["Discord rejected this application ID. Check the application ID in Settings.", "Discord stopped responding. Restart Discord, then try again."]) {
    for (const surface of ["popup", "options"]) {
      const el = await render(surface, { enabled: true, bridgeState: "error", reason, lastError: "ProtocolError ENOENT discord-ipc" });
      assert.equal(el[surface === "popup" ? "bridge" : "bridgeState"].textContent, "Error");
      assert.equal(el[surface === "popup" ? "reason" : "lastError"].textContent, reason);
    }
  }
});
