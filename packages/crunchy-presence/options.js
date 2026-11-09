/**
 * Options page controller. Plain ES module, no framework.
 */

import { clientIdToPersist, resolveClientId } from "./config.js";
import { presentStatus } from "./bridge-status.js";

const el = (id) => document.getElementById(id);

const clientForm = el("client-form");
const clientInput = el("clientId");
const clientError = el("clientId-error");
const bridgeState = el("bridgeState");
const appNameEl = el("appName");
const currentActivity = el("currentActivity");
const lastErrorEl = el("lastError");
const testButton = el("test");
const testResult = el("test-result");
const refreshButton = el("refresh");
const synopsisEl = el("synopsis");
const diagnostics = el("diagnostics");
const copyButton = el("copy");
const copyResult = el("copy-result");

let status = {
  bridgeState: "unknown",
  availability: "unknown",
  reason: null,
  reasonKind: null,
  appName: null,
  lastError: null,
  lastActivity: null,
  clientIdPresent: false,
  enabled: true
};
let lastExtract = null;

function ask(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        void chrome.runtime.lastError;
        resolve(response || null);
      });
    } catch {
      resolve(null);
    }
  });
}

function describeActivity(activity) {
  if (!activity) return "— (nothing playing)";
  const parts = [activity.details, activity.state].filter(Boolean);
  return parts.join(" — ") || "— (nothing playing)";
}

function render() {
  const state = status.bridgeState || "unknown";
  const view = presentStatus(status);
  bridgeState.textContent = view.label;
  bridgeState.dataset.state = state;
  bridgeState.dataset.tone =
    view.isError ? "error" : state === "connected" ? "connected" : view.state === "off" ? "off" : "waiting";
  appNameEl.textContent = status.appName || "—";
  currentActivity.textContent = describeActivity(status.lastActivity);
  // Same friendly vocabulary as the popup. The raw diagnostic stays in the
  // copyable diagnostics block below.
  lastErrorEl.textContent = view.reason || "—";
  diagnostics.value = JSON.stringify(
    {
      status: {
        bridgeState: status.bridgeState,
        availability: status.availability,
        reason: status.reason,
        reasonKind: status.reasonKind,
        appName: status.appName,
        // Raw detail is diagnostics only, never the status card.
        lastError: status.lastError,
        enabled: status.enabled,
        clientId: status.clientIdPresent ? "set" : "missing"
      },
      activity: status.lastActivity,
      lastExtract
    },
    null,
    2
  );
}

function showError(message) {
  if (!message) {
    clientError.hidden = true;
    clientError.textContent = "";
    clientInput.removeAttribute("aria-invalid");
    return;
  }
  clientError.hidden = false;
  clientError.textContent = message;
  clientInput.setAttribute("aria-invalid", "true");
}

async function load() {
  const stored = await chrome.storage.local.get(["clientId", "enabled", "synopsis"]);
  clientInput.value = resolveClientId(stored.clientId);
  status.enabled = stored.enabled !== false;
  synopsisEl.checked = stored.synopsis === true;
  status.clientIdPresent = true;

  const session = await chrome.storage.session.get(["crpStatus", "crpLastExtract"]);
  const local = await chrome.storage.local.get(["crpStatus"]);
  const saved = session.crpStatus || local.crpStatus;
  if (saved) status = { ...status, ...saved };
  if (session.crpLastExtract) lastExtract = session.crpLastExtract;

  const live = await ask({ kind: "crp-get-status" });
  if (live) status = { ...status, ...live };
  render();
}

clientForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const next = clientIdToPersist(clientInput.value);
  if (next === undefined) {
    showError("That does not look like a Discord application ID. It is 17 to 20 digits.");
    clientInput.focus();
    return;
  }
  showError("");
  try {
    if (next) await chrome.storage.local.set({ clientId: next });
    else await chrome.storage.local.remove("clientId");
    status.clientIdPresent = true;
    clientInput.value = resolveClientId(next);
    await ask({ kind: "crp-refresh" });
    testResult.textContent = next
      ? "Saved. Reconnecting to Discord with your application."
      : "Saved. Using the built-in Crunchyroll application.";
  } catch {
    showError("Could not save. Reload the extension and try again.");
  }
});

clientInput.addEventListener("input", () => {
  if (clientIdToPersist(clientInput.value) !== undefined) showError("");
});

testButton.addEventListener("click", async () => {
  testButton.disabled = true;
  testResult.textContent = "Sending…";
  try {
    const response = await ask({ kind: "crp-test-presence" });
    if (!response) {
      testResult.textContent = "No response from the extension worker. Reload the extension.";
    } else if (response.queued) {
      testResult.textContent = "Test activity queued for delivery to Discord.";
    } else {
      const view = presentStatus(response);
      const state = view.isError ? "blocked" : "waiting";
      testResult.textContent = `Test activity built, but presence is ${state}. ${
        view.reason || "It will send when Discord is reachable."
      }`;
    }
  } finally {
    testButton.disabled = false;
  }
});

synopsisEl.addEventListener("change", async () => {
  await chrome.storage.local.set({ synopsis: synopsisEl.checked });
});

refreshButton.addEventListener("click", load);

copyButton.addEventListener("click", async () => {
  const text = diagnostics.value;
  try {
    await navigator.clipboard.writeText(text);
    copyResult.textContent = "Copied.";
  } catch {
    diagnostics.focus();
    diagnostics.select();
    const ok = document.execCommand && document.execCommand("copy");
    copyResult.textContent = ok ? "Copied." : "Select the text above and copy it manually.";
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (changes.crpStatus) {
    const next = changes.crpStatus.newValue;
    if (next) status = { ...status, ...next };
    render();
  }
  if (changes.crpLastExtract && area === "session") {
    lastExtract = changes.crpLastExtract.newValue || null;
    render();
  }
  if (area === "local" && changes.clientId) {
    status.clientIdPresent = Boolean(resolveClientId(changes.clientId.newValue));
    render();
  }
});

load();
