/**
 * options.js against a minimal DOM.
 *
 * The Application ID field shows the stored override, never the effective
 * identity: on a fresh install the field is empty and the diagnostics report
 * `missing`, because presence already works with the built-in application and
 * the label says so. Filling the field with the built-in id would present a
 * setting the user never saved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(here, "..", "..");
const optionsPath = pathToFileURL(join(extensionDir, "options.js")).href;
const { DEFAULT_CLIENT_ID } = await import(
  pathToFileURL(join(extensionDir, "config.js")).href
);

const OVERRIDE = "123456789012345678";

// Every element options.js looks up at load, plus the form and its controls.
const ELEMENT_IDS = [
  "client-form",
  "clientId",
  "clientId-error",
  "bridgeState",
  "appName",
  "currentActivity",
  "lastError",
  "test",
  "test-result",
  "refresh",
  "synopsis",
  "diagnostics",
  "copy",
  "copy-result"
];

/** Yield to the event loop so a chained `await` in options.js can finish. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function makeElement(id) {
  const listeners = new Map();
  return {
    id,
    value: "",
    textContent: "",
    hidden: false,
    checked: false,
    disabled: false,
    dataset: {},
    attributes: {},
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    /** Fire a listener and hand back its return value (async handlers return a promise). */
    emit(type, event = {}) {
      const fn = listeners.get(type);
      if (!fn) throw new Error(`no ${type} listener on #${id}`);
      return fn(event);
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    focus() {},
    select() {}
  };
}

/** Chrome storage with real promise answers and change events. */
function makeChrome(initial = {}) {
  const local = { ...initial };
  const session = {};
  const listeners = [];
  const pick = (source, keys) => {
    const out = {};
    for (const key of [].concat(keys)) if (key in source) out[key] = source[key];
    return out;
  };
  const notify = (changes, area) => {
    if (!Object.keys(changes).length) return;
    for (const fn of listeners) fn(changes, area);
  };
  return {
    local,
    api: {
      storage: {
        local: {
          async get(keys) {
            return pick(local, keys);
          },
          async set(values) {
            const changes = {};
            for (const [key, value] of Object.entries(values)) {
              changes[key] = { oldValue: local[key], newValue: value };
              local[key] = value;
            }
            notify(changes, "local");
          },
          async remove(keys) {
            const changes = {};
            for (const key of [].concat(keys)) {
              if (!(key in local)) continue;
              changes[key] = { oldValue: local[key], newValue: undefined };
              delete local[key];
            }
            notify(changes, "local");
          }
        },
        session: {
          async get(keys) {
            return pick(session, keys);
          }
        },
        onChanged: {
          addListener(fn) {
            listeners.push(fn);
          }
        }
      },
      runtime: {
        lastError: undefined,
        sendMessage(_message, callback) {
          if (typeof callback === "function") callback(null);
        }
      }
    }
  };
}

let opened = 0;

/** Boot options.js in a fresh module instance over a fresh fake page. */
async function openOptions(initial = {}) {
  const chrome = makeChrome(initial);
  const elements = new Map(ELEMENT_IDS.map((id) => [id, makeElement(id)]));
  globalThis.chrome = chrome.api;
  globalThis.document = {
    getElementById: (id) => elements.get(id) || null,
    execCommand: () => false
  };
  // Node exposes `navigator` as a getter-only global; define it to stand in for
  // the page's clipboard surface.
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { async writeText() {} } },
    configurable: true
  });

  opened += 1;
  await import(`${optionsPath}?page=${opened}`);
  await settle();

  return {
    storage: chrome.local,
    el: (id) => elements.get(id),
    diagnostics() {
      return JSON.parse(elements.get("diagnostics").value);
    },
    /** What the diagnostics block reports for the stored override. */
    reportedClientId() {
      return this.diagnostics().status.clientId;
    },
    async submit(value) {
      elements.get("clientId").value = value;
      await elements.get("client-form").emit("submit", { preventDefault() {} });
      await settle();
    }
  };
}

test("a fresh install shows an empty override and reports the id missing", async () => {
  const page = await openOptions();

  assert.equal(page.el("clientId").value, "", "the field is empty, not the built-in id");
  assert.notEqual(page.el("clientId").value, DEFAULT_CLIENT_ID);
  assert.equal(page.reportedClientId(), "missing", "nothing is stored, so nothing is reported");
});

test("saving an override then clearing it restores the empty built-in state", async () => {
  const page = await openOptions();

  await page.submit(OVERRIDE);
  assert.equal(page.storage.clientId, OVERRIDE, "the override is persisted");
  assert.equal(page.el("clientId").value, OVERRIDE, "the field shows the saved override");
  assert.equal(page.reportedClientId(), "set");

  await page.submit("");
  assert.equal("clientId" in page.storage, false, "clearing removes the override");
  assert.equal(page.el("clientId").value, "", "the field returns to empty");
  assert.notEqual(page.el("clientId").value, DEFAULT_CLIENT_ID);
  assert.equal(page.reportedClientId(), "missing", "diagnostics admit no override is stored");
});
